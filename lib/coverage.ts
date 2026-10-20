/**
 * Step 6e: which parts of a day are "수집 확인 불가" (collection could not be confirmed). Healthy collection shows
 * nothing - there is no "no activity" verdict. Pure; the TODAY panel feeds it.
 */
export type CoverageRow = { from: number; to: number; reason: string | null };
export type CollectStatus = { permitted: boolean; lastFailure: string | null };
export type Gap = { from: number; to: number; reason: string | null };

/** Carried state is trusted for this long (native COVER_GAP_MS); a tail longer than it is flagged. */
export const COVER_GAP_MS = 24 * 3600_000;

/** Every reason the native store or the sync can produce, and the uncaused hole (null). Words "무활동"/"유실" are banned. */
export const REASON_LABEL: Record<string, string> = {
  cold_start: "수집 시작 직후",
  stale_state: "오래 수집되지 않음",
  clock: "시계 변경",
  query_failed: "조회 실패",
  permission: "사용 기록 권한 없음",
  store_corrupt: "수집 상태 복구",
  write_failed: "수집 저장 실패",
  store_unavailable: "수집 저장소 오류",
  sync_failed: "동기화 실패",
  unknown: "원인 미상",
};
/**
 * Coverage rows overlapping [start, end] AND the first/last coverage ever, in ONE statement (one read snapshot): read
 * separately, a drain extending a row in between would make the gap between the two reads look like a hole.
 * The first result row is the extent (NULLs in the row columns), then one row per overlapping coverage row.
 */
export const COVERAGE_SQL = `SELECT NULL AS from_ms, NULL AS to_ms, NULL AS reason, MIN(from_ms) AS first_start, MAX(to_ms) AS last_end FROM usage_coverage
 UNION ALL SELECT from_ms, to_ms, reason, NULL, NULL FROM usage_coverage WHERE from_ms <= ? AND to_ms >= ?`;
export const coverageParams = (start: number, end: number) => [end, start];
export function parseCoverage(values: any[]): { rows: CoverageRow[]; firstStart: number | null; lastEnd: number | null } {
  const [ext, ...rest] = values;
  return { rows: rest.map((r) => ({ from: r.from_ms, to: r.to_ms, reason: r.reason ?? null })), firstStart: ext?.first_start ?? null, lastEnd: ext?.last_end ?? null };
}

/**
 * The collector has not warmed up yet: the latest processed window is still cold (first run, reset, fallback) and it
 * stays so until the device's first screen-off/keyguard event (StatefulSessionizer). The TODAY card then asks the
 * user to turn the screen off once; the hint goes away by itself on the next drain after that.
 */
export const awaitingScreenOff = (rows: CoverageRow[], lastEnd: number | null) =>
  lastEnd != null && rows.some((r) => r.to === lastEnd && r.reason === "cold_start");

export const reasonLabel = (r: string | null) => REASON_LABEL[r ?? "unknown"] ?? REASON_LABEL.unknown;

/**
 * @param day [start, end] (end inclusive, like dayRange)
 * @param rows coverage rows overlapping the day
 * @param firstStart earliest coverage from_ms ever (null = none): nothing before it is judged (pre-Step-6 data,
 *   restored history from elsewhere)
 * @param lastEnd latest coverage to_ms ever: after it is the not-yet-processed tail
 */
export function coverageGaps(a: { day: { start: number; end: number }; now: number; rows: CoverageRow[];
  firstStart: number | null; lastEnd: number | null; status: CollectStatus }): Gap[] {
  if (a.firstStart == null || a.lastEnd == null) return [];
  const lo = Math.max(a.day.start, a.firstStart);
  const hi = Math.min(a.day.end + 1, a.now);
  if (lo >= hi) return [];
  const clip = (f: number, t: number) => [Math.max(f, lo), Math.min(t, hi)] as const;
  const out: Gap[] = [];
  // 1. markers with a reason (zero-length ones, e.g. clock, have no range)
  for (const r of a.rows) {
    if (r.reason == null) continue;
    const [f, t] = clip(r.from, r.to);
    if (t > f) out.push({ from: f, to: t, reason: r.reason });
  }
  // 2. holes between rows, before the tail (defensive: a failed run does not move the cursor, so the next run covers it)
  const spans = a.rows.map((r) => clip(r.from, r.to)).filter(([f, t]) => t > f).sort((x, y) => x[0] - y[0]);
  let at = lo;
  const holesEnd = Math.min(hi, a.lastEnd);
  for (const [f, t] of spans) {
    if (f > at && at < holesEnd) out.push({ from: at, to: Math.min(f, holesEnd), reason: null });
    at = Math.max(at, t);
  }
  if (at < holesEnd) out.push({ from: at, to: holesEnd, reason: null });
  // 3. the tail after the last processed point: flagged only when collection is not healthy now
  const tailFrom = Math.max(lo, a.lastEnd);
  if (tailFrom < hi) {
    const reason = !a.status.permitted ? "permission" : a.status.lastFailure ?? (a.now - a.lastEnd > COVER_GAP_MS ? "stale_state" : null);
    if (reason) out.push({ from: tailFrom, to: hi, reason });
  }
  // merge touching gaps with the same reason
  out.sort((x, y) => x.from - y.from);
  const merged: Gap[] = [];
  for (const g of out) {
    const last = merged[merged.length - 1];
    if (last && last.reason === g.reason && g.from <= last.to) last.to = Math.max(last.to, g.to);
    else merged.push({ ...g });
  }
  return merged;
}
