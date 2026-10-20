import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildReplay,
  playheadAt,
  replaySteps,
  initialReplayState,
  PLAY_SEC_PER_WEIGHT,
  MAX_PLAY_SEC,
  replaySecPerWeight,
  formatReplayClock,
  formatPlaceLabel,
  shouldInitReplay,
  replayReady,
  calcLegWeight,
  maxPlaySecForPeriod,
  nextReplaySpeed,
  changeReplaySpeed,
  type ReplayPlaybackState,
  advanceReplay,
  REPLAY_MAX_PLAY_SEC,
} from "./replay";
import { isLatestLoad } from "./today";
import ReplayView from "../components/Today/ReplayView";
import ReplayButton from "../components/Today/ReplayButton";
import type { Commit } from "../types/commit";

const M = 60_000, DAY = 24 * 60 * M;
const loc = (id: string, s: number, e = s, lat = 0.28, lng = 0.01, geofenceName: string | null = null): Commit =>
  ({ id, branchId: 2, parentId: null, subject: "gps", body: null, authorTag: null, startedAt: s * M, endedAt: e * M, durationSec: 1,
    appPackage: null, eventType: "LOCATION", squashedEvents: [], geofenceName, lat, lng, createdAt: 0 });

// jitter within a stay collapses into one stop; a move to 1.1 km away is a new stop joined by a leg
{
  const { stops, legs } = buildReplay([loc("a", 60, 63), loc("b", 66, 120, 0.2801, 0.0101), loc("c", 125, 130, 0.29)], 0, DAY);
  assert.equal(stops.length, 2, "a + b (11 m apart) are one stop");
  assert.deepEqual(stops.map((s) => [s.start / M, s.end / M, s.stay]), [[60, 120, true], [125, 130, false]]);
  assert.deepEqual(legs.map(({ from, to, broken }) => ({ from, to, broken })), [{ from: 0, to: 1, broken: false }]);
}
// a gap over 15 min (phone off) breaks the line instead of inventing a path
{
  const { legs } = buildReplay([loc("a", 0, 30), loc("b", 90, 120, 0.30)], 0, DAY);
  assert.deepEqual(legs.map(({ from, to, broken }) => ({ from, to, broken })), [{ from: 0, to: 1, broken: true }]);
}
// During a collection gap the clock advances but no location is claimed; a normal move interpolates its marker.
{
  const broken = buildReplay([loc("gap-a", 0, 30), loc("gap-b", 90, 120, 0.30)], 0, DAY);
  const brokenSteps = replaySteps(broken);
  const inGap = playheadAt(broken, brokenSteps, brokenSteps[0].weight + brokenSteps[1].weight / 2);
  assert.equal(inGap.time, 60 * M);
  assert.equal(inGap.point, null);
  const known = buildReplay([loc("move-a", 0), loc("move-b", 5, 5, 0.30)], 0, DAY);
  const knownSteps = replaySteps(known);
  const inMove = playheadAt(known, knownSteps, knownSteps[0].weight + knownSteps[1].weight / 2);
  assert.equal(inMove.time, 2.5 * M);
  assert.ok(inMove.point && Math.abs(inMove.point.lat - 0.29) < 1e-10 && Math.abs(inMove.point.lng - 0.01) < 1e-10);
}
// stays are clipped to the day; a stay across midnight keeps its whole length for "stay"
{
  const { stops } = buildReplay([loc("n", -30, 20)], 0, DAY);
  assert.deepEqual(stops.map((s) => [s.start, s.end / M, s.stay]), [[0, 20, true]], "clipped at midnight, still a 50-min stay");
  assert.deepEqual(buildReplay([loc("y", -90, -60)], 0, DAY).stops, [], "yesterday only: not in today's route");
}
// a registered place keeps its name
assert.equal(buildReplay([loc("h", 0, 30, 0.28, 0.01, "Test Place")], 0, DAY).stops[0].geofence, "Test Place");
// playback: an 8-hour night weighs ~4 steps, not 8 hours; pass-throughs and gaps are short
{
  const r = buildReplay([loc("home", 0, 480), loc("pass", 485, 485, 0.30), loc("work", 490, 560, 0.32)], 0, DAY);
  const w = replaySteps(r).map((s) => `${s.kind}:${s.weight.toFixed(1)}`);
  assert.deepEqual(w, ["stop:0.0", "leg:0.7", "stop:0.0", "leg:0.7", "stop:0.0"]);
}

