// Separate file: TZ must be set before any Date use, and today.check asserts dayRange in the machine's zone.
process.env.TZ = "America/New_York";
import assert from "node:assert/strict";
import { dayRange, shiftDate } from "./today";

// round 32: 24 h steps stalled on the 25-h fall-back day and skipped the 23-h spring-forward day
assert.equal(shiftDate("2026-11-01", 1), "2026-11-02", "next from the fall-back day");
assert.equal(shiftDate("2026-11-02", -1), "2026-11-01");
assert.equal(shiftDate("2026-03-09", -1), "2026-03-08", "previous across spring-forward (was 03-07)");
assert.equal(shiftDate("2026-03-08", 1), "2026-03-09");
assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
const { start, end } = dayRange("2026-11-01");
assert.equal(end + 1 - start, 25 * 3600_000, "the fall-back day is 25 h");
console.log("dst checks passed");
