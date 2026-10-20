import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { coverageGaps, REASON_LABEL, COVER_GAP_MS, awaitingScreenOff } from "./coverage";
import { dayRange } from "./today";

const H = 3_600_000;
const day = dayRange("2026-10-07");
const D = day.start;
const ok = { permitted: true, lastFailure: null };
const base = { day, now: D + 20 * H, firstStart: D - 48 * H, lastEnd: D + 20 * H, status: ok };

// healthy: processed all day -> nothing
assert.deepEqual(coverageGaps({ ...base, rows: [{ from: D - H, to: D + 20 * H, reason: null }] }), []);
// a marker crossing midnight is clipped to the day
assert.deepEqual(coverageGaps({ ...base, rows: [{ from: D - 2 * H, to: D + H, reason: "cold_start" }, { from: D + H, to: D + 20 * H, reason: null }] }),
  [{ from: D, to: D + H, reason: "cold_start" }]);
// nothing before the first coverage ever (pre-Step-6 data / restored history)
assert.deepEqual(coverageGaps({ ...base, firstStart: D + 5 * H, rows: [{ from: D + 5 * H, to: D + 20 * H, reason: null }] }), []);
assert.deepEqual(coverageGaps({ ...base, firstStart: null, lastEnd: null, rows: [] }), []);
// a hole between rows (defensive) is flagged without a cause
assert.deepEqual(coverageGaps({ ...base, rows: [{ from: D - H, to: D + 3 * H, reason: null }, { from: D + 4 * H, to: D + 20 * H, reason: null }] }),
  [{ from: D + 3 * H, to: D + 4 * H, reason: null }]);
// a zero-length clock marker has no range
assert.deepEqual(coverageGaps({ ...base, rows: [{ from: D - H, to: D + 20 * H, reason: null }, { from: D + 9 * H, to: D + 9 * H, reason: "clock" }] }), []);
// the tail (after the last processed point): nothing when healthy, flagged otherwise
const tailRows = [{ from: D - H, to: D + 10 * H, reason: null }];
const tail = { ...base, lastEnd: D + 10 * H, rows: tailRows };
assert.deepEqual(coverageGaps(tail), []);
assert.deepEqual(coverageGaps({ ...tail, status: { permitted: false, lastFailure: null } }), [{ from: D + 10 * H, to: D + 20 * H, reason: "permission" }]);
assert.deepEqual(coverageGaps({ ...tail, status: { permitted: true, lastFailure: "query_failed" } }), [{ from: D + 10 * H, to: D + 20 * H, reason: "query_failed" }]);
const old = { ...tail, now: D + 10 * H + COVER_GAP_MS + 1, lastEnd: D + 10 * H };
assert.deepEqual(coverageGaps(old), [{ from: D + 10 * H, to: day.end + 1, reason: "stale_state" }], "a long silence is flagged even when the last run was fine");
// adjacent gaps with the same reason merge
assert.deepEqual(coverageGaps({ ...base, rows: [{ from: D, to: D + H, reason: "cold_start" }, { from: D + H, to: D + 2 * H, reason: "cold_start" }, { from: D + 2 * H, to: D + 20 * H, reason: null }] }),
  [{ from: D, to: D + 2 * H, reason: "cold_start" }]);

// every reason the native code or the sync can emit has a label
const kt = readdirSync("android/app/src/main/java/com/lifecommit/app").filter((f) => f.endsWith(".kt"))
  .map((f) => readFileSync(join("android/app/src/main/java/com/lifecommit/app", f), "utf8")).join("\n");
const emitted = new Set([...kt.matchAll(/(?:reason|lastFailure) = "([a-z_]+)"/g)].map((m) => m[1]));
const sync = readFileSync("lib/usageSync.ts", "utf8");
for (const m of sync.matchAll(/lastFailure: "([a-z_]+)"/g)) emitted.add(m[1]);
const syncList = sync.match(/SYNC_FAILURES = \[([^\]]*)\]/);
assert.ok(syncList, "usageSync lists its failure reasons");
for (const m of syncList![1].matchAll(/"([a-z_]+)"/g)) emitted.add(m[1]);
assert.ok(emitted.has("permission") && emitted.has("sync_failed"), [...emitted].join());
assert.ok(emitted.size >= 6, [...emitted].join());
for (const r of emitted) assert.ok(REASON_LABEL[r], `no label for reason ${r}`);
// screen-off hint: only while the latest window is still cold
assert.equal(awaitingScreenOff([{ from: 0, to: 100, reason: "cold_start" }], 100), true, "fresh install: hint");
assert.equal(awaitingScreenOff([{ from: 0, to: 100, reason: "cold_start" }, { from: 100, to: 500, reason: null }], 500), false, "warmed up: no hint");
assert.equal(awaitingScreenOff([{ from: 0, to: 100, reason: "cold_start" }], 900), false, "latest row not in view (other day): no hint");
assert.equal(awaitingScreenOff([{ from: 0, to: 100, reason: "stale_state" }], 100), false);
assert.equal(awaitingScreenOff([], null), false);
// banned words in UI strings (comments excluded)
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|json)$/.test(f) ? [p] : []; });
for (const f of [...walk("components"), ...walk("app"), "lib/coverage.ts"]) {
  const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/무활동|유실/.test(code), `banned wording in ${f}`);
}
// the coverage read: one statement the read guard accepts; rows + extent, also on a day without rows
import("./sqlGuard").then(async ({ isPlainSelect }) => {
  const { COVERAGE_SQL, coverageParams, parseCoverage } = await import("./coverage");
  assert.ok(isPlainSelect(COVERAGE_SQL), "the read guard must accept the coverage query (getDB rejects otherwise)");
  const { openInitialised } = await import("./sqliteTestDb");
  const { d } = await openInitialised();
  d.exec("INSERT INTO usage_coverage VALUES ('a', 100, 1000, NULL), ('b', 1000, 1100, 'cold_start'), ('c', 5000, 9000, NULL)");
  const read = (s: number, e: number) => parseCoverage(d.prepare(COVERAGE_SQL).all(...coverageParams(s, e)) as any[]);
  assert.deepEqual(read(900, 1050), { rows: [{ from: 100, to: 1000, reason: null }, { from: 1000, to: 1100, reason: "cold_start" }], firstStart: 100, lastEnd: 9000 });
  assert.deepEqual(read(2000, 3000), { rows: [], firstStart: 100, lastEnd: 9000 });
  const empty = await openInitialised();
  assert.deepEqual(parseCoverage(empty.d.prepare(COVERAGE_SQL).all(...coverageParams(0, 1)) as any[]), { rows: [], firstStart: null, lastEnd: null });
  console.log("coverage checks passed");
}).catch((e) => { console.error(e); process.exit(1); });