// 항목 1 개선 검증: 머무는 곳에서 멈추지 않기 (a, b, c, d)
{
  const rep = buildReplay([loc("s1", 0, 60, 0.1, 0.1), loc("s2", 120, 180, 0.2, 0.2), loc("s3", 240, 300, 0.3, 0.3)], 0, DAY);
  const st = replaySteps(rep);
  const tot = st.reduce((a, s) => a + s.weight, 0);

  // (a) 진행도가 stay를 지나는 동안 연속된 두 진행값에서 마커 위치가 같은 구간이 없음 (stop weight는 0)
  assert.ok(st.filter((s) => s.kind === "stop").every((s) => s.weight === 0), "모든 stop 가중치는 0이어야 함");
  let prevPt: { lat: number; lng: number } | null = null;
  for (let p = 0.05; p <= tot; p += 0.05) {
    const cur = playheadAt(rep, st, p);
    if (prevPt && cur.point) {
      assert.notEqual(cur.point.lat, prevPt.lat, `진행도 ${p}에서 마커가 멈추지 않고 계속 이동해야 함`);
    }
    prevPt = cur.point;
  }

  // (b) stop 도달 직후 프레임에 그 stop이 reached
  const legWeight = st[1].weight;
  const justAfter = playheadAt(rep, st, legWeight + 0.001);
  assert.ok(2 <= justAfter.i, "stop 도달 직후 프레임에 해당 stopStep <= at.i 가 성립해야 함");

  // (c) 어떤 진행값에서도 time/point에 NaN 없음
  for (let p = 0; p <= tot + 1; p += 0.05) {
    const at = playheadAt(rep, st, p);
    assert.ok(!Number.isNaN(at.time), `time은 NaN이 아니어야 함 (p=${p})`);
    if (at.point) {
      assert.ok(!Number.isNaN(at.point.lat) && !Number.isNaN(at.point.lng), `point는 NaN이 아니어야 함 (p=${p})`);
    }
  }

  // (d) stay만 1개 → total=0, 전체 보기(playing=false)
  const singleStayRep = buildReplay([loc("stayOnly", 0, 120, 0.5, 0.5)], 0, DAY);
  const singleSteps = replaySteps(singleStayRep);
  const singleTotal = singleSteps.reduce((a, s) => a + s.weight, 0);
  assert.equal(singleTotal, 0, "stay만 1개이면 total은 0이어야 함");
  const singleState = initialReplayState({ total: singleTotal, stepCount: singleSteps.length, reducedMotion: false });
  assert.deepEqual(singleState, { progress: 0, playing: false }, "stay만 1개이면 전체 보기(playing=false)");
  const singleAt = playheadAt(singleStayRep, singleSteps, 0);
  assert.ok(!Number.isNaN(singleAt.time) && singleAt.point !== null && !Number.isNaN(singleAt.point.lat));
}

