/**
 * Step 6c-3 C (STEP6-DESIGN v3.1): moving the native usage queue into SQLite, and the epoch that keeps a reset and a
 * drain from mixing generations. All functions take the transaction handle `d`; callers run them inside
 * executeInTransaction(..., { requireTransaction: true }).
 */
import { noisePackages } from "./filters";
import { readSetting, NOISE_FILTER_SETTING } from "./settings";
import { USAGE_INSERT_SQL, usageInsertParams } from "./tombstones";
import { resolveAppName, resolveBranchId } from "./processor/utils";

interface Db {
  query(sql: string, params?: unknown[]): Promise<{ values?: any[] }>;
  run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown>;
}

export type UsageQueueItem =
  | { type: "session"; seq: number; pkg: string; label: string | null; startMs: number; endMs: number }
  | { type: "coverage"; seq: number; fromMs: number; toMs: number; reason: string | null };
export interface UsageBatch { epoch: number; upToSeq: number; items: UsageQueueItem[] }

/**
 * A session is ONE row, id `us:<pkg>:<sessionStart>` - zone-independent (native emits whole sessions; a crossing of
 * midnight is assigned to days at read time, lib/periodSec.ts). Re-draining or re-reading the same session cannot
 * duplicate it (OR IGNORE) or revive it (id tombstone). Rows written before this (midnight-split, pre-release builds
 * only) stay as they are.
 */
export const usageCommitId = (pkg: string, startMs: number) => `us:${pkg}:${startMs}`;

export async function readUsageEpoch(d: Pick<Db, "query">): Promise<number> {
  return Number((await d.query("SELECT epoch FROM usage_state WHERE id = 1")).values?.[0]?.epoch ?? 0);
}

/** Which side catches up. DB ahead: native was not told about a reset yet. Native ahead: the DB file was wiped. */
export function epochAction(dbEpoch: number, nativeEpoch: number):
  { kind: "none" } | { kind: "native_reset"; target: number } | { kind: "db_advance"; target: number } {
  if (dbEpoch > nativeEpoch) return { kind: "native_reset", target: dbEpoch };
  if (nativeEpoch > dbEpoch) return { kind: "db_advance", target: nativeEpoch }; // no wipe: the DB is already fresh
  return { kind: "none" };
}

/** Monotonic: never moves the epoch backwards. An upsert, so a missing row cannot freeze the epoch (and collection). */
export async function advanceDbEpoch(d: Db, target: number) {
  await d.run(`INSERT INTO usage_state (id, epoch) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch WHERE excluded.epoch > usage_state.epoch`, [target], false);
}

/**
 * Writes one peeked batch. A batch from another epoch writes nothing (a reset happened in between).
 * Sessions skip noise (built-in + saved filter, read here inside the transaction) and tombstones; coverage is recorded
 * for every item, filtered or not. Re-draining the same batch changes nothing.
 */
export async function drainBatch(d: Db, batch: UsageBatch, now: number): Promise<{ stale: boolean; inserted: number }> {
  if ((await readUsageEpoch(d)) !== batch.epoch) return { stale: true, inserted: 0 };
  const saved = await readSetting(d, NOISE_FILTER_SETTING);
  if (saved == null) throw new Error("noise filter not initialised");
  const noise = noisePackages(saved);
  let inserted = 0;
  let processed = 0;
  for (const it of batch.items) {
    processed = Math.max(processed, it.type === "session" ? it.endMs : it.toMs); // filtered/tombstoned items count too
    if (it.type === "session") {
      if (noise.has(it.pkg)) continue;
      const r: any = await d.run(USAGE_INSERT_SQL, usageInsertParams(usageCommitId(it.pkg, it.startMs), resolveBranchId(it.pkg),
        `feat: ${it.label || resolveAppName(it.pkg)} 사용`, it.startMs, it.endMs, it.pkg, now), false);
      if ((r?.changes?.changes ?? 0) > 0) inserted++;
    } else {
      await recordCoverage(d, it.fromMs, it.toMs, it.reason);
    }
  }
  await raiseProcessedMark(d, processed);
  return { stale: false, inserted };
}

