export type Period = "today" | "week" | "month" | "year";

/** Start of the current period in local time. Weeks start on Monday. */
export function periodStart(period: Period, now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  else if (period === "month") d.setDate(1);
  else if (period === "year") d.setMonth(0, 1);
  return d;
}

/** Start of the period `delta` periods away from `start`. Computed from the period start, so month/year never overflow (Jan 31 + 1 month). */
export function shiftPeriodStart(period: Period, start: Date, delta: number): Date {
  const y = start.getFullYear(), m = start.getMonth(), d = start.getDate();
  if (period === "week") return new Date(y, m, d + 7 * delta);
  if (period === "month") return new Date(y, m + delta, 1);
  if (period === "year") return new Date(y + delta, 0, 1);
  return new Date(y, m, d + delta);
}

/** Inclusive [start, end] of the period starting at `start`; the current period ends at `now`. canNext = a later period has begun. */
export function periodWindow(period: Period, start: Date, now = new Date()) {
  const next = shiftPeriodStart(period, start, 1).getTime();
  return { start: start.getTime(), end: Math.min(next - 1, now.getTime()), canNext: next <= now.getTime() };
}

export function periodRange(period: Period, now = new Date()) {
  const { start, end } = periodWindow(period, periodStart(period, now), now);
  return { start, end };
}
