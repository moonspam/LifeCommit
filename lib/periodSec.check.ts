import assert from "node:assert/strict";
import { openInitialised } from "./sqliteTestDb";
import { periodSec, PERIOD_ROWS_SQL, PERIOD_SEC_SQL, periodRowsParams, periodSecParams } from "./periodSec";
import { dayRange, summarizeDay } from "./today";
import type { Commit } from "../types/commit";

// A session crossing midnight is one row; each day counts its share, the shares add up to the whole.
(async () => {
  const day1 = dayRange("2026-10-06"), day2 = dayRange("2026-10-07");
  const M = day2.start, H = 3_600_000;
  const cross = { startedAt: M - 10 * H, endedAt: M + 2 * H, durationSec: 12 * 3600 };
  assert.equal(periodSec(cross, day1.start, day1.end), 10 * 3600);
  assert.equal(periodSec(cross, day2.start, day2.end), 2 * 3600);
  const inside = { startedAt: M - 5 * H, endedAt: M - 4 * H, durationSec: 3500 }; // duration_sec need not equal the span
  assert.equal(periodSec(inside, day1.start, day1.end), 3500, "a row inside the period counts exactly as before");
  assert.equal(periodSec(inside, day2.start, day2.end), 0);
  const memo = { startedAt: M - H, endedAt: M - H, durationSec: 0 };
  assert.equal(periodSec({ ...memo, durationSec: 60 }, day1.start, day1.end), 60, "zero-span rows: by their start");
  assert.equal(periodSec({ ...memo, durationSec: 60 }, day2.start, day2.end), 0);
  assert.equal(periodSec({ startedAt: M, endedAt: M + H, durationSec: 3600 }, day1.start, day1.end), 0, "starting exactly at midnight: next day");

  // the SQL fragment gives the same numbers on real SQLite, and the row filter keeps exactly the overlapping rows
  const { d } = await openInitialised();
  const ins = (id: string, pkg: string, c: { startedAt: number; endedAt: number; durationSec: number }) =>
    d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES (?,1,'s',?,?,?,?,'APP_USAGE',1)")
      .run(id, c.startedAt, c.endedAt, c.durationSec, pkg);
  ins("cross", "a", cross); ins("inside", "b", inside); ins("memo", "c", { ...memo, durationSec: 60 }); ins("later", "d", { startedAt: M + 5 * H, endedAt: M + 6 * H, durationSec: 3600 });
  const sums = (r: { start: number; end: number }) => Object.fromEntries((d.prepare(
    `SELECT app_package p, SUM(${PERIOD_SEC_SQL}) s FROM commits WHERE ${PERIOD_ROWS_SQL} GROUP BY app_package ORDER BY p`)
    .all(...periodSecParams(r.start, r.end), ...periodRowsParams(r.start, r.end)) as { p: string; s: number }[]).map((x) => [x.p, x.s]));
  assert.deepEqual(sums(day1), { a: 36000, b: 3500, c: 60 });
  assert.deepEqual(sums(day2), { a: 7200, d: 3600 });

  // TODAY: a session crossing midnight is listed on both days and summarized with its share
  const commit = (p: Partial<Commit>): Commit => ({ id: "x", branchId: 1, parentId: null, subject: "s", body: null, authorTag: null, startedAt: 0, endedAt: 0,
    durationSec: 0, appPackage: "com.example.a", eventType: "APP_USAGE", squashedEvents: [], geofenceName: null, lat: null, lng: null, createdAt: 0, ...p });
  const c = commit(cross);
  assert.equal(summarizeDay([c], day1).activitySec, 36000);
  assert.equal(summarizeDay([c], day2).activitySec, 7200);
  assert.equal(summarizeDay([c], day2).topApps[0].durationSec, 7200);
  // round 19: a 1 s session split 0.5 s / 0.5 s at midnight counts 1 s in total (not 1 + 1)
  const tiny = { startedAt: M - 500, endedAt: M + 500, durationSec: 1 };
  assert.equal(periodSec(tiny, day1.start, day1.end) + periodSec(tiny, day2.start, day2.end), 1);

  // fuzz: random rows (duration_sec != span too) cut into random contiguous periods - TS == SQL per period, and every
  // row's shares add up to exactly duration_sec
  {
    const { d: f } = await openInitialised();
    let seed = 7; const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let k = 0; k < 300; k++) {
      const s0 = 1_791_000_000_000 + rnd(10_000_000), span = 1 + rnd(30_000_000), dur = rnd(40_000);
      const row = { startedAt: s0, endedAt: s0 + span, durationSec: dur };
      f.exec("DELETE FROM commits");
      f.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES ('r',1,'s',?,?,?,'a','APP_USAGE',1)").run(s0, s0 + span, dur);
      const cuts = [s0 - 1 - rnd(1000)];
      while (cuts[cuts.length - 1] < s0 + span) cuts.push(cuts[cuts.length - 1] + 1 + rnd(span));
      let total = 0;
      for (let i = 0; i + 1 < cuts.length; i++) {
        const p0 = cuts[i], p1 = cuts[i + 1] - 1; // inclusive end, contiguous
        const ts = periodSec(row, p0, p1);
        const sql = (f.prepare(`SELECT COALESCE(SUM(${PERIOD_SEC_SQL}), 0) s FROM commits WHERE ${PERIOD_ROWS_SQL}`).get(...periodSecParams(p0, p1), ...periodRowsParams(p0, p1)) as { s: number }).s;
        assert.equal(sql, ts, `row ${k} period ${i}: SQL ${sql} vs TS ${ts}`);
        assert.ok(Number.isInteger(ts) && ts >= 0);
        total += ts;
      }
      assert.equal(total, dur, `row ${k}: shares add up to duration_sec`);
    }
  }
  console.log("period share checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