/** processed_to only grows (a reset sets it back to 0). An upsert, so a missing row cannot freeze it. */
export async function raiseProcessedMark(d: Db, t: number) {
  await d.run(`INSERT INTO usage_state (id, epoch, processed_to) VALUES (1, 0, ?)
    ON CONFLICT(id) DO UPDATE SET processed_to = MAX(processed_to, excluded.processed_to)`, [t], false);
}



/**
 * A processed range (reason null) extends a processed row it touches, so an open app does not add a row per sync;
 * a marker with a reason is its own row. Ids are content-based (not seq): unique after a native store recovery too;
 * a marker's id includes its reason, so it never collides with a processed row of the same range.
 */
async function recordCoverage(d: Db, fromMs: number, toMs: number, reason: string | null) {
  if (reason == null) {
    const hit = (await d.query(
      "SELECT id FROM usage_coverage WHERE reason IS NULL AND from_ms <= ? AND to_ms >= ? ORDER BY to_ms DESC LIMIT 1", [fromMs, fromMs])).values?.[0];
    if (hit) {
      await d.run("UPDATE usage_coverage SET to_ms = MAX(to_ms, ?) WHERE id = ?", [toMs, hit.id], false);
      return;
    }
  }
  await d.run("INSERT OR IGNORE INTO usage_coverage (id, from_ms, to_ms, reason) VALUES (?, ?, ?, ?)",
    [reason == null ? `cov:${fromMs}:${toMs}` : `cov:${fromMs}:${toMs}:${reason}`, fromMs, toMs, reason], false);
}

/** End of what native processed and this DB drained; 0 = nothing (fresh or reset). A restore does not move it. */
export async function readProcessedMark(d: Pick<Db, "query">): Promise<number> {
  return Number((await d.query("SELECT processed_to FROM usage_state WHERE id = 1")).values?.[0]?.processed_to ?? 0);
}

/**
 * Seed for the first native window (used only while native has no cursor: first run, after a reset or restore, after
 * store recovery): the processed mark - or on epoch 0 the pre-Step-6 JS cursor if later (the upgrade) - so nothing
 * processed is read again; nothing processed (fresh install, after a reset) -> install time, re-backfilling what the
 * system keeps. The periodic job never seeds: without a cursor it waits for the app's sync.
 */
export function chooseSeed(c: { epoch: number; legacy: number | null; processedTo: number; install: number }): number {
  const mark = Math.max(c.processedTo, c.epoch === 0 && c.legacy != null && c.legacy > 0 ? c.legacy : 0);
  return mark > 0 ? mark : c.install;
}

/** `reset db confirm`: wipe the records and move the DB to a new epoch above both sides. Returns the target for native. */
export async function wipeRecordsToNewEpoch(d: Db, nativeEpoch: number): Promise<number> {
  const target = Math.max(await readUsageEpoch(d), nativeEpoch) + 1;
  // one run() per statement: the Android plugin drops statements joined on one line in execute(). app_settings stays.
  for (const table of ["commits", "raw_events", "commits_fts", "commit_tombstones", "usage_coverage"]) {
    await d.run(`DELETE FROM ${table}`, [], false);
  }
  await advanceDbEpoch(d, target);
  await d.run("UPDATE usage_state SET processed_to = 0 WHERE id = 1", [], false); // start over: re-backfill
  return target;
}

/**
 * After the DB FILE was deleted (resetDatabase, corruption recovery): move native past its own epoch so its old queue
 * is discarded. If this fails, the next sync advances the fresh DB to native's epoch and the old queue drains into it —
 * accepted: a reset starts over, and usage the system still keeps comes back anyway.
 */
export async function resetNativeUsageAfterFileWipe() {
  try {
    const { default: LifeCommitPlugin } = await import("../plugins/LifeCommitPlugin");
    const { epoch } = await LifeCommitPlugin.usageEpoch();
    await LifeCommitPlugin.resetUsage({ target: epoch + 1 });
  } catch (e) {
    console.warn("[usage] native reset after DB file wipe failed:", e);
  }
}
