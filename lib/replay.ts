import type { Commit } from "../types/commit";
import { LOCATION_GAP_MS } from "./processor/utils";
import { locationRuns, STAY_MIN_SEC } from "./today";
import { haversineDistance } from "./geo";

/** A place in the day's route, clipped to the day unless it is an outside leg endpoint. */
export type ReplayStop = { lat: number; lng: number; start: number; end: number; stay: boolean; geofence: string | null; outside: boolean };
/** A move between consecutive stops. broken: no fixes for over LOCATION_GAP_MS (phone off / collection stopped) -
 *  drawn as a gap, never as a path, since nothing is known about the way taken. */
export type ReplayLeg = { from: number; to: number; broken: boolean; fStart: number; fEnd: number };

/** 이동 구간(leg) weight 계산 상수 */
export const REPLAY_LEG_BROKEN_WEIGHT = 0.5;
export const REPLAY_LEG_MIN_WEIGHT = 0.15;
export const REPLAY_LEG_MAX_WEIGHT = 1.5;

/** 이동 거리(km) 기반 구간 weight 계산: 짧은 이동 0.15 ~ 긴 이동 1.5, 끊김은 0.5 */
export function calcLegWeight(km: number, broken: boolean): number {
  if (broken) return REPLAY_LEG_BROKEN_WEIGHT;
  if (!Number.isFinite(km) || km <= 0) return REPLAY_LEG_MIN_WEIGHT;
  const raw = Math.sqrt(km) / 2;
  return Math.min(REPLAY_LEG_MAX_WEIGHT, Math.max(REPLAY_LEG_MIN_WEIGHT, raw));
}

/** 기간별 리플레이 전체 재생 상한(초) 상수 */
export const REPLAY_MAX_PLAY_SEC = {
  day: 60,
  week: 75,
  month: 90,
  year: 90,
} as const;

/** 기간 길이(ms)에 따른 전체 상한(초) 계산 */
export function maxPlaySecForPeriod(spanMs: number): number {
  const days = spanMs / 86_400_000;
  if (days <= 1.5) return REPLAY_MAX_PLAY_SEC.day;
  if (days <= 8) return REPLAY_MAX_PLAY_SEC.week;
  return REPLAY_MAX_PLAY_SEC.month;
}

/** 재생 배속 순환 (1x -> 2x -> 4x -> 1x) */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];
export function nextReplaySpeed(current: ReplaySpeed): ReplaySpeed {
  if (current === 1) return 2;
  if (current === 2) return 4;
  return 1;
}

export interface ReplayPlaybackState {
  speed: ReplaySpeed;
  progress: number;
}

/**
 * 배속 버튼 클릭 시 상태 전이 순수 함수:
 * speed는 nextReplaySpeed(s)로 순환(1x -> 2x -> 4x -> 1x)하고,
 * 진행 위치(progress)는 그대로 보존한다.
 */
export function changeReplaySpeed(current: ReplayPlaybackState): ReplayPlaybackState {
  return {
    speed: nextReplaySpeed(current.speed),
    progress: current.progress,
  };
}

/**
 * 리플레이 진행 진행도(progress) 순수 전이 계산 함수.
 * ReplayView의 requestAnimationFrame 루프 및 배속 변경 검증에 공용으로 사용.
 * p + (dt * speed) / secPerWeight 계산 후 total 도달 시 total로 고정 및 reachedEnd=true 반환.
 */
export function advanceReplay(
  progress: number,
  dt: number,
  speed: number,
  secPerWeight: number,
  total: number
): { nextProgress: number; reachedEnd: boolean } {
  const step = (dt * speed) / (secPerWeight > 0 ? secPerWeight : 1);
  const next = progress + step;
  if (next >= total) {
    return {
      nextProgress: total,
      reachedEnd: true,
    };
  }
  return {
    nextProgress: next,
    reachedEnd: false,
  };
}

/**
 * The day's route from LOCATION commits (raw events are purged after 7 days; commits stay). Jitter within a stay
 * collapses into one stop (runs: 150 m / LOCATION_GAP_MS, the same rule as the summary's places). Pass the commits
 * around the day too (TodayPanel's +-12 h) so a stay across midnight keeps its whole run before clipping.
 */
export function buildReplay(commits: Commit[], dayStart: number, dayEnd: number): { stops: ReplayStop[]; legs: ReplayLeg[] } {
  const runs = locationRuns(commits);
  const selected = new Set<number>();
  const fullLegs: ReplayLeg[] = [];
  runs.forEach((r, i) => { if (r.start <= dayEnd && r.end >= dayStart) selected.add(i); });
  for (let i = 0; i < runs.length - 1; i++) {
    const from = runs[i], to = runs[i + 1];
    if (from.end <= dayEnd && to.start >= dayStart) {
      selected.add(i); selected.add(i + 1);
      const span = to.start - from.end;
      const fraction = (time: number) => span > 0 ? Math.min(1, Math.max(0, (time - from.end) / span)) : 0;
      fullLegs.push({ from: i, to: i + 1, broken: span > LOCATION_GAP_MS,
        fStart: fraction(dayStart), fEnd: span > 0 ? fraction(dayEnd + 1) : 1 });
    }
  }
  const ids = [...selected].sort((a, b) => a - b);
  const index = new Map(ids.map((id, i) => [id, i]));
  const stops = ids.map((id) => {
    const r = runs[id], outside = r.end < dayStart || r.start > dayEnd;
    return { lat: r.lat, lng: r.lng, start: outside ? r.start : Math.max(r.start, dayStart),
      end: outside ? r.end : Math.min(r.end, dayEnd), outside,
      stay: !outside && r.end - r.start >= STAY_MIN_SEC * 1000, geofence: r.first.geofenceName };
  });
  const legs = fullLegs.map((l) => ({ ...l, from: index.get(l.from)!, to: index.get(l.to)! }));
  return { stops, legs };
}

