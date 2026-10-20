import type { Commit } from "../types/commit";
import { NOISE_PACKAGES } from "./constants";
import { LOCATION_GAP_MS, resolveAppName } from "./processor/utils";
import { haversineDistance } from "./geo";
import { periodSec } from "./periodSec";

export type TodaySummary = {
  activitySec: number;
  topApps: { pkg: string; name: string; durationSec: number }[];
  places: string[];
  calls: number;
  sms: number;
  photos: number;
  longestSession: { name: string; durationSec: number } | null;
  sentences: string[];
};

const isIdle = (commit: Commit) => commit.subject === "chore: Idle state" || commit.eventType === "MERGE";

export const dateKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function formatDuration(sec: number) {
  if (sec < 60) return `${sec}초`;
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  return hours ? `${hours}시간${minutes ? ` ${minutes}분` : ""}` : `${minutes}분`;
}

export function objectParticle(name: string) {
  const code = name.charCodeAt(name.length - 1);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? "을" : "를";
}

export function memoTimestamp(date: string, now = Date.now()) {
  const localToday = new Date(now);
  const today = `${localToday.getFullYear()}-${String(localToday.getMonth() + 1).padStart(2, "0")}-${String(localToday.getDate()).padStart(2, "0")}`;
  return date === today ? now : dayRange(date).start + 12 * 3600000;
}

/** @param range the day: a session crossing midnight counts only its share inside it (default: whole rows) */
/** A stay at least this long, outside every registered place, is named by its dong (lib/dong.ts). */
export const STAY_MIN_SEC = 10 * 60;

/**
 * Unregistered stays of STAY_MIN_SEC or more that overlap [start, end]: runs of location commits within 150 m of the
 * run's first fix, each starting at most LOCATION_GAP_MS after the previous one ended (a longer gap = collection stopped,
 * not staying). Other events (calls, SMS...) may split one stay into several commits; the run joins them. Pass commits
 * from beyond the range too (TodayPanel loads +-STAY_CONTEXT_MS): a stay split across midnight is only whole that way.
 * Returns each run's first commit.
 */
export function unregisteredStays(commits: Commit[], start = -Infinity, end = Infinity): Commit[] {
  return locationRuns(commits)
    .filter((r) => !r.first.geofenceName && r.end - r.start >= STAY_MIN_SEC * 1000 && r.start <= end && r.end >= start)
    .map((r) => r.first);
}

/** A run of location commits: one place (within 150 m of its first fix), no gap over LOCATION_GAP_MS inside. */
export type LocationRun = { first: Commit; start: number; end: number; lat: number; lng: number };

/** Runs of location commits in time order (see unregisteredStays) - shared by the summary and the replay. */
export function locationRuns(commits: Commit[]): LocationRun[] {
  const locs = commits.filter((c) => c.eventType === "LOCATION" && c.lat != null && c.lng != null).sort((a, b) => a.startedAt - b.startedAt);
  const runs: LocationRun[] = [];
  for (let i = 0; i < locs.length; ) {
    const first = locs[i];
    let last = first, j = i + 1;
    while (j < locs.length && locs[j].startedAt - last.endedAt <= LOCATION_GAP_MS
      && haversineDistance(first.lat!, first.lng!, locs[j].lat!, locs[j].lng!) <= 150) last = locs[j++];
    runs.push({ first, start: first.startedAt, end: last.endedAt, lat: first.lat!, lng: first.lng! });
    i = j;
  }
  return runs;
}

/** How far around a day TodayPanel reads location commits, so stays crossing midnight are judged whole. */
export const STAY_CONTEXT_MS = 12 * 60 * 60 * 1000;

/** `stayPlaces`: names for unregistered stays (dongs), listed after the registered places, duplicates dropped. */
export function summarizeDay(commits: Commit[], range?: { start: number; end: number }, stayPlaces: string[] = []): TodaySummary {
  const sec = (c: Commit) => (range ? periodSec(c, range.start, range.end) : c.durationSec);
  const apps = new Map<string, number>();
  const places = new Set<string>();
  let activitySec = 0;
  let calls = 0, sms = 0, photos = 0;
  let longestSession: TodaySummary["longestSession"] = null;
  for (const commit of commits) {
    if (commit.geofenceName) places.add(commit.geofenceName);
    if (commit.eventType === "CALL") calls++;
    if (commit.eventType === "SMS") sms++;
    if (commit.eventType === "PHOTO") photos++;
    if (isIdle(commit)) continue;
    if (commit.eventType === "APP_USAGE") activitySec += Math.max(0, sec(commit));
    if (commit.eventType === "APP_USAGE" && commit.appPackage && !NOISE_PACKAGES.has(commit.appPackage)) {
      apps.set(commit.appPackage, (apps.get(commit.appPackage) || 0) + sec(commit));
      if (!longestSession || sec(commit) > longestSession.durationSec) {
        longestSession = { name: resolveAppName(commit.appPackage), durationSec: sec(commit) };
      }
    }
  }
  for (const p of stayPlaces) places.add(p);
  const topApps = [...apps].sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([pkg, durationSec]) => ({ pkg, name: resolveAppName(pkg), durationSec }));
  const sentences: string[] = [];
  if (!commits.length) sentences.push("아직 기록이 없어요.");
  else {
    if (topApps[0]) sentences.push(places.size
      ? `오늘은 ${topApps[0].name}${objectParticle(topApps[0].name)} 가장 오래 썼고(${formatDuration(topApps[0].durationSec)}) ${places.size}곳을 다녀왔어요.`
      : `오늘은 ${topApps[0].name}${objectParticle(topApps[0].name)} 가장 오래 썼어요(${formatDuration(topApps[0].durationSec)}).`);
    else if (places.size) sentences.push(`오늘 ${places.size}곳을 다녀왔어요.`);
    if (calls || sms || photos) sentences.push(`통화 ${calls}건 · 문자 ${sms}건 · 사진 ${photos}장을 기록했어요.`);
    if (longestSession) sentences.push(`가장 길게 몰입한 시간은 ${longestSession.name} ${formatDuration(longestSession.durationSec)}이에요.`);
  }
  return { activitySec, topApps, places: [...places], calls, sms, photos, longestSession, sentences: sentences.slice(0, 3) };
}

/** The calendar day `days` away from "YYYY-MM-DD" (setDate, not 24 h steps: DST days are 23 or 25 h long). */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return dateKey(d);
}

export function dayRange(date: string) {
  const start = new Date(`${date}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  // inclusive end: callers use "<= end", so stop 1ms before the next day (a 00:00:00.000 session belongs to the next day)
  return { start: start.getTime(), end: end.getTime() - 1 };
}

/**
 * Determines whether a load result is from the latest request generation.
 * Stale asynchronous load results (e.g. earlier date query resolving after a later date query) are discarded.
 */
export function isLatestLoad(queryGen: number, activeGen: number): boolean {
  return queryGen === activeGen;
}
