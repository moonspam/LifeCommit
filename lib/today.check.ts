import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dayRange, memoTimestamp, objectParticle, summarizeDay, unregisteredStays, isLatestLoad } from "./today";
import type { Commit } from "../types/commit";
import { rememberAppLabels } from "./processor/utils";
import DaySummaryCard from "../components/Today/DaySummaryCard";

const commit = (patch: Partial<Commit>): Commit => ({ id: "x", branchId: 1, parentId: null, subject: "feat: 크롬 사용", body: null, authorTag: null, startedAt: 0, endedAt: 0, durationSec: 60, appPackage: "com.android.chrome", eventType: "APP_USAGE", squashedEvents: [], geofenceName: null, lat: null, lng: null, createdAt: 0, ...patch });
assert.equal(summarizeDay([]).sentences[0], "아직 기록이 없어요.");
assert.equal(summarizeDay([commit({ durationSec: 90 })]).activitySec, 90);
const many = summarizeDay([commit({ durationSec: 120, geofenceName: "집" }), commit({ id: "y", appPackage: "com.kakao.talk", durationSec: 300, geofenceName: "회사" }), commit({ id: "z", subject: "chore: Idle state", durationSec: 600, appPackage: null })]);
assert.equal(many.topApps[0].name, "카카오톡");
assert.deepEqual(many.places, ["집", "회사"]);
assert.equal(summarizeDay([commit({ eventType: "LOCATION", durationSec: 14400, appPackage: null })]).activitySec, 0);
assert.equal(objectParticle("유튜브"), "를");
assert.equal(objectParticle("카카오톡"), "을");
assert.equal(objectParticle("Chrome"), "를");
assert.equal(memoTimestamp("2026-09-21", new Date("2026-09-21T09:00:00").getTime()), new Date("2026-09-21T09:00:00").getTime());
assert.equal(memoTimestamp("2026-09-20", new Date("2026-09-21T09:00:00").getTime()), new Date("2026-09-20T12:00:00").getTime());
assert.equal(dayRange("2026-09-21").end - dayRange("2026-09-21").start, 86400000 - 1); // inclusive end, 1ms before next midnight
console.log("today summary checks passed");

// a session starting exactly at the next midnight (00:00:00.000) belongs to the next day
{
  const { start, end } = dayRange("2026-10-04");
  const nextMidnight = new Date("2026-10-05T00:00:00").getTime();
  assert.ok(nextMidnight > end && nextMidnight - end === 1);
  assert.ok(start <= new Date("2026-10-04T23:59:59.999").getTime() && new Date("2026-10-04T23:59:59.999").getTime() <= end);
}

// device labels win over the package-name fallback ("Ku" for com.skt.tmap.ku) and over the built-in map
{
  const tmap = commit({ appPackage: "com.skt.tmap.ku", durationSec: 600 });
  assert.equal(summarizeDay([tmap]).topApps[0].name, "Ku");
  rememberAppLabels({ "com.skt.tmap.ku": "TMAP", "com.kakao.talk": "카카오톡(기기)" });
  assert.equal(summarizeDay([tmap]).topApps[0].name, "TMAP");
  assert.equal(summarizeDay([commit({ appPackage: "com.kakao.talk" })]).topApps[0].name, "카카오톡(기기)");
}

// unregistered stays (dong names) follow the registered places; duplicates dropped
assert.deepEqual(summarizeDay([commit({ geofenceName: "집" })], undefined, ["서울특별시 중구 명동", "집", "서울특별시 중구 명동"]).places, ["집", "서울특별시 중구 명동"]);

