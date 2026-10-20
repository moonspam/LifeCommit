import assert from "node:assert/strict";
import { openInitialised } from "./sqliteTestDb";
import { writeSetting, NOISE_FILTER_SETTING } from "./settings";
import { deleteCommitWithTombstone } from "./tombstones";
import { restoreBackup } from "./backupTables";
import { initSchema } from "./schemaInit";
import { chooseSeed, readProcessedMark, epochAction, advanceDbEpoch, readUsageEpoch, drainBatch, wipeRecordsToNewEpoch, usageCommitId, type UsageBatch } from "./usageDrain";

type Row = Record<string, unknown>;
const ready = async () => {
  const r = await openInitialised();
  await writeSetting(r.adapter, NOISE_FILTER_SETTING, "com.filtered.app");
  return r;
};
const count = (d: any, sql: string) => Number((d.prepare(sql).get() as Row).n);
const sess = (seq: number, pkg: string, startMs: number, endMs: number) => ({ type: "session" as const, seq, pkg, label: null, startMs, endMs });
const cov = (seq: number, fromMs: number, toMs: number, reason: string | null = null) => ({ type: "coverage" as const, seq, fromMs, toMs, reason });

(async () => {
  // epochAction: all three branches
  assert.deepEqual(epochAction(3, 1), { kind: "native_reset", target: 3 });
  assert.deepEqual(epochAction(1, 4), { kind: "db_advance", target: 4 });
  assert.deepEqual(epochAction(2, 2), { kind: "none" });

  // a fresh DB starts at epoch 0; advancing is monotonic
  {
    const { adapter } = await ready();
    assert.equal(await readUsageEpoch(adapter), 0);
    await advanceDbEpoch(adapter, 5);
    await advanceDbEpoch(adapter, 2);
    assert.equal(await readUsageEpoch(adapter), 5);
  }

  // a stale batch writes nothing
  {
    const { d, adapter } = await ready();
    await advanceDbEpoch(adapter, 2);
    const r = await drainBatch(adapter, { epoch: 1, upToSeq: 2, items: [sess(1, "a", 1000, 5000), cov(2, 0, 9000)] }, 1);
    assert.deepEqual(r, { stale: true, inserted: 0 });
    assert.equal(count(d, "SELECT COUNT(*) n FROM commits"), 0);
    assert.equal(count(d, "SELECT COUNT(*) n FROM usage_coverage"), 0);
  }

  // filtered and tombstoned sessions are skipped, their coverage is still recorded; re-draining changes nothing
  {
    const { d, adapter } = await ready();
    d.prepare("INSERT INTO commit_tombstones (id, deleted_at) VALUES (?, 1)").run(usageCommitId("deleted.app", 3000));
    const batch: UsageBatch = { epoch: 0, upToSeq: 5, items: [
      sess(1, "a.app", 1000, 2000), sess(2, "com.filtered.app", 2000, 2500), sess(3, "deleted.app", 3000, 4000),
      sess(4, "com.samsung.knox.securefolder", 4000, 5000), cov(5, 0, 10_000)] };
    assert.deepEqual(await drainBatch(adapter, batch, 1), { stale: false, inserted: 1 });
    const snap = () => JSON.stringify([d.prepare("SELECT id FROM commits ORDER BY id").all(), d.prepare("SELECT * FROM usage_coverage").all()]);
    const once = snap();
    assert.deepEqual((d.prepare("SELECT id FROM commits").all() as Row[]).map((r) => r.id), ["us:a.app:1000"]);
    assert.equal(count(d, "SELECT COUNT(*) n FROM usage_coverage WHERE from_ms = 0 AND to_ms = 10000"), 1);
    assert.deepEqual(await drainBatch(adapter, batch, 2), { stale: false, inserted: 0 });
    assert.equal(snap(), once, "re-drain is idempotent");
  }

  // back-to-back processed ranges merge into one row; a reason marker stays separate; re-drain changes nothing
  {
    const { d, adapter } = await ready();
    const items = Array.from({ length: 100 }, (_, i) => cov(i + 1, i * 60_000, (i + 1) * 60_000));
    const batch: UsageBatch = { epoch: 0, upToSeq: 101, items: [...items, cov(101, 6_000_000, 6_060_000, "stale_state")] };
    await drainBatch(adapter, batch, 1);
    const rows = () => d.prepare("SELECT from_ms, to_ms, reason FROM usage_coverage ORDER BY from_ms").all() as Row[];
    assert.deepEqual(rows().map((r) => [r.from_ms, r.to_ms, r.reason]), [[0, 6_000_000, null], [6_000_000, 6_060_000, "stale_state"]]);
    const before = JSON.stringify(rows());
    await drainBatch(adapter, batch, 2);
    assert.equal(JSON.stringify(rows()), before);
  }

  // reset db confirm: records wiped, settings kept, epoch above both sides
  {
    const { d, adapter } = await ready();
    await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(1, "a.app", 1000, 2000), cov(2, 0, 3000)] }, 1);
    d.prepare("INSERT INTO commit_tombstones (id, deleted_at) VALUES ('x', 1)").run();
    await advanceDbEpoch(adapter, 2);
    assert.equal(await wipeRecordsToNewEpoch(adapter, 4), 5);
    assert.equal(await readUsageEpoch(adapter), 5);
    for (const t of ["commits", "raw_events", "commit_tombstones", "usage_coverage"]) assert.equal(count(d, `SELECT COUNT(*) n FROM ${t}`), 0, t);
    assert.equal(count(d, "SELECT COUNT(*) n FROM app_settings"), 1);
    assert.equal(await wipeRecordsToNewEpoch(adapter, 0), 6, "db ahead: still +1");
  }
  // a marker for a range that was already processed is kept (reviewer's case); re-draining changes nothing
  {
    const { d, adapter } = await ready();
    await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [cov(1, 100, 200)] }, 1);
    const b2: UsageBatch = { epoch: 0, upToSeq: 2, items: [cov(2, 100, 200, "cold_start")] };
    await drainBatch(adapter, b2, 1);
    const rows = () => (d.prepare("SELECT from_ms, to_ms, reason FROM usage_coverage ORDER BY reason").all() as Row[]).map((r) => [r.from_ms, r.to_ms, r.reason]);
    assert.deepEqual(rows(), [[100, 200, null], [100, 200, "cold_start"]]);
    await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [cov(1, 100, 200), ...b2.items] }, 2);
    assert.equal(rows().length, 2);
  }

  // no timestamp matching on the drain (round 11 #1): A and a shifted copy-shaped B' (same length, 84 ms overlap) are
  // both stored, also when A was deleted (its range tombstone is informational only)
  {
    const { d, adapter } = await ready();
    await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 10_000, 12_000)] }, 1);
    assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 11_916, 13_916)] }, 2), { stale: false, inserted: 1 });
    await deleteCommitWithTombstone(adapter, "us:a.app:10000", 5);
    d.prepare("DELETE FROM commits WHERE id = 'us:a.app:11916'").run();
    assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 3, items: [sess(3, "a.app", 11_916, 13_916)] }, 3), { stale: false, inserted: 1 });
    assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 4, items: [sess(4, "a.app", 10_000, 12_000)] }, 4), { stale: false, inserted: 0 }, "id tombstone still blocks");
  }

  // round 10 #1: a 1 ms overlap with a different session is stored
  {
    const { adapter } = await ready();
    await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 0, 10_000)] }, 1);
    assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 9_999, 100_000)] }, 2), { stale: false, inserted: 1 });
  }

  // a usage delete records its range (informational), a memo's tombstone stays id-only
  {
    const { d, adapter } = await ready();
    await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_000, 3_000)] }, 1);
    d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES ('memo',1,'m',1,1,1,'manual',1)").run();
    await deleteCommitWithTombstone(adapter, "us:a.app:1000", 5);
    await deleteCommitWithTombstone(adapter, "memo", 5);
    assert.deepEqual(d.prepare("SELECT id, app_package, started_at, ended_at FROM commit_tombstones ORDER BY id").all().map((r: any) => ({ ...r })),
      [{ id: "memo", app_package: null, started_at: null, ended_at: null }, { id: "us:a.app:1000", app_package: "a.app", started_at: 1_000, ended_at: 3_000 }]);
  }

  // seed = processed mark (round 12 #3): it never goes back - not on a partial drain, a delete or a restore
  {
    const base = { install: 100, legacy: null, processedTo: 0 };
    assert.equal(chooseSeed({ ...base, epoch: 0, legacy: 900 }), 900, "upgrade: the old JS cursor");
    assert.equal(chooseSeed({ ...base, epoch: 0, legacy: 900, processedTo: 7_000 }), 7_000, "epoch 0 with a later mark: the mark");
    assert.equal(chooseSeed({ ...base, epoch: 0 }), 100, "fresh install");
    assert.equal(chooseSeed({ ...base, epoch: 2, legacy: 900 }), 100, "after a reset: re-backfill from install, not the old cursor");
    const { d, adapter } = await ready();
    // reviewer's state: coverage ends at 100, then a partial drain of sessions up to 5995 (its coverage still queued)
    await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [cov(1, 0, 100)] }, 1);
    await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 5_000, 5_995)] }, 2);
    assert.equal(await readProcessedMark(adapter), 5_995);
    await deleteCommitWithTombstone(adapter, "us:a.app:5000", 3);
    assert.equal(await readProcessedMark(adapter), 5_995, "a delete does not lower it");
    await drainBatch(adapter, { epoch: 0, upToSeq: 3, items: [sess(3, "com.filtered.app", 6_000, 8_000)] }, 4);
    assert.equal(await readProcessedMark(adapter), 8_000, "a filtered item was processed too");
    await drainBatch(adapter, { epoch: 0, upToSeq: 4, items: [cov(4, 0, 3_000)] }, 5);
    assert.equal(await readProcessedMark(adapter), 8_000, "an older item never lowers it");
    await wipeRecordsToNewEpoch(adapter, 0);
    assert.equal(await readProcessedMark(adapter), 0, "reset: start over");
  }

  // restore vs the native queue (contract, handoff 16): restore replaces the STORED usage rows of the file's period once;
  // whatever the device drains afterwards merges by id; deletion intent lives only in id tombstones (from the file or
  // the DB), never in a row being absent from a backup
  {
    const main = [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }];
    const fileRow = (pkg: string, s: number, e: number) => ({ id: `us:${pkg}:${s}`, branch_id: 1, parent_id: null, subject: "f", started_at: s, ended_at: e,
      duration_sec: 1, app_package: pkg, event_type: "APP_USAGE", created_at: 1, squashed_events: "[]" });
    const file = (rows: object[], tombstones: object[] = []) => ({ version: 5, branches: main, commits: rows, tombstones });
    const rows = (d: any) => (d.prepare("SELECT id FROM commits ORDER BY id").all() as Row[]).map((r) => r.id);

    // same-device backup, no rewrite: a session drained after the restore has the file row's id -> merged, one row
    {
      const { d, adapter } = await ready();
      await restoreBackup(adapter, file([fileRow("a.app", 1_000, 3_000)]));
      assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_000, 3_000)] }, 1), { stale: false, inserted: 0 });
      assert.deepEqual(rows(d), ["us:a.app:1000"]);
    }
    // round 15 #1 with the file's tombstone: A deleted in the backup stays deleted when native confirms it later
    {
      const { d, adapter } = await ready();
      await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_000, 2_000)] }, 1);
      await restoreBackup(adapter, file([fileRow("b.app", 0, 2_200)], [{ id: "us:a.app:1000", deleted_at: 5 }]));
      assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 1_000, 2_000)] }, 2), { stale: false, inserted: 0 });
      assert.deepEqual(rows(d), ["us:b.app:0"]);
    }
    // round 15 #1 without a tombstone (another device, or A pending at export): the device observed A -> stored, intended
    {
      const { d, adapter } = await ready();
      await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_000, 2_000)] }, 1);
      await restoreBackup(adapter, file([fileRow("b.app", 0, 2_200)]));
      assert.deepEqual(rows(d), ["us:b.app:0"], "the stored row was replaced");
      assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 1_000, 2_000)] }, 2), { stale: false, inserted: 1 });
    }
    // the documented order case (bound: what native held at the restore - one sync interval of queue, a candidate of
    // <= 2 s, the open session): a session absent from the file, inside its period -> gone if drained before, kept after
    {
      const f = file([fileRow("b.app", 0, 5_000)]);
      const q: UsageBatch = { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_000, 2_000)] };
      const before = await ready(); await drainBatch(before.adapter, q, 1); await restoreBackup(before.adapter, f);
      const after = await ready(); await restoreBackup(after.adapter, f); await drainBatch(after.adapter, q, 1);
      assert.deepEqual(rows(before.d), ["us:b.app:0"]);
      assert.deepEqual(rows(after.d), ["us:a.app:1000", "us:b.app:0"]);
    }
    // round 12 #2 relabelled: a shifted copy [1284,3284) of the file's [1000,3000) drained after the restore -> both stored.
    // That needs a timestamp rewrite: rewrite contract (handoff 13 A)
    {
      const { d, adapter } = await ready();
      await restoreBackup(adapter, file([fileRow("a.app", 1_000, 3_000)]));
      await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [sess(1, "a.app", 1_284, 3_284)] }, 1);
      assert.deepEqual(rows(d), ["us:a.app:1000", "us:a.app:1284"]);
    }
    // regressions: round 13 #1 (queued A outside the period stored, mark unchanged by restore and by the next start) and
    // round 14 #1 (a future-dated period does not block new usage)
    {
      const { adapter } = await ready();
      await drainBatch(adapter, { epoch: 0, upToSeq: 1, items: [cov(1, 0, 10_000)] }, 1);
      await restoreBackup(adapter, file([fileRow("b.app", 50_000, 55_000)]));
      assert.equal(await readProcessedMark(adapter), 10_000);
      await initSchema(adapter);
      assert.equal(await readProcessedMark(adapter), 10_000);
      assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 2, items: [sess(2, "a.app", 20_000, 30_000)] }, 2), { stale: false, inserted: 1 });
      const H = 3_600_000;
      await restoreBackup(adapter, file([fileRow("b.app", 0, 24 * H)]));
      assert.deepEqual(await drainBatch(adapter, { epoch: 0, upToSeq: 3, items: [sess(3, "c.app", 10 * H, 11 * H)] }, 3), { stale: false, inserted: 1 });
    }
  }

  // rounds 16/17: a session is ONE row (us:<pkg>:<start>) across midnight; a zone change cannot change its identity
  {
    const H = 3_600_000;
    const D7 = Date.UTC(2026, 9, 7);
    const S = D7 - 10 * H, E = D7 + 2 * H; // crosses midnight in UTC and in +9 alike
    const q = (seq: number): UsageBatch => ({ epoch: 0, upToSeq: seq, items: [sess(seq, "a.app", S, E)] });
    const hours = (d: any) => Number((d.prepare("SELECT COALESCE(SUM(ended_at - started_at), 0) t FROM commits").get() as Row).t) / H;
    const ids = (d: any) => (d.prepare("SELECT id FROM commits ORDER BY id").all() as Row[]).map((r) => r.id);
    // stored once, re-read later (any zone: the drain no longer depends on it) -> one row, 12 h
    {
      const { d, adapter } = await ready();
      await drainBatch(adapter, q(1), 1);
      assert.deepEqual(ids(d), [`us:a.app:${S}`]);
      assert.deepEqual(await drainBatch(adapter, q(2), 2), { stale: false, inserted: 0 });
      assert.equal(hours(d), 12);
    }
    // deleted, then re-read -> not revived
    {
      const { d, adapter } = await ready();
      await drainBatch(adapter, q(1), 1);
      await deleteCommitWithTombstone(adapter, `us:a.app:${S}`, 5);
      assert.deepEqual(await drainBatch(adapter, q(2), 2), { stale: false, inserted: 0 });
      assert.deepEqual(ids(d), []);
    }
    // round 17 #1, ACCEPTED (pre-release data only): a backup from a midnight-splitting build holding only the first
    // part; the whole session re-read later keeps that id -> the missing tail stays missing (no extend rule)
    {
      const { d, adapter } = await ready();
      d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES (?,1,'s',?,?,1,'a.app','APP_USAGE',1)").run(`us:a.app:${S}`, S, D7);
      assert.deepEqual(await drainBatch(adapter, q(1), 1), { stale: false, inserted: 0 });
      assert.equal(hours(d), 10);
    }
  }

  // a missing usage_state row does not freeze the epoch
  {
    const { d, adapter } = await ready();
    d.prepare("DELETE FROM usage_state").run();
    assert.equal(await wipeRecordsToNewEpoch(adapter, 0), 1);
    assert.equal(await readUsageEpoch(adapter), 1);
  }
  console.log("usage drain checks passed");
})().catch((e) => { console.error(e); process.exit(1); });