// 58차 검수 반려 대응: playheadAt 경계 도달 및 마지막 장소 reached 검증
{
  // A(stop 0) -> leg 0(weight 1) -> B(stop 1) -> leg 1(weight 1) -> C(stop 2) (간격 5분으로 정상 이동 leg)
  const rep = buildReplay([loc("A", 0, 60, 0.1, 0.1), loc("B", 65, 120, 0.2, 0.2), loc("C", 125, 180, 0.3, 0.3)], 0, DAY);
  const steps = replaySteps(rep);
  const total = steps.reduce((a, s) => a + s.weight, 0);
  const stopStep = new Map(steps.flatMap((s, i) => s.kind === "stop" ? [[s.index, i] as const] : []));
  const isReached = (stopIndex: number, atI: number) => (stopStep.get(stopIndex) ?? Infinity) <= atI;

  // (a) progress = total -> at.i가 마지막 stop 단계 이상, 마지막 stop reached
  const atEnd = playheadAt(rep, steps, total);
  const lastStopStep = stopStep.get(rep.stops.length - 1)!;
  assert.ok(atEnd.i >= lastStopStep, `progress = total일 때 at.i(${atEnd.i})는 마지막 stop 단계(${lastStopStep}) 이상이어야 함`);
  assert.ok(isReached(rep.stops.length - 1, atEnd.i), "progress = total일 때 마지막 stop이 reached여야 함");

  // 2개 장소에서도 동일하게 마지막 stop reached 검증
  const rep2 = buildReplay([loc("A", 0, 60, 0.1, 0.1), loc("B", 65, 120, 0.2, 0.2)], 0, DAY);
  const steps2 = replaySteps(rep2);
  const total2 = steps2.reduce((a, s) => a + s.weight, 0);
  const stopStep2 = new Map(steps2.flatMap((s, i) => s.kind === "stop" ? [[s.index, i] as const] : []));
  const atEnd2 = playheadAt(rep2, steps2, total2);
  const lastStopStep2 = stopStep2.get(rep2.stops.length - 1)!;
  assert.ok(atEnd2.i >= lastStopStep2, `2개 장소: progress = total일 때 at.i(${atEnd2.i}) >= lastStopStep(${lastStopStep2})`);
  assert.ok((stopStep2.get(rep2.stops.length - 1) ?? Infinity) <= atEnd2.i, "2개 장소: 마지막 stop reached여야 함");

  // (b) 정확히 이동 끝(progress = steps[1].weight)에서 다음 stop reached
  const atMove1End = playheadAt(rep, steps, steps[1].weight);
  assert.ok(isReached(1, atMove1End.i), "정확히 이동 1 끝(progress = steps[1].weight)에서 다음 stop(B)이 reached여야 함");

  // (c) progress = 0에서 첫 stop reached, 첫 이동 f=0, 마커는 첫 장소
  const atStart = playheadAt(rep, steps, 0);
  assert.ok(isReached(0, atStart.i), "progress = 0에서 첫 stop(A)이 reached여야 함");
  assert.equal(atStart.f, 0, "첫 이동 f는 0이어야 함");
  assert.ok(atStart.point !== null, "첫 장소 마커 좌표가 존재해야 함");
  assert.ok(Math.abs(atStart.point!.lat - 0.1) < 1e-10 && Math.abs(atStart.point!.lng - 0.1) < 1e-10, "마커는 첫 장소 좌표여야 함");
}
// A move across midnight remains visible on both days. Only the in-day stop gets a stay or playback step.
{
  const rows = [loc("before", 1420, 1438), loc("after", 1442, 1462, 0.30)];
  const beforeDay = buildReplay(rows, 0, DAY - 1);
  const afterDay = buildReplay(rows, DAY, 2 * DAY - 1);
  for (const r of [beforeDay, afterDay]) assert.deepEqual(r.legs.map(({ from, to, broken }) => ({ from, to, broken })), [{ from: 0, to: 1, broken: false }]);
  assert.deepEqual(beforeDay.stops.map((s) => [s.outside, s.stay]), [[false, true], [true, false]]);
  assert.deepEqual(afterDay.stops.map((s) => [s.outside, s.stay]), [[true, false], [false, true]]);
  assert.deepEqual(replaySteps(beforeDay).map((s) => s.kind), ["stop", "leg"]);
  assert.deepEqual(replaySteps(afterDay).map((s) => s.kind), ["leg", "stop"]);
}
// The shared midnight position uses the original observation times; each day plays only its half of the move.
{
  const rows = [loc("before-midnight", 1438), loc("after-midnight", 1442, 1442, 0.30)];
  const before = buildReplay(rows, 0, DAY - 1), after = buildReplay(rows, DAY, 2 * DAY - 1);
  assert.equal(before.stops[1].start, DAY + 2 * M, "outside endpoint keeps its observed time");
  assert.equal(after.stops[0].end, DAY - 2 * M, "outside endpoint keeps its observed time");
  const earlier = replaySteps(before), later = replaySteps(after);
  const beforeLegStart = earlier[0].weight;
  const at = (r: typeof before, steps: typeof earlier, progress: number) => playheadAt(r, steps, progress);
  const samePoint = (p: { lat: number; lng: number } | null, lat: number) =>
    assert.ok(p && Math.abs(p.lat - lat) < 1e-10 && Math.abs(p.lng - 0.01) < 1e-10);
  const beforeMiddle = at(before, earlier, beforeLegStart + earlier[1].weight / 2);
  const beforeEnd = at(before, earlier, beforeLegStart + earlier[1].weight);
  const afterStart = at(after, later, 0);
  const afterMiddle = at(after, later, later[0].weight / 2);
  assert.equal(beforeMiddle.time, DAY - M); samePoint(beforeMiddle.point, 0.285);
  assert.equal(beforeEnd.time, DAY); samePoint(beforeEnd.point, 0.29);
  assert.equal(afterStart.time, DAY); samePoint(afterStart.point, 0.29);
  assert.equal(afterMiddle.time, DAY + M); samePoint(afterMiddle.point, 0.295);
}
// 이동 리플레이 자동 재생 및 속도 검증 (IMPL-BRIEF-REPLAY-2)
{
  // 1) 속도 상수 검증: PLAY_SEC_PER_WEIGHT는 0.5 (약 2.4배 빠르게)
  assert.equal(PLAY_SEC_PER_WEIGHT, 0.5, "PLAY_SEC_PER_WEIGHT 상수는 0.5여야 함");

  // 2) initialReplayState 순수 함수 검증
  // 2.1) 자동 재생 초기 상태: 단계가 1개 이상이고 reduced-motion이 아니면 progress=0, playing=true
  const autoPlay = initialReplayState({ total: 5.5, stepCount: 4, reducedMotion: false });
  assert.deepEqual(autoPlay, { progress: 0, playing: true }, "단계 1개 이상이면 0부터 자동 재생");

  // 2.2) prefers-reduced-motion: reduce 이면 자동 재생하지 않고 개요(progress=total, playing=false)로 시작
  const reduced = initialReplayState({ total: 5.5, stepCount: 4, reducedMotion: true });
  assert.deepEqual(reduced, { progress: 5.5, playing: false }, "reduced-motion이면 자동 재생 안 함");

  // 2.3) 재생할 단계가 없으면 (위치 기록 없음, stepCount=0) 개요 유지
  const noSteps = initialReplayState({ total: 0, stepCount: 0, reducedMotion: false });
  assert.deepEqual(noSteps, { progress: 0, playing: false }, "단계 0개면 playing=false");

  // 2.4) 날짜 변경 시 새 날짜의 단계와 total로 다시 자동 재생 상태 획득
  const nextDay = initialReplayState({ total: 8.2, stepCount: 6, reducedMotion: false });
  assert.deepEqual(nextDay, { progress: 0, playing: true }, "날짜 변경 시 0부터 다시 자동 재생");

  // 3) ReplayView 컴포넌트 렌더링 검증

  const sampleCommits = [loc("a", 60, 120), loc("b", 180, 240, 0.30)];

  // 3.1 기본 마운트: 자동 재생 상태 (일시정지 버튼, 진행중 시각 표시)
  const defaultHtml = renderToStaticMarkup(createElement(ReplayView, {
    commits: sampleCommits, start: 0, end: DAY, periodKey: "2026-10-15", onClose: () => {},
  }));
  assert.ok(defaultHtml.includes("일시정지"), "초기 렌더링 시 자동 재생(playing=true)되어 일시정지 버튼이 보여야 함");
  assert.ok(!defaultHtml.includes("하루 전체"), "초기 렌더링 시 progress=0이므로 하루 전체 개요 대신 시작 시각이 보여야 함");

  // 3.2 prefers-reduced-motion: reduce 시 자동 재생 비활성화 (재생 버튼, 하루 전체 표시)
  const originalWindow = (global as any).window;
  (global as any).window = {
    matchMedia: (q: string) => ({ matches: q.includes("prefers-reduced-motion: reduce") }),
  };
  try {
    const reducedHtml = renderToStaticMarkup(createElement(ReplayView, {
      commits: sampleCommits, start: 0, end: DAY, periodKey: "2026-10-15", onClose: () => {},
    }));
    assert.ok(reducedHtml.includes("▶ 재생"), "reduced-motion이면 자동 재생되지 않고 ▶ 재생 버튼이 보여야 함");
    assert.ok(reducedHtml.includes("하루 전체"), "reduced-motion이면 하루 전체 개요로 시작해야 함");
  } finally {
    (global as any).window = originalWindow;
  }

  // 3.3 위치 기록 없음: 재생 단계 0개 시 개요 유지
  const emptyHtml = renderToStaticMarkup(createElement(ReplayView, {
    commits: [], start: 0, end: DAY, periodKey: "2026-10-15", onClose: () => {},
  }));
  assert.ok(emptyHtml.includes("이날의 위치 기록이 없습니다."), "위치 기록이 없으면 안내 문구 표시");
}

