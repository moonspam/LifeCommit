import assert from "node:assert/strict";
import { periodStart, shiftPeriodStart, periodWindow } from "./period";

const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
assert.equal(ymd(periodStart("week", new Date(2026, 9, 4, 15))), "2026-9-28"); // Sunday -> previous Monday
assert.equal(ymd(periodStart("week", new Date(2026, 9, 5, 0, 0))), "2026-10-5"); // Monday itself
assert.equal(ymd(periodStart("week", new Date(2026, 0, 1))), "2025-12-29"); // crosses year boundary
assert.equal(ymd(periodStart("month", new Date(2026, 9, 31))), "2026-10-1");
assert.equal(ymd(periodStart("year", new Date(2026, 9, 31))), "2026-1-1");
assert.equal(periodStart("today", new Date(2026, 9, 4, 23, 59)).getHours(), 0);

// navigation: shift from the period start, never overflow
assert.equal(ymd(shiftPeriodStart("month", periodStart("month", new Date(2026, 0, 31)), 1)), "2026-2-1");
assert.equal(ymd(shiftPeriodStart("month", new Date(2026, 2, 1), -1)), "2026-2-1");
assert.equal(ymd(shiftPeriodStart("month", new Date(2026, 0, 1), -1)), "2025-12-1"); // year boundary
assert.equal(ymd(shiftPeriodStart("year", new Date(2026, 0, 1), -1)), "2025-1-1");
assert.equal(ymd(shiftPeriodStart("week", periodStart("week", new Date(2026, 0, 1)), 1)), "2026-1-5"); // week spanning New Year
assert.equal(ymd(shiftPeriodStart("week", new Date(2026, 9, 5), -1)), "2026-9-28");
{
  const now = new Date(2026, 9, 4, 12);
  const cur = periodWindow("month", new Date(2026, 9, 1), now);
  assert.equal(cur.end, now.getTime()); // current period ends now
  assert.equal(cur.canNext, false);
  const past = periodWindow("month", new Date(2026, 8, 1), now);
  assert.equal(past.end, new Date(2026, 9, 1).getTime() - 1); // Sep 30 23:59:59.999
  assert.equal(past.canNext, true);
}
console.log("period checks passed");