// stays: runs of fixes within 150 m and LOCATION_GAP_MS; an outage (no fixes) ends a stay instead of extending it
{
  const M = 60_000;
  const loc = (id: string, s: number, e = s, lat = 37.5663, geofenceName: string | null = null) =>
    commit({ id, eventType: "LOCATION", appPackage: null, startedAt: s * M, endedAt: e * M, durationSec: 1, lat, lng: 126.9779, geofenceName });
  const ids = (cs: Commit[]) => unregisteredStays(cs).map((c) => c.id);
  assert.deepEqual(ids([loc("a", 0, 30)]), ["a"], "one dwell commit of 30 min");
  assert.deepEqual(ids([loc("a", 0, 6), loc("b", 9, 20)]), ["a"], "a stay split by a call/SMS joins up (20 min)");
  assert.deepEqual(ids([loc("a", 0), loc("b", 60)]), [], "reviewer: one fix, then collection stopped -> not a stay");
  assert.deepEqual(ids([loc("a", 0, 8), loc("b", 30, 38)]), [], "a 22-min gap (phone off) splits two 8-min stays");
  assert.deepEqual(ids([loc("a", 0, 8), loc("b", 9, 15, 37.5763)]), [], "1.1 km away is another place (8 + 6 min, not joined)");
  assert.deepEqual(ids([loc("a", 0, 30, 37.5663, "집")]), [], "registered places are named by the geofence instead");
  // reviewer: 23:55 -> 00:30 without moving; the next day must name it whether stored merged or split by an SMS
  const day2 = 24 * 60;
  assert.deepEqual(ids([loc("m", day2 - 5, day2 + 30)]), ["m"], "merged commit overlapping the next day");
  assert.deepEqual(ids([loc("f1", day2 + 2, day2 + 14), loc("f2", day2 + 17, day2 + 30)]), ["f1"], "the next day's fragments");
  // round 30: 23:55-23:59, an SMS, 00:02-00:08 - 13 min only as a whole; both days must name it when the caller passes
  // the commits around the day (TodayPanel: +-STAY_CONTEXT_MS) and the day's range
  const split = [loc("p1", day2 - 5, day2 - 1), loc("p2", day2 + 2, day2 + 8)];
  const inRange = (s: number, e: number) => unregisteredStays(split, s * M, e * M).map((c) => c.id);
  assert.deepEqual(inRange(0, day2 - 1e-9), ["p1"], "day 1");
  assert.deepEqual(inRange(day2, 2 * day2), ["p1"], "day 2");
  assert.deepEqual(inRange(2 * day2, 3 * day2), [], "a stay outside the range is not this day's");
}

// 55차 검수: 늦게 끝난 이전 날짜 조회가 현재 화면 결과를 덮어쓰지 않도록 세대 번호로 버림 (IMPL-BRIEF-REPLAY-5)
{
  // 1) isLatestLoad 순수 함수 검증
  let activeGen = 0;
  const startLoad = () => ++activeGen;

  // A 조회 시작 (gen=1)
  const genA = startLoad();
  assert.equal(genA, 1);

  // 사용자가 B로 날짜 변경 -> B 조회 시작 (gen=2)
  const genB = startLoad();
  assert.equal(genB, 2);

  // B 조회가 먼저 완료됨: genB(2) === activeGen(2) -> 최신 결과이므로 적용
  assert.equal(isLatestLoad(genB, activeGen), true, "최신 조회의 결과는 반영되어야 함");

  // 나중에 늦게 끝난 A 조회가 도착함: genA(1) !== activeGen(2) -> 낡은 결과이므로 버림
  assert.equal(isLatestLoad(genA, activeGen), false, "늦게 끝난 이전 조회의 결과는 버려져야 함");

  // 같은 날짜 재조회 (예: resumeTick, 갱신 이벤트로 gen=3 시작)
  const genB2 = startLoad();
  assert.equal(isLatestLoad(genB, activeGen), false, "이전 B 조회는 더 새로운 B2 조회가 시작되면 버려짐");
  assert.equal(isLatestLoad(genB2, activeGen), true, "가장 최신 B2 조회의 결과만 반영됨");
}

// 56차 검수: 비동기 분류 저장 후 중복 재조회 제거 및 현재 날짜 조회 보존 (IMPL-BRIEF-REPLAY-6)
{
  let activeGen = 0;
  const startLoad = () => ++activeGen;

  // A 날짜에서 classify 클릭 후 저장 대기 중
  // A 조회 시작 (gen=1)
  const genA = startLoad();

  // 날짜 B로 이동 -> B 조회 시작 (gen=2)
  const genB = startLoad();

  // 분류 저장 완료 시 EVENT_COMMITS_UPDATED 이벤트 발행 -> 현재 B 구독의 load()만 호출 (gen=3)
  // 이전 classify 내부의 중복 A load() 호출이 없으므로 A가 새 세대를 가로채지 않음
  const genBEvent = startLoad();

  // B 이벤트 조회가 완료됨
  assert.equal(isLatestLoad(genBEvent, activeGen), true, "현재 날짜 B의 이벤트 조회 결과가 정상 반영됨");

  // 이전 A 조회나 이전 B 조회는 버려짐
  assert.equal(isLatestLoad(genA, activeGen), false, "오래된 A 조회 결과는 버려짐");
  assert.equal(isLatestLoad(genB, activeGen), false, "갱신 전 B 조회 결과는 버려짐");

  // 정적 검증: TodayPanel.tsx의 classify 내 중복 load() 호출 제거 확인
  const todayPanelSrc = readFileSync(new URL("../components/Today/TodayPanel.tsx", import.meta.url), "utf-8");
  assert.ok(
    /offs\.forEach\(\(off\) => off\(\)\);\s*genRef\.current\+\+;/.test(todayPanelSrc),
    "load effect 정리에서 genRef를 올려, 언마운트 후 끝난 조회가 onUnclassifiedOpenChange를 부르지 않아야 함"
  );
  assert.ok(
    !todayPanelSrc.includes("await setAppBranchOverride(pkg, branchId); await load();"),
    "classify 핸들러 내 중복 await load() 호출이 없어야 함"
  );
  assert.ok(
    todayPanelSrc.includes("await setAppBranchOverride(pkg, branchId);"),
    "classify 핸들러는 setAppBranchOverride만 호출해야 함"
  );
}