// 53차-1 검수: 날짜 기준 1회 초기화 (IMPL-BRIEF-REPLAY-3)
{
  // 1) shouldInitReplay 순수 함수 검증
  // (a) 0단계로 마운트 -> 같은 날짜 데이터 도착 -> 자동 재생 1회
  assert.equal(
    shouldInitReplay({ initializedForDate: null, periodKey: "2026-10-15", stepCount: 0 }),
    false,
    "단계 0개일 때는 아직 초기화하지 않음"
  );
  assert.equal(
    shouldInitReplay({ initializedForDate: null, periodKey: "2026-10-15", stepCount: 2 }),
    true,
    "데이터 도착 시 초기화 실행"
  );

  // (b) 재생 중 같은 날짜 데이터 증가 -> 초기화 안 함(progress/playing 유지)
  assert.equal(
    shouldInitReplay({ initializedForDate: "2026-10-15", periodKey: "2026-10-15", stepCount: 5 }),
    false,
    "이미 초기화된 날짜에서 데이터 증가 시 재초기화 금지"
  );

  // (c) 날짜 변경 시 새 날짜에서 다시 초기화 실행
  assert.equal(
    shouldInitReplay({ initializedForDate: "2026-10-15", periodKey: "2026-10-16", stepCount: 3 }),
    true,
    "날짜 변경 시 새 날짜에서 초기화 실행"
  );
  assert.equal(
    shouldInitReplay({ initializedForDate: "2026-10-15", periodKey: "2026-10-16", stepCount: 0 }),
    false,
    "날짜가 바뀌었어도 새 날짜 데이터가 0개면 대기"
  );

  // (d) reduced-motion 개요 동작 확인
  const initNormal = initialReplayState({ total: 5.0, stepCount: 3, reducedMotion: false });
  assert.deepEqual(initNormal, { progress: 0, playing: true });
  const initReduced = initialReplayState({ total: 5.0, stepCount: 3, reducedMotion: true });
  assert.deepEqual(initReduced, { progress: 5.0, playing: false });

  // 2) ReplayView 컴포넌트 라이프사이클 시뮬레이션
  // (a) 0단계로 마운트 -> 같은 날짜 데이터 도착 -> 자동 재생 1회
  let initializedForDate: string | null = null;
  let progress = 0;
  let playing = false;
  if (shouldInitReplay({ initializedForDate, periodKey: "2026-10-15", stepCount: 0 })) {
    initializedForDate = "2026-10-15";
    const s = initialReplayState({ total: 0, stepCount: 0, reducedMotion: false });
    progress = s.progress; playing = s.playing;
  }
  assert.equal(initializedForDate, null);
  assert.equal(playing, false);

  if (shouldInitReplay({ initializedForDate, periodKey: "2026-10-15", stepCount: 2 })) {
    initializedForDate = "2026-10-15";
    const s = initialReplayState({ total: 3.5, stepCount: 2, reducedMotion: false });
    progress = s.progress; playing = s.playing;
  }
  assert.equal(initializedForDate, "2026-10-15");
  assert.equal(progress, 0);
  assert.equal(playing, true, "(a) 데이터 도착 시 자동 재생 1회 시작");

  // (b) 재생 중 같은 날짜 데이터 증가 -> progress 유지
  progress = 1.8;
  if (shouldInitReplay({ initializedForDate, periodKey: "2026-10-15", stepCount: 4 })) {
    initializedForDate = "2026-10-15";
    const s = initialReplayState({ total: 5.5, stepCount: 4, reducedMotion: false });
    progress = s.progress; playing = s.playing;
  }
  assert.equal(progress, 1.8, "(b) 재생 중 같은 날짜 데이터 증가 시 progress 유지");
  assert.equal(playing, true);

  // (c) 사용자가 일시정지한 뒤 날짜 변경 -> 새 날짜에서 자동 재생
  playing = false;
  progress = 2.0;
  if (shouldInitReplay({ initializedForDate, periodKey: "2026-10-16", stepCount: 3 })) {
    initializedForDate = "2026-10-16";
    const s = initialReplayState({ total: 4.2, stepCount: 3, reducedMotion: false });
    progress = s.progress; playing = s.playing;
  }
  assert.equal(initializedForDate, "2026-10-16");
  assert.equal(progress, 0, "(c) 날짜 변경 시 0부터 재시작");
  assert.equal(playing, true, "(c) 새 날짜에서 자동 재생");

  // (d) reduced-motion이면 새 total로 개요
  let rmInitDate: string | null = null;
  let rmProgress = 0, rmPlaying = true;
  if (shouldInitReplay({ initializedForDate: rmInitDate, periodKey: "2026-10-16", stepCount: 3 })) {
    rmInitDate = "2026-10-16";
    const s = initialReplayState({ total: 4.2, stepCount: 3, reducedMotion: true });
    rmProgress = s.progress; rmPlaying = s.playing;
  }
}

