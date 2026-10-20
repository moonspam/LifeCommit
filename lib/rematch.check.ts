import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openInitialised } from "./sqliteTestDb";
import { rematchPlaces, rematchPlacesOnce, PLACE_REMATCH_SETTING } from "./rematch";
import { processBatch } from "./processBatch";
import { collectBackup, restoreBackup } from "./backupTables";
import { loadDongs } from "./dong";
import { writeSetting, NOISE_FILTER_SETTING } from "./settings";

type Row = Record<string, unknown>;

// 앱처럼 번들 행정동 경계를 /dong.geojson 으로 제공
globalThis.fetch = (async (url: string) => url === "/dong.geojson"
  ? { ok: true, json: async () => JSON.parse(readFileSync("android/app/src/full/assets/public/dong.geojson", "utf8")) }
  : { ok: false }) as unknown as typeof fetch;

const T = 1_791_000_000_000;
// 가짜 좌표: 장소 P / Q 는 서로 멀고, 서울 중구(행정동 있음) 안에 둔다
const P = { lat: 37.5665, lng: 126.978 };
const Q = { lat: 37.5800, lng: 126.9900 };
const FAR = { lat: 37.5300, lng: 127.0500 };

async function fresh() {
  const r = await openInitialised();
  r.d.exec("DELETE FROM geofences"); // 스키마 시드 장소 제거
  return r;
}
const gf = (r: Awaited<ReturnType<typeof fresh>>, name: string, c: { lat: number; lng: number }, radius = 150) =>
  Number(r.d.prepare("INSERT INTO geofences (name, lat, lng, radius_m) VALUES (?, ?, ?, ?)").run(name, c.lat, c.lng, radius).lastInsertRowid);
const loc = (r: Awaited<ReturnType<typeof fresh>>, id: string, c: { lat: number; lng: number } | null, subject: string, name: string | null = null, asBody = false) =>
  r.d.prepare("INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, event_type, geofence_name, lat, lng, created_at) VALUES (?, 2, ?, ?, ?, ?, 1, 'LOCATION', ?, ?, ?, 1)")
    .run(id, subject, c ? JSON.stringify(c) : null, T, T, name, asBody || !c ? null : c.lat, asBody || !c ? null : c.lng);
const row = (r: Awaited<ReturnType<typeof fresh>>, id: string) => ({ ...(r.d.prepare("SELECT subject, geofence_name FROM commits WHERE id = ?").get(id) as Row) });
const fts = (r: Awaited<ReturnType<typeof fresh>>, term: string) =>
  (r.d.prepare("SELECT id FROM commits_fts WHERE commits_fts MATCH ? ORDER BY id").all(`"${term}"`) as Row[]).map((x) => x.id);
// 앱의 executeInTransaction 과 같은 모양: 하나의 트랜잭션, 실패하면 전부 롤백
async function tx<T>(r: Awaited<ReturnType<typeof fresh>>, fn: () => Promise<T>): Promise<T> {
  r.d.exec("BEGIN");
  try { const v = await fn(); r.d.exec("COMMIT"); return v; } catch (e) { r.d.exec("ROLLBACK"); throw e; }
}