// UX2 항목 1: DaySummaryCard 항목별 구분 및 full/oss 렌더링 검증
{
  const sampleSummary = {
    activitySec: 5400,
    topApps: [
      { name: "Chrome", durationSec: 3600 },
      { name: "KakaoTalk", durationSec: 1800 },
    ],
    longestSession: { name: "Chrome", durationSec: 2400 },
    places: ["서울역", "대전역"],
    calls: 3,
    sms: 0,
    photos: 12,
  };

  // 1) full 모드 렌더링: 라벨/값 2열 격자 및 3칸 타일 확인
  const fullHtml = renderToStaticMarkup(
    createElement(DaySummaryCard, {
      date: "2026-10-17",
      todayKey: "2026-10-17",
      summary: sampleSummary,
      flavor: "full",
    })
  );

  assert.ok(fullHtml.includes("오늘의 요약"), "오늘 날짜 제목 확인");
  assert.ok(fullHtml.includes("grid-cols-[4.5em_minmax(0,1fr)]"), "2열 격자 그리드 클래스 포함");
  assert.ok(fullHtml.includes("상위 앱"), "상위 앱 라벨 포함");
  assert.ok(fullHtml.includes("Chrome 1시간"), "상위 앱 칩 포맷 확인");
  assert.ok(fullHtml.includes("최장"), "최장 세션 라벨 포함");
  assert.ok(fullHtml.includes("Chrome 40분"), "최장 세션 값 확인");
  assert.ok(fullHtml.includes("장소"), "full: 장소 라벨 포함");
  assert.ok(fullHtml.includes("서울역 · 대전역"), "full: 장소 값 확인");
  assert.ok(fullHtml.includes("grid-cols-3"), "full: 통화/SMS/사진 3칸 타일 포함");
  assert.ok(fullHtml.includes("통화") && fullHtml.includes("3"), "통화 라벨 및 숫자 확인");
  assert.ok(fullHtml.includes("SMS") && fullHtml.includes("0"), "SMS 라벨 및 숫자 확인");
  assert.ok(fullHtml.includes("사진") && fullHtml.includes("12"), "사진 라벨 및 숫자 확인");

  // 2) oss 모드 렌더링: 장소/통화/SMS/사진 숨김 확인
  const ossHtml = renderToStaticMarkup(
    createElement(DaySummaryCard, {
      date: "2026-10-16",
      todayKey: "2026-10-17",
      summary: sampleSummary,
      flavor: "oss",
    })
  );

  assert.ok(ossHtml.includes("이날의 요약"), "과거 날짜는 '이날의 요약'");
  assert.ok(ossHtml.includes("상위 앱"), "oss: 상위 앱 포함");
  assert.ok(ossHtml.includes("최장"), "oss: 최장 포함");
  assert.ok(!ossHtml.includes("장소"), "oss: 장소 없어야 함");
  assert.ok(!ossHtml.includes("통화"), "oss: 통화 없어야 함");
  assert.ok(!ossHtml.includes("SMS"), "oss: SMS 없어야 함");
  assert.ok(!ossHtml.includes("사진"), "oss: 사진 없어야 함");
  assert.ok(!ossHtml.includes("grid-cols-3"), "oss: 3칸 타일 없어야 함");

  // 3) 기록 없는 경우 & 최장 세션 없는 경우
  const emptyHtml = renderToStaticMarkup(
    createElement(DaySummaryCard, {
      date: "2026-10-17",
      todayKey: "2026-10-17",
      summary: {
        activitySec: 0,
        topApps: [],
        longestSession: null,
        places: [],
        calls: 0,
        sms: 0,
        photos: 0,
      },
      flavor: "full",
    })
  );
  assert.ok(emptyHtml.includes("기록 없음"), "앱/장소 없을 때 '기록 없음'");
  assert.ok(!emptyHtml.includes("최장"), "longestSession null이면 최장 행 숨김");
}