// 54차 검수: 이전 날짜 데이터(A의 around)로 새 날짜(B) 초기화 방지 (IMPL-BRIEF-REPLAY-4)
{
  // 1) replayReady 순수 함수 검증
  // 준비 전(null/undefined)
  assert.equal(replayReady(null, "2026-10-16"), false, "데이터 준비 전이면 마운트하지 않음");
  assert.equal(replayReady(undefined, "2026-10-16"), false);

  // A 데이터, B 날짜인 경우 (A의 ±12h context로 B를 초기화하지 않도록 차단)
  assert.equal(replayReady("2026-10-15", "2026-10-16"), false, "A 데이터, B 날짜이면 리플레이를 마운트하지 않음");

  // B 데이터 도착 후
  assert.equal(replayReady("2026-10-16", "2026-10-16"), true, "B 데이터 도착 시 마운트 준비 완료");

  // 늦게 끝난 이전 A 조회가 B 결과를 덮어쓴 경우 (aroundDate가 A로 변경됨)
  assert.equal(replayReady("2026-10-15", "2026-10-16"), false, "늦게 끝난 A 조회가 덮어써도 마운트하지 않음");

  // 2) TodayPanel/ReplayView 렌더 전환 시나리오 검증
  // A에서 B로 날짜 변경 직후: aroundDate="2026-10-15", date="2026-10-16" -> 마운트 안 됨
  const isMountedBeforeLoad = replayReady("2026-10-15", "2026-10-16");
  assert.equal(isMountedBeforeLoad, false, "B 조회 완료 전에는 ReplayView를 마운트하지 않음");

  // B 조회 완료 후: aroundDate="2026-10-16", date="2026-10-16" -> 마운트 됨
  const isMountedAfterLoad = replayReady("2026-10-16", "2026-10-16");
  assert.equal(isMountedAfterLoad, true, "B 조회 완료 후 ReplayView 마운트됨");

  // 3) 55차 검수: 비동기 완료 순서 역전 시뮬레이션
  // 날짜 A 조회 시작 -> 날짜 B로 변경 -> B 조회 완료(마운트) -> 뒤늦게 A 조회 완료 시 버림 검증
  let genCounter = 0;
  let aroundDateState: string | null = null;
  const triggerLoad = (targetDate: string) => {
    const gen = ++genCounter;
    return {
      apply: () => {
        if (!isLatestLoad(gen, genCounter)) return false;
        aroundDateState = targetDate;
        return true;
      },
    };
  };

  const loadA = triggerLoad("2026-10-15");
  const loadB = triggerLoad("2026-10-16");

  // B 조회가 먼저 완료되어 상태 반영
  const appliedB = loadB.apply();
  assert.equal(appliedB, true);
  assert.equal(aroundDateState, "2026-10-16");
  assert.equal(replayReady(aroundDateState, "2026-10-16"), true, "B 조회 완료 시 리플레이 열림");

  // 늦게 끝난 A 조회가 도착했지만 버려짐
  const appliedA = loadA.apply();
  assert.equal(appliedA, false, "늦게 끝난 A 조회는 상태를 덮어쓰지 않고 버려져야 함");
  assert.equal(aroundDateState, "2026-10-16", "상태는 여전히 B로 보존");
  assert.equal(replayReady(aroundDateState, "2026-10-16"), true, "리플레이가 닫히지 않고 계속 유지됨");
}