/**
 * Playback steps: each stop then the leg after it, with compressed lengths so a night at home does not take most of the
 * animation (a stay: 1 + log2 of its hours + 1, a pass-through: 0.3; a move: distance-based weight, a gap: 0.5).
 */
export function replaySteps({ stops, legs }: { stops: ReplayStop[]; legs: ReplayLeg[] }) {
  const steps: { kind: "stop" | "leg"; index: number; weight: number }[] = [];
  const legByFrom = new Map(legs.map((leg, i) => [leg.from, i]));
  stops.forEach((s, i) => {
    if (!s.outside) steps.push({ kind: "stop", index: i, weight: 0 });
    const legIndex = legByFrom.get(i);
    if (legIndex !== undefined) {
      const leg = legs[legIndex];
      const from = stops[leg.from];
      const to = stops[leg.to];
      const km = from && to ? haversineDistance(from.lat, from.lng, to.lat, to.lng) / 1000 : 0;
      steps.push({ kind: "leg", index: legIndex, weight: calcLegWeight(km, leg.broken) });
    }
  });
  return steps;
}

/** The replay clock can pass through an unknown gap, but its marker has no known position there. */
export function playheadAt(replay: { stops: ReplayStop[]; legs: ReplayLeg[] }, steps: ReturnType<typeof replaySteps>, progress: number) {
  let elapsed = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (progress >= elapsed + step.weight && i < steps.length - 1) { elapsed += step.weight; continue; }
    const f = step.weight === 0 ? 1 : Math.min(1, Math.max(0, (progress - elapsed) / step.weight));
    if (step.kind === "stop") {
      const s = replay.stops[step.index];
      return { i, f, time: s.start + f * (s.end - s.start), point: { lat: s.lat, lng: s.lng } };
    }
    const leg = replay.legs[step.index], from = replay.stops[leg.from], to = replay.stops[leg.to];
    const position = leg.fStart + f * (leg.fEnd - leg.fStart);
    return { i, f, time: from.end + position * (to.start - from.end), point: leg.broken ? null : {
      lat: from.lat + position * (to.lat - from.lat), lng: from.lng + position * (to.lng - from.lng) } };
  }
  return { i: -1, f: 0, time: replay.stops[0]?.start ?? 0, point: null };
}

/** Replay playback animation speed (seconds of wall time per unit of step weight) */
export const PLAY_SEC_PER_WEIGHT = 0.5;

/** Maximum replay wall duration in seconds (capped for multi-day periods, default day) */
export const MAX_PLAY_SEC = REPLAY_MAX_PLAY_SEC.day;

/** Computes wall seconds per weight unit, capped so total playback does not exceed maxPlaySec */
export function replaySecPerWeight(total: number, maxPlaySec: number = MAX_PLAY_SEC): number {
  if (total <= 0) return PLAY_SEC_PER_WEIGHT;
  return Math.min(PLAY_SEC_PER_WEIGHT, maxPlaySec / total);
}

/** Formats clock time for the replay display (HH:mm for single day, MM.DD HH:mm for multi-day) */
export function formatReplayClock(time: number, isMultiDay: boolean): string {
  const d = new Date(time);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (!isMultiDay) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${mo}.${da} ${hh}:${mm}`;
}

/** Formats place label (time list for single day, '이름 N회' for multi-day) */
export function formatPlaceLabel(name: string, times: string[], count: number, isMultiDay: boolean): string {
  if (isMultiDay) {
    return `${name} ${count}회`;
  }
  return `${name} ${times.slice(0, 2).join(", ")}${times.length > 2 ? ` 외 ${times.length - 2}` : ""}`;
}

/**
 * Initial replay state:
 * - Opens as autoplay (progress = 0, playing = true) if there is at least 1 step, total > 0, and not reduced-motion.
 * - Otherwise (reduced-motion, or no steps / total == 0), starts paused at the overview (progress = total, playing = false).
 */
export function initialReplayState({
  total,
  stepCount,
  reducedMotion,
}: {
  total: number;
  stepCount: number;
  reducedMotion: boolean;
}): { progress: number; playing: boolean } {
  if (stepCount > 0 && total > 0 && !reducedMotion) {
    return { progress: 0, playing: true };
  }
  return { progress: total, playing: false };
}

/**
 * Determines whether replay playback state should be initialized.
 * Replay is initialized once per periodKey when stepCount > 0.
 * In-day step additions (new locations today) do not re-initialize playback.
 */
export function shouldInitReplay({
  initializedForDate,
  periodKey,
  stepCount,
}: {
  initializedForDate: string | null;
  periodKey: string;
  stepCount: number;
}): boolean {
  return stepCount > 0 && initializedForDate !== periodKey;
}

/**
 * Determines whether replay data is ready for the requested period/date.
 * Prevents mounting ReplayView with stale context from another date/period.
 */
export function replayReady(aroundKey: string | null | undefined, periodKey: string): boolean {
  return Boolean(aroundKey && aroundKey === periodKey);
}


