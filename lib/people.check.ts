import assert from "node:assert/strict";
import { buildPeople, normalizePhone, peopleDisplayLabels, topPeople } from "./people";
import type { Commit } from "../types/commit";

const NOW = 1_800_000_000_000, DAY = 86_400_000;
let n = 0;
const c = (eventType: string, body: object, t = NOW): Commit => ({ id: `c${n++}`, branchId: 1, parentId: null, subject: "", body: JSON.stringify(body), authorTag: null,
  startedAt: t, endedAt: t, durationSec: 1, appPackage: "com.kakao.talk", eventType: eventType as Commit["eventType"], squashedEvents: [], geofenceName: null, lat: null, lng: null, createdAt: 0 });
const call = (phoneNumber: string, contactName: string | null, callType: string, durationSec: number, t = NOW) => c("CALL", { phoneNumber, contactName, callType, durationSec }, t);
const sms = (phoneNumber: string, contactName: string | null, t = NOW) => c("SMS", { phoneNumber, contactName, body: "x" }, t);
const reply = (sender: string, t = NOW) => c("REPLY", { sender, receivedMsg: "a", replyMsg: "b", packageName: "com.kakao.talk" }, t);

// +82 and 010 forms are one person
assert.equal(normalizePhone("+82 10-1234-5678"), "01012345678");
assert.equal(normalizePhone("010-1234-5678"), "01012345678");
assert.equal(normalizePhone("02-555-1234"), "025551234");
assert.equal(normalizePhone("+82 2-555-1234"), normalizePhone("02-555-1234"));
assert.equal(normalizePhone("+82 010-1234-5678"), normalizePhone("010-1234-5678"));
assert.equal(normalizePhone("1588-1234"), "15881234");
{
  const p = buildPeople([call("+82 10-1234-5678", "Kim", "OUTGOING", 120), sms("010-1234-5678", "Kim")], NOW);
  assert.equal(p.length, 1);
  assert.deepEqual([p[0].name, p[0].calls, p[0].callSec, p[0].sms], ["Kim", 1, 120, 1]);
}
// missed / rejected calls do not count (a spam caller does not rank first)
{
  const p = buildPeople([call("01000000001", "Spam", "MISSED", 0), call("01000000001", "Spam", "REJECTED", 0), call("01000000002", "Lee", "INCOMING", 30)], NOW);
  assert.deepEqual(p.map((x) => x.name), ["Lee"]);
}
// A messenger display name cannot identify a phone contact, even when two contacts share that name.
{
  const rows = [call("01000000001", "Same", "INCOMING", 60), call("01000000002", "Same", "INCOMING", 60), reply("Same")];
  for (const input of [rows, [...rows].reverse()]) {
    const p = buildPeople(input, NOW);
    assert.equal(p.length, 3);
    assert.equal(p.filter((x) => x.key.startsWith("tel:") && x.calls === 1 && x.replies === 0).length, 2);
    assert.deepEqual(p.filter((x) => x.key.startsWith("msg:")).map((x) => [x.name, x.replies]), [["Same · 카카오톡", 1]]);
  }
  const tagged = buildPeople(rows, NOW, [{ contact_name: "Same", tag: "#phone-only", phone_number: "01000000001" }]);
  assert.equal(tagged.find((x) => x.key.startsWith("msg:"))?.tag, null, "a phone contact tag cannot identify a messenger sender");
}
// Only same-name saved phone contacts get a last-four display suffix. Their graph labels must differ too.
{
  const people = buildPeople([call("01000000001", "Same", "INCOMING", 30),
    call("01000000002", "Same", "INCOMING", 30), call("01000000003", "Solo", "INCOMING", 30), reply("Same")], NOW);
  const labels = peopleDisplayLabels(people);
  assert.deepEqual(labels.get("tel:01000000001"), { full: "Same (…0001)", node: "Same (…0001)" });
  assert.deepEqual(labels.get("tel:01000000002"), { full: "Same (…0002)", node: "Same (…0002)" });
  assert.deepEqual(labels.get("tel:01000000003"), { full: "Solo", node: "Solo" });
  assert.equal(labels.get("msg:com.kakao.talk:Same")?.full, "Same · 카카오톡");
}
// A whole same-name group must use enough phone digits to distinguish every label, including graph nodes.
{
  const people = buildPeople([call("01011111234", "Same", "INCOMING", 30),
    call("01022221234", "Same", "INCOMING", 30), call("01033335678", "Same", "INCOMING", 30),
    call("01044440000", "Solo", "INCOMING", 30)], NOW);
  const labels = peopleDisplayLabels(people);
  assert.deepEqual(labels.get("tel:01011111234"), { full: "Same (…111234)", node: "Same (…111234)" });
  assert.deepEqual(labels.get("tel:01022221234"), { full: "Same (…221234)", node: "Same (…221234)" });
  assert.deepEqual(labels.get("tel:01033335678"), { full: "Same (…335678)", node: "Same (…335678)" });
  assert.deepEqual(labels.get("tel:01044440000"), { full: "Solo", node: "Solo" });
}
// Widen to eight digits when six collide, then the full number when eight collide.
{
  const eight = peopleDisplayLabels(buildPeople([call("01011111234", "Same", "INCOMING", 30),
    call("01022111234", "Same", "INCOMING", 30)], NOW));
  assert.equal(eight.get("tel:01011111234")?.full, "Same (…11111234)");
  assert.equal(eight.get("tel:01022111234")?.full, "Same (…22111234)");
  const people = buildPeople([call("01011111234", "Same", "INCOMING", 30),
    call("02011111234", "Same", "INCOMING", 30)], NOW);
  const labels = peopleDisplayLabels(people);
  assert.deepEqual(labels.get("tel:01011111234"), { full: "Same (01011111234)", node: "Same (01011111234)" });
  assert.deepEqual(labels.get("tel:02011111234"), { full: "Same (02011111234)", node: "Same (02011111234)" });
}
// recency: the same contact 28 days ago counts a quarter; longer calls weigh more (capped at 30 min)
{
  const p = buildPeople([sms("01033334444", "Old", NOW - 28 * DAY), sms("01055556666", "New")], NOW);
  assert.deepEqual(p.map((x) => [x.name, +x.score.toFixed(2)]), [["New", 1], ["Old", 0.25]]);
  const q = buildPeople([call("01077778888", "Long", "OUTGOING", 3 * 3600), call("01099990000", "Short", "OUTGOING", 60)], NOW);
  assert.deepEqual(q.map((x) => [x.name, +x.score.toFixed(2)]), [["Long", 4], ["Short", 1.1]]);
}
// unsaved numbers: shown by their last 4 digits, hidden unless asked; top-N + "외 N명"
{
  const many = Array.from({ length: 18 }, (_, i) => sms(`0101000${String(i).padStart(4, "0")}`, `P${i}`, NOW - i * DAY));
  const people = buildPeople([...many, sms("01098765432", null)], NOW);
  const unsaved = people.find((x) => !x.saved)!;
  assert.equal(unsaved.name, "…5432");
  const { top, others, unsaved: u } = topPeople(people, 15);
  assert.deepEqual([top.length, others, u, top.some((x) => !x.saved)], [15, 3, 1, false]);
  assert.equal(topPeople(people, 15, true).top.some((x) => !x.saved), true, "shown on request");
}
// A messenger sender formatted as a number follows the same default-hidden policy as an unsaved phone number.
{
  const people = buildPeople([reply("010-9876-5432")], NOW);
  assert.deepEqual(people.map((p) => [p.name, p.saved]), [["…5432", false]]);
  assert.deepEqual(topPeople(people), { top: [], others: 0, unsaved: 1 });
  assert.equal(topPeople(people, 15, true).top.length, 1);
}
// Punctuation, Unicode dashes/spaces and fullwidth digits must not expose a number-shaped sender by default.
{
  const senders = ["010.9876.5432", "010\u20119876\u20115432", "010\u20139876\u20135432",
    "010\u22129876\u22125432", "010\u00a09876\u00a05432", "０１０－９８７６－５４３２",
    "(010) 9876-5432", "+82 (10) 9876-5432", "010·9876·5432", "010/9876/5432"];
  for (const sender of senders) {
    const people = buildPeople([reply(sender)], NOW);
    assert.deepEqual(people.map((p) => [p.name, p.saved]), [["…5432", false]], sender);
    assert.deepEqual(topPeople(people), { top: [], others: 0, unsaved: 1 }, sender);
  }
  const ordinary = buildPeople([reply("Team 7")], NOW);
  assert.deepEqual(ordinary.map((p) => [p.name, p.saved]), [["Team 7 · 카카오톡", true]]);
}
// contact tags by name or number
{
  const p = buildPeople([sms("01012340000", "Mom"), sms("01043210000", null)], NOW, [{ contact_name: "Mom", tag: "#family" }, { contact_name: "x", tag: "#work", phone_number: "+82 10-4321-0000" }]);
  assert.deepEqual(p.map((x) => x.tag).sort(), ["#family", "#work"]);
}
// 동명이인 (같은 이름, 다른 번호) 태그 분리 및 번호 없는 행 폴백 검증
{
  const p1 = call("01011112222", "김철수", "INCOMING", 60);
  const p2 = call("01033334444", "김철수", "OUTGOING", 60);
  const p3 = call("01055556666", "김철수", "INCOMING", 60); // 태그 없는 동명이인
  const p4 = call("01099998888", "이영희", "INCOMING", 60); // 번호 없는 태그와 이름 일치

  const tags = [
    { contact_name: "김철수", tag: "#friend1", phone_number: "010-1111-2222" },
    { contact_name: "김철수", tag: "#friend2", phone_number: "010-3333-4444" },
    { contact_name: "이영희", tag: "#work", phone_number: null },
  ];

  const people = buildPeople([p1, p2, p3, p4], NOW, tags);
  const c1 = people.find((p) => p.key === "tel:01011112222")!;
  const c2 = people.find((p) => p.key === "tel:01033334444")!;
  const c3 = people.find((p) => p.key === "tel:01055556666")!;
  const c4 = people.find((p) => p.key === "tel:01099998888")!;

  assert.equal(c1.tag, "#friend1", "첫 번째 김철수는 #friend1");
  assert.equal(c2.tag, "#friend2", "두 번째 김철수는 #friend2");
  assert.equal(c3.tag, null, "태그가 지정되지 않은 세 번째 김철수는 다른 김철수의 태그를 가져오지 않음 (동명이인 분리)");
  assert.equal(c4.tag, "#work", "번호 일치가 없을 때 번호 없는 행(name: 키)만 이름으로 매칭");
}
// A call starting just before a week ends belongs only to that week, with its whole duration.
{
  const boundary = NOW - 60_000;
  const crossing = call("01000000033", "Caller", "OUTGOING", 120, boundary - 60_000);
  crossing.endedAt = crossing.startedAt + 120_000;
  const first = buildPeople([crossing], NOW, [], { start: boundary - 7 * DAY, end: boundary });
  const second = buildPeople([crossing], NOW, [], { start: boundary + 1, end: boundary + 7 * DAY });
  assert.deepEqual(first.map((p) => [p.calls, p.callSec]), [[1, 120]]);
  assert.deepEqual(second, []);
}
// Last contact is the latest start within the period across all channels, independent of input order.
{
  const rows = [call("01000000101", "Test", "OUTGOING", 30, NOW - 3 * DAY),
    sms("01000000101", "Test", NOW - DAY), reply("Messenger", NOW - 2 * DAY),
    reply("Messenger", NOW - 30_000), call("01000000101", "Test", "INCOMING", 20, NOW + DAY)];
  for (const input of [rows, [...rows].reverse()]) {
    const people = buildPeople(input, NOW, [], { start: NOW - 4 * DAY, end: NOW });
    const phone = people.find((p) => p.key === "tel:01000000101")!;
    const messenger = people.find((p) => p.key === "msg:com.kakao.talk:Messenger")!;
    assert.deepEqual([phone.lastAt, phone.lastKind, phone.calls, phone.sms], [NOW - DAY, "SMS", 1, 1]);
    assert.deepEqual([messenger.lastAt, messenger.lastKind, messenger.replies], [NOW - 30_000, "REPLY", 2]);
  }
}
console.log("people checks passed");