// 항목 2 검수: 주간·월간·연간 이동 리플레이
{
  // 1) 기간 경계 클리핑: 시작 전 날 밤 머묾이 start 시각으로 클리핑됨
  const nightCommit = [loc("night", -120, 60, 0.28, 0.01)]; // start 0 기준 -120분 ~ +60분
  const periodRep = buildReplay(nightCommit, 0, 7 * DAY);
  assert.equal(periodRep.stops.length, 1);
  assert.equal(periodRep.stops[0].start, 0, "기간 시작 전 날 밤 머묾의 시작은 start 시각(0)으로 잘려야 함");
  assert.equal(periodRep.stops[0].end, 60 * M);
  assert.equal(periodRep.stops[0].outside, false);

  // 2) secPerWeight 상한 검증 (MAX_PLAY_SEC = 60)
  assert.equal(MAX_PLAY_SEC, 60, "MAX_PLAY_SEC은 60초여야 함");
  assert.equal(replaySecPerWeight(10), 0.5, "total이 작을 때는 기본 PLAY_SEC_PER_WEIGHT(0.5)");
  assert.equal(replaySecPerWeight(600), 0.1, "total이 크면 MAX_PLAY_SEC / total = 60 / 600 = 0.1");
  assert.equal(replaySecPerWeight(0), 0.5, "total이 0이면 기본 속도");

  // 3) 다일 라벨 형식 및 시각 포맷 검증
  // 시각 포맷: 일일은 HH:mm, 다일은 MM.DD HH:mm
  const testTime = new Date("2026-10-15T14:30:00").getTime();
  assert.equal(formatReplayClock(testTime, false), "14:30", "일일 시각은 HH:mm");
  assert.equal(formatReplayClock(testTime, true), "10.15 14:30", "다일 시각은 MM.DD HH:mm");

  // 라벨 포맷: 일일은 시간 목록, 다일은 이름 N회
  assert.equal(formatPlaceLabel("대전역", ["09:00–10:00", "12:00–13:00"], 2, false), "대전역 09:00–10:00, 12:00–13:00");
  assert.equal(formatPlaceLabel("대전역", ["09:00–10:00"], 5, true), "대전역 5회", "다일일 때는 '이름 N회'");
}