async function main() {
  await loadDongs();

  // 1. 추가 → 이름·자동 제목·FTS, 사용자가 고친 제목은 그대로, 좌표 없는 행·body 좌표만 있는 행
  {
    const r = await fresh();
    loc(r, "auto", P, "gps: 서울특별시 중구 명동 도착 및 머무름"); // 장소 없을 때 행정동으로 자동 생성된 제목
    loc(r, "coordAuto", FAR, `gps: 위치(${FAR.lat.toFixed(4)}, ${FAR.lng.toFixed(4)}) 도착 및 머무름`);
    loc(r, "user", P, "내가 고친 제목");
    loc(r, "bodyOnly", P, "gps: 서울특별시 중구 명동 도착 및 머무름", null, true);
    loc(r, "noCoord", null, "gps: 서울특별시 중구 명동 도착 및 머무름");
    r.d.prepare("UPDATE commits SET geofence_name = '옛장소' WHERE id = 'noCoord'").run();
    const id = gf(r, "카페A", P);
    assert.deepEqual(await rematchPlaces(r.adapter as never), { changed: 3, incomplete: 0 }, "좌표 있는 3개 중 장소에 들어온 3개만 바뀜(FAR 제외 → auto,user,bodyOnly)");
    assert.deepEqual(row(r, "auto"), { subject: "gps: 카페A 도착 및 머무름", geofence_name: "카페A" });
    assert.deepEqual(row(r, "bodyOnly"), { subject: "gps: 카페A 도착 및 머무름", geofence_name: "카페A" });
    assert.deepEqual(row(r, "user"), { subject: "내가 고친 제목", geofence_name: "카페A" }, "고친 제목 유지");
    assert.deepEqual(row(r, "coordAuto"), { subject: `gps: 위치(${FAR.lat.toFixed(4)}, ${FAR.lng.toFixed(4)}) 도착 및 머무름`, geofence_name: null });
    assert.equal(row(r, "noCoord").geofence_name, "옛장소", "좌표 없는 행은 건드리지 않음");
    assert.deepEqual(fts(r, "카페A"), ["auto", "bodyOnly", "user"], "FTS가 새 이름으로 잡힘");
    assert.deepEqual(await rematchPlaces(r.adapter as never), { changed: 0, incomplete: 0 }, "두 번째는 바뀐 행 없음");

    // 2. 이름 수정 → 옛 이름은 FTS에서 사라짐
    r.d.prepare("UPDATE geofences SET name = '카페B' WHERE id = ?").run(id);
    await rematchPlaces(r.adapter as never);
    assert.deepEqual(fts(r, "카페A"), [], "옛 이름으로 안 잡힘");
    assert.deepEqual(fts(r, "카페B"), ["auto", "bodyOnly", "user"]);
    assert.equal(row(r, "auto").subject, "gps: 카페B 도착 및 머무름");

    // 3. 좌표 수정(장소가 멀어짐) → 행정동 제목으로 복귀
    r.d.prepare("UPDATE geofences SET lat = ?, lng = ? WHERE id = ?").run(FAR.lat, FAR.lng, id);
    await rematchPlaces(r.adapter as never);
    assert.deepEqual(row(r, "auto"), { subject: "gps: 서울특별시 중구 명동 도착 및 머무름", geofence_name: null });
    assert.equal(row(r, "user").geofence_name, null);
    assert.equal(row(r, "coordAuto").geofence_name, "카페B", "반대로 FAR 는 새 장소에 들어옴");
    assert.equal(row(r, "coordAuto").subject, "gps: 카페B 도착 및 머무름");

    // 4. 반경 수정
    r.d.prepare("UPDATE geofences SET lat = ?, lng = ?, radius_m = 10 WHERE id = ?").run(P.lat + 0.0005, P.lng, id); // 약 55m 떨어짐
    await rematchPlaces(r.adapter as never);
    assert.equal(row(r, "auto").geofence_name, null, "반경 10m 밖");
    r.d.prepare("UPDATE geofences SET radius_m = 100 WHERE id = ?").run(id);
    await rematchPlaces(r.adapter as never);
    assert.equal(row(r, "auto").geofence_name, "카페B", "반경 100m 안");

    // 5. 삭제 → 이름 null, 자동 제목은 행정동, 고친 제목 유지, FTS 갱신
    r.d.prepare("DELETE FROM geofences WHERE id = ?").run(id);
    await rematchPlaces(r.adapter as never);
    assert.deepEqual(row(r, "auto"), { subject: "gps: 서울특별시 중구 명동 도착 및 머무름", geofence_name: null });
    assert.deepEqual(row(r, "user"), { subject: "내가 고친 제목", geofence_name: null });
    assert.deepEqual(fts(r, "카페B"), []);
  }

  // 5b. 다른 이벤트 제목의 " @ <장소>" 꼬리(앱 사용·통화·문자·사진만): 이름 변경·삭제, FTS는 새 이름만.
  //     자동 제목인지 확실하지 않으면 제목은 건드리지 않는다(geofence_name 만 갱신).
  {
    const r = await fresh();
    const ev = (id: string, type: string, subject: string, name: string | null) =>
      r.d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, geofence_name, lat, lng, created_at) VALUES (?, 1, ?, ?, ?, 1, ?, ?, ?, ?, 1)")
        .run(id, subject, T, T, type, name, P.lat, P.lng);
    const subj = (id: string) => row(r, id).subject;
    ev("app", "APP_USAGE", "feat: 크롬 사용 @ 꼬리A", "꼬리A");
    ev("call", "CALL", "call: 박준호 발신 통화 (1분 0초) @ 꼬리A", "꼬리A");
    ev("edited", "APP_USAGE", "내가 꼬리 없이 고친 제목", "꼬리A");
    ev("manual", "manual", "회의 @ 꼬리A", "꼬리A");
    ev("reply", "REPLY", "reply: [Jiho] \"만나자\" @ 꼬리A", "꼬리A");
    ev("merge", "MERGE", "merge: x @ 꼬리A", "꼬리A");
    ev("mine", "CALL", "내가 쓴 제목", null); // geofence_name 없음: 장소가 생겨도 제목은 그대로
    const id = gf(r, "꼬리A", P);
    assert.deepEqual(await rematchPlaces(r.adapter as never), { changed: 1, incomplete: 0 }, "새 장소: mine 의 geofence_name 만 채워짐");
    assert.deepEqual(row(r, "mine"), { subject: "내가 쓴 제목", geofence_name: "꼬리A" }, "꼬리를 덧붙이지 않음");
    r.d.prepare("UPDATE geofences SET name = '꼬리B' WHERE id = ?").run(id); // 이름 변경
    await rematchPlaces(r.adapter as never);
    assert.equal(subj("app"), "feat: 크롬 사용 @ 꼬리B");
    assert.equal(subj("call"), "call: 박준호 발신 통화 (1분 0초) @ 꼬리B");
    assert.equal(subj("edited"), "내가 꼬리 없이 고친 제목");
    assert.equal(subj("manual"), "회의 @ 꼬리A", "manual 제목은 변경하지 않음");
    assert.equal(subj("reply"), "reply: [Jiho] \"만나자\" @ 꼬리A", "REPLY 제목은 변경하지 않음");
    assert.equal(subj("merge"), "merge: x @ 꼬리A");
    assert.equal(subj("mine"), "내가 쓴 제목");
    assert.equal(row(r, "manual").geofence_name, "꼬리B", "geofence_name 은 갱신");
    assert.deepEqual(fts(r, "꼬리B").sort(), ["app", "call", "edited", "manual", "merge", "mine", "reply"]);
    r.d.prepare("DELETE FROM geofences WHERE id = ?").run(id); // 삭제
    await rematchPlaces(r.adapter as never);
    assert.equal(subj("app"), "feat: 크롬 사용");
    assert.equal(subj("call"), "call: 박준호 발신 통화 (1분 0초)");
    assert.equal(subj("manual"), "회의 @ 꼬리A");
    assert.equal(row(r, "manual").geofence_name, null);
  }

  // 6. 재판정 중 실패 → 장소 변경까지 롤백
  {
    const r = await fresh();
    loc(r, "x", P, "gps: 서울특별시 중구 명동 도착 및 머무름");
    r.d.exec("CREATE TRIGGER boom BEFORE UPDATE ON commits BEGIN SELECT RAISE(ABORT, 'boom'); END");
    await assert.rejects(tx(r, async () => {
      r.d.prepare("INSERT INTO geofences (name, lat, lng, radius_m) VALUES ('롤백장소', ?, ?, 150)").run(P.lat, P.lng);
      await rematchPlaces(r.adapter as never);
    }), /boom/);
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM geofences").get() as Row).n, 0, "장소 추가도 롤백");
    assert.equal(row(r, "x").geofence_name, null);
  }

  // 7. 복원 후 재판정: 옛 이름이 든 백업 → 현재 장소 기준(가져온 행 + 기존 행)
  {
    const src = await fresh();
    gf(src, "옛이름", P);
    loc(src, "imp", P, "gps: 옛이름 도착 및 머무름", "옛이름");
    const backup = JSON.parse(JSON.stringify(await collectBackup(src.adapter as never, null)));
    const dst = await fresh();
    gf(dst, "새이름", P);
    loc(dst, "local", P, "gps: 서울특별시 중구 명동 도착 및 머무름");
    await tx(dst, async () => {
      await restoreBackup(dst.adapter as never, backup);
      await rematchPlaces(dst.adapter as never);
    });
    assert.deepEqual(row(dst, "imp"), { subject: "gps: 새이름 도착 및 머무름", geofence_name: "새이름" }, "가져온 행이 현재 장소로");
    assert.equal(row(dst, "local").geofence_name, "새이름", "기존 행도 같은 기준");
    assert.deepEqual(fts(dst, "옛이름"), [], "옛 이름은 검색에서 사라짐");
  }

  // 8. 겹치는 장소 두 개: id 작은 쪽
  {
    const r = await fresh();
    gf(r, "작은id", P, 500);
    gf(r, "큰id", { lat: P.lat + 0.0001, lng: P.lng }, 500);
    loc(r, "o", P, "gps: x 도착 및 머무름");
    await rematchPlaces(r.adapter as never);
    assert.equal(row(r, "o").geofence_name, "작은id");
  }

  // 9. 한 배치에서 A→B 이동: A 커밋엔 A (최신 위치 B 를 붙이지 않음)
  {
    const r = await fresh();
    gf(r, "A", P);
    gf(r, "B", Q);
    await writeSetting(r.adapter, NOISE_FILTER_SETTING, "");
    const ins = r.d.prepare("INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES ('LOCATION', 'system.location', ?, ?)");
    ins.run(JSON.stringify({ ...P, accuracy: 5 }), T);
    ins.run(JSON.stringify({ ...Q, accuracy: 5 }), T + 600_000);
    await processBatch(r.adapter as never);
    const rows = r.d.prepare("SELECT subject, geofence_name FROM commits WHERE event_type = 'LOCATION' ORDER BY started_at").all() as Row[];
    assert.deepEqual(rows.map((x) => x.geofence_name), ["A", "B"]);
    assert.deepEqual(rows.map((x) => x.subject), ["gps: A 도착 및 머무름", "gps: B 도착 및 머무름"]);
  }

  // 10. 최초 1회 보정은 한 번만
  {
    const r = await fresh();
    loc(r, "x", P, "gps: 서울특별시 중구 명동 도착 및 머무름");
    gf(r, "한번", P);
    assert.deepEqual(await rematchPlacesOnce(r.adapter as never), { changed: 1, incomplete: 0 });
    assert.equal(r.d.prepare("SELECT value FROM app_settings WHERE key = ?").get(PLACE_REMATCH_SETTING)!.value, "1");
    r.d.prepare("UPDATE commits SET geofence_name = '손으로바꿈' WHERE id = 'x'").run();
    assert.deepEqual(await rematchPlacesOnce(r.adapter as never), { changed: 0, incomplete: 0 }, "표시가 있으면 다시 실행하지 않음");
    assert.equal(row(r, "x").geofence_name, "손으로바꿈");
  }

  console.log("rematch.check OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
