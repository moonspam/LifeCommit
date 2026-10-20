import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { openInitialised } from "./sqliteTestDb";
import { processBatch, purgeRawEvents, RAW_RETENTION_MS } from "./processBatch";
import { loadDongs } from "./dong";
import { writeSetting, NOISE_FILTER_SETTING } from "./settings";
import { buildPeople } from "./people";
import { PeopleGraphView } from "../components/Stats/PeopleGraph";
import type { Commit } from "../types/commit";

type Row = Record<string, unknown>;

// the WebView serves the bundled LifeCommit+ boundaries at /dong.geojson (lib/dong.ts); serve the repo file the same way
globalThis.fetch = (async (url: string) => url === "/dong.geojson"
  ? { ok: true, json: async () => JSON.parse(readFileSync("android/app/src/full/assets/public/dong.geojson", "utf8")) }
  : { ok: false }) as unknown as typeof fetch;

async function main() {
  // the saved noise filter (read inside the batch's transaction) keeps an excluded app out, not only the built-in list
  const { d, adapter } = await openInitialised();
  await writeSetting(adapter, NOISE_FILTER_SETTING, "com.example.private");
  const ins = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES ('APP_USAGE', ?, ?, ?)");
  ins.run("com.example.private", JSON.stringify({ label: "Private" }), 1_791_000_000_000);
  ins.run("com.example.public", JSON.stringify({ label: "Public" }), 1_791_000_060_000);

  await processBatch(adapter as any);

  const commits = (d.prepare("SELECT app_package FROM commits WHERE app_package IS NOT NULL").all() as Row[]).map((r) => r.app_package);
  assert.ok(!commits.includes("com.example.private"), `filtered app became a commit: ${commits}`);
  assert.ok(commits.includes("com.example.public"), "control app is committed");
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE is_processed = 0").get() as Row).n, 0, "both events marked processed");

  // emulator sequence (full flavor): only an open-ended APP_USAGE commit is extended to the next event; a CALL keeps
  // its logged duration, SMS / PHOTO stay points
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    const T = 1_791_472_735_000;
    const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
    raw.run("APP_USAGE", "com.android.chrome", JSON.stringify({ label: "Chrome" }), T);
    raw.run("SMS", "com.android.mms", JSON.stringify({ phoneNumber: "01055550001", callType: "INCOMING", body: "hi" }), T + 9_000);
    raw.run("CALL", "com.android.dialer", JSON.stringify({ phoneNumber: "01055550002", callType: "INCOMING", durationSec: 5 }), T + 12_000);
    raw.run("PHOTO", "com.android.camera2", JSON.stringify({ photoUri: "content://x/1", fileName: "a.png" }), T + 28_000);
    raw.run("APP_USAGE", "com.android.settings", JSON.stringify({ label: "Settings" }), T + 40_000);
    await processBatch(adapter as any);
    const row = (type: string) => d.prepare("SELECT started_at s, ended_at e, duration_sec dur FROM commits WHERE event_type = ?").get(type) as Row;
    const chrome = d.prepare("SELECT started_at s, ended_at e FROM commits WHERE app_package = 'com.android.chrome'").get() as Row;
    assert.equal(Number(chrome.e) - Number(chrome.s), 9_000, "the app closes at the next event (the SMS)");
    assert.deepEqual({ ...row("CALL") }, { s: T + 12_000, e: T + 17_000, dur: 5 }, "the call keeps its logged 5 s");
    const sms = row("SMS"), photo = row("PHOTO");
    assert.ok(Number(sms.e) - Number(sms.s) <= 1_000 && Number(photo.e) - Number(photo.s) <= 1_000, `points stay points: ${JSON.stringify([sms, photo])}`);
  }

  // round 23 #2: two SMS from the same number 20 s apart in ONE batch merge exactly like in separate batches, no error;
  // the same for two photos inside the bundling window
  {
    const T = 1_791_472_735_000;
    const sms = (s: number, body: string) => ["SMS", "com.android.mms", JSON.stringify({ phoneNumber: "01055550001", callType: "INCOMING", body }), s] as const;
    const photo = (s: number, name: string) => ["PHOTO", "com.android.camera2", JSON.stringify({ photoUri: `content://x/${name}`, fileName: name }), s] as const;
    const run = async (batches: (readonly [string, string, string, number])[][]) => {
      const { d, adapter } = await openInitialised();
      await writeSetting(adapter, NOISE_FILTER_SETTING, "");
      const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
      for (const b of batches) { for (const e of b) raw.run(...e); await processBatch(adapter as any); }
      return {
        errors: (d.prepare("SELECT COUNT(*) n FROM raw_events WHERE error_message IS NOT NULL").get() as Row).n,
        commits: (d.prepare("SELECT event_type, subject, started_at, ended_at, squashed_events FROM commits ORDER BY started_at").all() as Row[]).map((r) => ({ ...r })),
      };
    };
    const smsOne = await run([[sms(T, "first"), sms(T + 20_000, "second")]]);
    const smsTwo = await run([[sms(T, "first")], [sms(T + 20_000, "second")]]);
    assert.equal(smsOne.errors, 0, "no error on the second SMS");
    assert.deepEqual(smsOne.commits, smsTwo.commits, "same result as separate batches");
    const photoOne = await run([[photo(T, "A.jpg"), photo(T + 60_000, "B.jpg")]]);
    const photoTwo = await run([[photo(T, "A.jpg")], [photo(T + 60_000, "B.jpg")]]);
    assert.equal(photoOne.errors, 0);
    assert.deepEqual(photoOne.commits, photoTwo.commits);
  }

  // round 23 #3: a 5 s dialer CALL, then dialer APP_USAGE 30 s later: the CALL stays 5 s and an APP_USAGE commit exists
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    const T = 1_791_472_735_000;
    const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
    raw.run("CALL", "com.android.dialer", JSON.stringify({ phoneNumber: "01055550002", callType: "INCOMING", durationSec: 5 }), T);
    raw.run("APP_USAGE", "com.android.dialer", JSON.stringify({ label: "Phone" }), T + 30_000);
    raw.run("APP_USAGE", "com.android.settings", JSON.stringify({ label: "Settings" }), T + 90_000);
    await processBatch(adapter as any);
    const call = d.prepare("SELECT started_at s, ended_at e, duration_sec dur FROM commits WHERE event_type = 'CALL'").get() as Row;
    assert.deepEqual({ ...call }, { s: T, e: T + 5_000, dur: 5 }, "the call is not extended by the same package's app use");
    assert.equal((d.prepare("SELECT COUNT(*) n FROM commits WHERE event_type = 'APP_USAGE' AND app_package = 'com.android.dialer'").get() as Row).n, 1, "the dialer use is its own commit");
  }

  // round 24: replies from different apps or to different messages are separate records, even with the same sender
  // and reply text; the very same reply within 60 s is still merged
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    const T = 1_791_472_735_000;
    const reply = (pkg: string, received: string, s: number) => ["REPLY", pkg, JSON.stringify({ sender: "Kim", receivedMsg: received, replyMsg: "yes" }), s] as const;
    const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
    raw.run(...reply("com.example.a", "lunch?", T));
    raw.run(...reply("com.example.b", "meeting?", T + 20_000)); // other app, other message
    raw.run(...reply("com.example.b", "dinner?", T + 30_000)); // same app, other message
    raw.run(...reply("com.example.b", "dinner?", T + 40_000)); // the same reply again: merged
    raw.run(...reply("com.example.c", "dinner?", T + 50_000)); // same message and reply, other app: separate
    await processBatch(adapter as any);
    const rows = (d.prepare("SELECT app_package, body FROM commits WHERE event_type = 'REPLY' ORDER BY started_at").all() as Row[])
      .map((r) => [r.app_package, JSON.parse(String(r.body)).receivedMsg]);
    assert.deepEqual(rows, [["com.example.a", "lunch?"], ["com.example.b", "meeting?"], ["com.example.b", "dinner?"], ["com.example.c", "dinner?"]]);
  }

  // phone (LifeCommit+): Google -> dialer -> call -> Google within 2 min: Google is NOT extended over the dialer's time
  // (that time would count twice); with only a non-app event in between (a reply), the same app still continues
  {
    const T = 1_791_511_931_000;
    const usage = (pkg: string, s: number) => ["APP_USAGE", pkg, JSON.stringify({ label: pkg }), s] as const;
    const run = async (events: (readonly [string, string, string, number])[]) => {
      const { d, adapter } = await openInitialised();
      await writeSetting(adapter, NOISE_FILTER_SETTING, "");
      const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
      for (const e of events) raw.run(...e);
      await processBatch(adapter as any);
      return (d.prepare("SELECT event_type, app_package, started_at, ended_at FROM commits ORDER BY started_at").all() as Row[]).map((r) => ({ ...r }));
    };
    const a = await run([usage("com.google.search", T), usage("com.google.search", T + 9_000), usage("com.skt.dialer", T + 10_000),
      ["CALL", "com.android.dialer", JSON.stringify({ phoneNumber: "010", callType: "OUTGOING", durationSec: 0 }), T + 11_000], usage("com.google.search", T + 21_000),
      usage("com.android.settings", T + 40_000)]);
    const google = a.filter((r) => r.app_package === "com.google.search");
    assert.equal(google.length, 2, "a new Google commit after the dialer");
    assert.equal(google[0].ended_at, T + 10_000, "the first Google commit ends when the dialer starts");
    const b = await run([usage("com.example.chat", T), ["REPLY", "com.example.chat", JSON.stringify({ sender: "Kim", receivedMsg: "hi", replyMsg: "yo" }), T + 5_000],
      usage("com.example.chat", T + 20_000), usage("com.android.settings", T + 60_000)]);
    assert.equal(b.filter((r) => r.event_type === "APP_USAGE" && r.app_package === "com.example.chat").length, 1, "a reply in between keeps one chat commit");
  }

  // UsageStats sessions (us:) belong to the usage drain: a drain-inserted row that starts after the raw events must not
  // become the "last commit" - not extended by a call, not breaking a location dwell - in one batch or event by event
  {
    const T = 1_791_600_000_000;
    const US = { id: "us:com.example.app:" + (T + 30_000), s: T + 30_000, e: T + 200_000 };
    const loc = (t: number) => ["LOCATION", "system.location", JSON.stringify({ lat: 37.5, lng: 127.0, accuracy: 10 }), t] as const;
    const events = [loc(T), loc(T + 180_000), ["CALL", "com.android.dialer", JSON.stringify({ phoneNumber: "010", callType: "OUTGOING", durationSec: 20 }), T + 240_000] as const];
    const run = async (batches: number[][]) => {
      const { d, adapter } = await openInitialised();
      await writeSetting(adapter, NOISE_FILTER_SETTING, "");
      d.prepare(`INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at)
        VALUES (?, 1, 'feat: app', ?, ?, 170, 'com.example.app', 'APP_USAGE', ?)`).run(US.id, US.s, US.e, US.s);
      const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
      for (const b of batches) { for (const i of b) raw.run(...events[i]); await processBatch(adapter as any); }
      return (d.prepare("SELECT id LIKE 'us:%' AS us, event_type, started_at, ended_at, duration_sec FROM commits ORDER BY started_at, event_type").all() as Row[]).map((r) => ({ ...r }));
    };
    const one = await run([[0, 1, 2]]);
    assert.deepEqual(await run([[0], [1], [2]]), one, "event by event = one batch");
    assert.deepEqual(one.find((r) => r.us), { us: 1, event_type: "APP_USAGE", started_at: US.s, ended_at: US.e, duration_sec: 170 }, "the us: row is untouched");
    const locs = one.filter((r) => r.event_type === "LOCATION");
    assert.equal(locs.length, 1, "the second fix extends the dwell");
    assert.equal(locs[0].ended_at, T + 180_000);
  }

  // a gap longer than LOCATION_GAP_MS (phone off, accessibility off) ends a dwell: the same place afterwards is a new
  // commit, not one dwell stretched over the outage - in one batch and event by event
  {
    const T = 1_791_700_000_000, M = 60_000;
    const loc = (t: number) => ["LOCATION", "system.location", JSON.stringify({ lat: 37.5, lng: 127.0, accuracy: 10 }), t] as const;
    const events = [loc(T), loc(T + 3 * M), loc(T + 63 * M), loc(T + 66 * M)];
    const run = async (batches: number[][]) => {
      const { d, adapter } = await openInitialised();
      await writeSetting(adapter, NOISE_FILTER_SETTING, "");
      const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)");
      for (const b of batches) { for (const i of b) raw.run(...events[i]); await processBatch(adapter as any); }
      return (d.prepare("SELECT started_at, ended_at FROM commits WHERE event_type = 'LOCATION' ORDER BY started_at").all() as Row[]).map((r) => ({ ...r }));
    };
    const one = await run([[0, 1, 2, 3]]);
    assert.deepEqual(one, [{ started_at: T, ended_at: T + 3 * M }, { started_at: T + 63 * M, ended_at: T + 66 * M }], "two dwells around the 60-min outage");
    assert.deepEqual(await run([[0], [1], [2], [3]]), one, "event by event = one batch");
  }

  // a location commit outside registered places is titled by its dong (offline); coordinates stay in the body
  {
    await loadDongs(); // lib/processor.ts does this before the transaction; inside it the lookup is synchronous
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)")
      .run("LOCATION", "system.location", JSON.stringify({ lat: 35.1151, lng: 129.0422, accuracy: 10 }), 1_791_800_000_000); // Busan Station (no seeded geofence)
    await processBatch(adapter as any);
    const c = d.prepare("SELECT subject, body FROM commits WHERE event_type = 'LOCATION'").get() as Row;
    assert.equal(c.subject, "gps: 부산광역시 동구 초량3동 도착 및 머무름");
    assert.deepEqual(JSON.parse(c.body as string), { lat: 35.1151, lng: 129.0422, accuracy: 10 });
  }

  // round 32 #8: processed raw events (SMS bodies, replies, coordinates) leave the app DB 7 days after processing; the
  // latest row per type stays as the sync cursor (CALL/SMS/PHOTO resume from MAX(started_at)) with its content redacted
  {
    const { d, adapter } = await openInitialised();
    const NOW = 1_792_000_000_000, OLD = NOW - RAW_RETENTION_MS - 1, RECENT = NOW - 24 * 3600_000;
    const ins = d.prepare("INSERT INTO raw_events (id, event_type, app_package, raw_data, started_at, is_processed, processed_at) VALUES (?, ?, 'p', ?, ?, ?, ?)");
    ins.run(1, "CALL", '{"phoneNumber":"010-1"}', 100, 1, OLD);  // old, not the latest call -> deleted
    ins.run(2, "CALL", '{"phoneNumber":"010-2"}', 200, 1, OLD);  // latest call: cursor marker -> kept, redacted
    ins.run(3, "SMS", '{"body":"recent"}', 300, 1, RECENT);       // processed a day ago -> untouched
    ins.run(4, "SMS", '{"body":"old"}', 50, 1, OLD);              // old, not the latest SMS -> deleted
    ins.run(5, "PHOTO", '{"uri":"x"}', 400, 0, null);             // not processed yet -> untouched
    const cursors = () => d.prepare("SELECT event_type, MAX(started_at) AS m FROM raw_events GROUP BY event_type ORDER BY event_type").all().map((r: unknown) => ({ ...(r as Row) }));
    const before = cursors();
    await purgeRawEvents(adapter as any, NOW);
    assert.deepEqual(cursors(), before, "sync cursors unchanged");
    assert.deepEqual((d.prepare("SELECT id, raw_data FROM raw_events ORDER BY id").all() as Row[]).map((r) => ({ ...r })),
      [{ id: 2, raw_data: "{}" }, { id: 3, raw_data: '{"body":"recent"}' }, { id: 5, raw_data: '{"uri":"x"}' }]);
    // a redacted LOCATION marker as "latest location" gives a null context, not undefined binds
    d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at, is_processed, processed_at) VALUES ('LOCATION', 'system.location', '{}', 500, 1, ?)").run(OLD);
    d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES ('CALL', 'com.android.dialer', ?, 600)").run(JSON.stringify({ phoneNumber: "010", callType: "OUTGOING", durationSec: 5 }));
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    await processBatch(adapter as any);
    assert.deepEqual({ ...(d.prepare("SELECT lat, lng, error_message FROM commits c JOIN raw_events r ON r.started_at = c.started_at WHERE c.event_type = 'CALL'").get() as Row) }, { lat: null, lng: null, error_message: null });
  }

  // round 33: the purge also runs when no new raw event arrived (an old SMS, then nothing for 8 days)
  {
    const { d, adapter } = await openInitialised();
    d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at, is_processed, processed_at) VALUES ('SMS', 'com.android.mms', '{\"body\":\"secret\"}', 100, 1, ?)").run(Date.now() - RAW_RETENTION_MS - 60_000);
    assert.equal(await processBatch(adapter as any), 0, "nothing to process");
    assert.equal((d.prepare("SELECT raw_data FROM raw_events WHERE event_type = 'SMS'").get() as Row).raw_data, "{}", "content gone (kept only as the SMS cursor)");
  }
  // SMS commits count conversations, not individual messages: ten close messages make one conversation, two spaced
  // messages make two. The people UI must label this count honestly.
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");
    const T = 1_791_900_000_000;
    const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES ('SMS', 'com.example.sms', ?, ?)");
    for (let i = 0; i < 10; i++) raw.run(JSON.stringify({ phoneNumber: "01000000011", contactName: "Person A", body: `a${i}` }), T + i * 20_000);
    for (let i = 0; i < 2; i++) raw.run(JSON.stringify({ phoneNumber: "01000000022", contactName: "Person B", body: `b${i}` }), T + (20 + i * 10) * 60_000);
    await processBatch(adapter as any);
    const rows = d.prepare("SELECT id, body, started_at AS startedAt, event_type AS eventType FROM commits WHERE event_type = 'SMS'").all() as Commit[];
    const people = buildPeople(rows, T + 40 * 60_000);
    assert.deepEqual(people.map((p) => [p.name, p.sms]).sort(), [["Person A", 1], ["Person B", 2]]);
    const ui = renderToStaticMarkup(createElement(PeopleGraphView, { people, withUnsaved: false, selectedKey: undefined,
      periodLabel: "test", onSelect: () => {}, onToggle: () => {} }));
    assert.ok(ui.includes("문자 대화 1") && ui.includes("문자 대화 2"), "the list says conversations rather than messages");
    assert.ok(ui.includes("짧은 간격의 문자는 한 대화로 묶여 셉니다"), "the explanation states the grouping rule");
  }

  // TAG-KEY-3 P1: SMS 병합 시 이름 기반 병합 금지 및 정규화 전화번호 일치 검증
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "");

    // contact_tags 등록: 같은 이름("동명이인"), 다른 번호 A, B 각각 다른 태그
    d.prepare("INSERT INTO contact_tags (contact_key, contact_name, tag, phone_number) VALUES (?, ?, ?, ?)").run(
      "tel:01011110001", "동명이인", "#alpha", "010-1111-0001"
    );
    d.prepare("INSERT INTO contact_tags (contact_key, contact_name, tag, phone_number) VALUES (?, ?, ?, ?)").run(
      "tel:01022220002", "동명이인", "#beta", "010-2222-0002"
    );

    const T = 1_792_000_000_000;
    const raw = d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES ('SMS', 'com.android.mms', ?, ?)");

    // 1) 같은 이름 다른 번호 A(#alpha)와 B(#beta)가 1분 간격으로 SMS 수신
    raw.run(JSON.stringify({ phoneNumber: "010-1111-0001", contactName: "동명이인", body: "A의 문자" }), T);
    raw.run(JSON.stringify({ phoneNumber: "010-2222-0002", contactName: "동명이인", body: "B의 문자" }), T + 60_000);

    await processBatch(adapter as any);

    const smsCommits = d.prepare("SELECT body, author_tag FROM commits WHERE event_type = 'SMS' ORDER BY started_at").all() as { body: string; author_tag: string }[];
    assert.equal(smsCommits.length, 2, "동명이인 1분 간격 SMS는 병합되지 않고 2개의 커밋으로 남아야 함");
    const parsedA = JSON.parse(smsCommits[0].body);
    const parsedB = JSON.parse(smsCommits[1].body);
    assert.equal(parsedA.phoneNumber, "010-1111-0001", "첫 커밋은 A 번호");
    assert.equal(smsCommits[0].author_tag, "#alpha", "첫 커밋은 #alpha 태그");
    assert.equal(parsedB.phoneNumber, "010-2222-0002", "두 번째 커밋은 B 번호");
    assert.equal(smsCommits[1].author_tag, "#beta", "두 번째 커밋은 #beta 태그");

    // 2) 같은 번호 표기 차이 ('010-1111-0001' / '01011110001') -> 1개로 정상 병합
    raw.run(JSON.stringify({ phoneNumber: "010-1111-0001", contactName: "동명이인", body: "동일인 1차" }), T + 200_000);
    raw.run(JSON.stringify({ phoneNumber: "01011110001", contactName: "동명이인", body: "동일인 2차" }), T + 240_000);

    await processBatch(adapter as any);

    const mergedSms = (d.prepare("SELECT body, author_tag, started_at FROM commits WHERE event_type = 'SMS' AND started_at >= ? ORDER BY started_at").all(T + 200_000) as unknown as Row[]).map((r) => ({ ...r })) as { body: string; author_tag: string }[];
    assert.equal(mergedSms.length, 1, "동일 번호 표기 차이는 1개의 커밋으로 병합되어야 함");
    assert.equal(mergedSms[0].author_tag, "#alpha", "병합 커밋의 태그 보존");
  }

  console.log("process batch checks passed");
}
main();