// UX2 항목 2: ReplayButton 공용 컴포넌트 렌더링 검증
{
  const hasDisabledAttr = (html: string) => /<button[^>]*\sdisabled[\s=>]/.test(html);

  // 1) 기본 상태 렌더링
  const defaultHtml = renderToStaticMarkup(createElement(ReplayButton, { onClick: () => {} }));
  assert.ok(defaultHtml.includes("▶ 이동 리플레이"), "기본 문구 확인");
  assert.ok(!hasDisabledAttr(defaultHtml), "기본 상태는 disabled 속성 없음");

  // 2) 로딩 상태 렌더링
  const loadingHtml = renderToStaticMarkup(createElement(ReplayButton, { onClick: () => {}, loading: true }));
  assert.ok(loadingHtml.includes("불러오는 중..."), "로딩 문구 확인");
  assert.ok(hasDisabledAttr(loadingHtml), "로딩 시 disabled 속성 있음");

  // 3) disabled 상태 렌더링
  const disabledHtml = renderToStaticMarkup(createElement(ReplayButton, { onClick: () => {}, disabled: true }));
  assert.ok(hasDisabledAttr(disabledHtml), "disabled prop 반영 확인");
}

// UX4 항목 2: 이동 리플레이 속도 개선 검증
{
  // 1) 거리 기반 구간 weight: 짧은 구간 < 긴 구간, 끊김 0.5, 범위 [0.15, 1.5]
  const shortWeight = calcLegWeight(0.05, false); // 50m
  const mediumWeight = calcLegWeight(1.0, false); // 1km
  const longWeight = calcLegWeight(9.0, false);   // 9km
  const brokenWeight = calcLegWeight(10.0, true);

  assert.ok(shortWeight < mediumWeight, "짧은 이동(50m)이 1km 이동보다 가중치가 작아야 함");
  assert.ok(mediumWeight < longWeight, "1km 이동이 9km 이동보다 가중치가 작아야 함");
  assert.equal(shortWeight, 0.15, "0.05km는 하한 0.15로 clamp");
  assert.equal(longWeight, 1.5, "9km는 상한 1.5로 clamp");
  assert.equal(brokenWeight, 0.5, "끊긴 구간은 기존처럼 0.5");

  // 2) 기간별 상한: 하루 60초, 주 75초, 월·연 90초
  assert.equal(REPLAY_MAX_PLAY_SEC.day, 60);
  assert.equal(REPLAY_MAX_PLAY_SEC.week, 75);
  assert.equal(REPLAY_MAX_PLAY_SEC.month, 90);
  assert.equal(maxPlaySecForPeriod(1 * DAY), 60, "하루 전체 상한 60초");
  assert.equal(maxPlaySecForPeriod(7 * DAY), 75, "주간 전체 상한 75초");
  assert.equal(maxPlaySecForPeriod(30 * DAY), 90, "월간 전체 상한 90초");
  assert.equal(maxPlaySecForPeriod(365 * DAY), 90, "연간 전체 상한 90초");

  // 3) 배속 순환 순수 함수: 1x -> 2x -> 4x -> 1x
  assert.equal(nextReplaySpeed(1), 2);
  assert.equal(nextReplaySpeed(2), 4);
  assert.equal(nextReplaySpeed(4), 1);

  // 4) advanceReplay 순수 함수 및 배속 변경 전이 함수(changeReplaySpeed) 검증
  // (a) speed 1 -> 2 -> 4 -> 1 순환 시 진행 위치(progress) 보존 검증 (화면과 동일한 순수 전이 함수 사용)
  const initialP = 0.5;
  const state1x: ReplayPlaybackState = { speed: 1, progress: initialP };
  const state2x = changeReplaySpeed(state1x);
  assert.equal(state2x.speed, 2, "1x -> 2x 배속 변경");
  assert.equal(state2x.progress, initialP, "배속 변경 시 진행 위치(progress)가 정확히 보존되어야 함");

  const state4x = changeReplaySpeed(state2x);
  assert.equal(state4x.speed, 4, "2x -> 4x 배속 변경");
  assert.equal(state4x.progress, initialP, "4x 변경 시에도 progress 보존");

  const stateLoop1x = changeReplaySpeed(state4x);
  assert.equal(stateLoop1x.speed, 1, "4x -> 1x 순환");
  assert.equal(stateLoop1x.progress, initialP, "1x 순환 시에도 progress 보존");

  // (b) 다음 dt 증가량 2배 검증
  const dt = 0.2;
  const secPerWeight = 1.0;
  const total = 10.0;
  const adv1x = advanceReplay(initialP, dt, 1, secPerWeight, total);
  const adv2x = advanceReplay(initialP, dt, 2, secPerWeight, total);
  const delta1x = adv1x.nextProgress - initialP;
  const delta2x = adv2x.nextProgress - initialP;
  assert.equal(Math.abs(delta1x - (dt * 1) / secPerWeight) < 1e-9, true, "1x 증가량");
  assert.equal(Math.abs(delta2x - (dt * 2) / secPerWeight) < 1e-9, true, "2x 증가량");
  assert.equal(Math.abs(delta2x - delta1x * 2) < 1e-9, true, "배속 2배 시 다음 dt 증가량도 정확히 2배여야 함");
  assert.equal(adv1x.reachedEnd, false);

  // (c) total 도달 시 정지 및 clamp 검증
  const advEnd = advanceReplay(9.9, dt, 2, secPerWeight, total);
  assert.equal(advEnd.nextProgress, total, "total 초과 진행 시 total로 clamp");
  assert.equal(advEnd.reachedEnd, true, "total 도달 시 reachedEnd=true (정지 플래그)");

  // 5) ReplayView 렌더링 시 배속 버튼 및 aria-label 존재 확인
  const viewHtml = renderToStaticMarkup(createElement(ReplayView, {
    commits: [loc("a", 60, 120), loc("b", 180, 240, 0.30)],
    start: 0,
    end: DAY,
    periodKey: "2026-10-15",
    onClose: () => {},
  }));
  assert.ok(viewHtml.includes("1×"), "초기 렌더링 시 1× 배속 버튼이 표시되어야 함");
  assert.ok(viewHtml.includes('aria-label="재생 배속 1×"'), "배속 버튼에 aria-label이 있어야 함");
}

console.log("replay checks passed");


