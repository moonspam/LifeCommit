/**
 * Time a commit contributes to a period [start, end] (end inclusive, as dayRange/period windows are).
 * A usage session is ONE row even across midnight (its identity is us:<pkg>:<start>); assigning it to days is done
 * here, at read time, by cumulative floors: F(t) = floor(duration_sec x (t - start) / span) with t clipped to the row,
 * and a period [a, b) gets F(b) - F(a). Shares are integers and the shares of contiguous periods always add up to
 * duration_sec (rounding each share would not: a 1 s session split 0.5/0.5 at midnight would count 1 + 1).
 * A zero-span row (memo) contributes duration_sec when it starts inside the period. A row inside a period counts
 * exactly duration_sec, as before.
 */
export function periodSec(c: { startedAt: number; endedAt: number; durationSec: number }, start: number, end: number): number {
  if (c.endedAt <= c.startedAt) return c.startedAt >= start && c.startedAt <= end ? c.durationSec : 0;
  const span = c.endedAt - c.startedAt;
  const F = (t: number) => {
    const n = c.durationSec * (Math.min(Math.max(t, c.startedAt), c.endedAt) - c.startedAt);
    return (n - (n % span)) / span; // exact integer floor (n >= 0, far below 2^53)
  };
  return F(end + 1) - F(start);
}

/** SQL for the same rule. Use `${PERIOD_ROWS_SQL}` in WHERE and `${PERIOD_SEC_SQL}` in SUM(), params via periodParams. */
export const PERIOD_ROWS_SQL = "(started_at <= ? AND (ended_at > ? OR started_at >= ?))";
// integer arithmetic throughout (SQLite '/' on integers floors for non-negative values); params cast so a REAL binding
// cannot turn MIN/MAX and the division into floating point
export const PERIOD_SEC_SQL =
  "(CASE WHEN ended_at > started_at THEN "
  + "(duration_sec * (MIN(MAX(CAST(? AS INTEGER) + 1, started_at), ended_at) - started_at)) / (ended_at - started_at) - "
  + "(duration_sec * (MIN(MAX(CAST(? AS INTEGER), started_at), ended_at) - started_at)) / (ended_at - started_at) "
  + "ELSE duration_sec END)";
export const periodRowsParams = (start: number, end: number) => [end, start, start];
export const periodSecParams = (start: number, end: number) => [end, start];
