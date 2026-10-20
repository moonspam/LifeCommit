import { executeInTransaction, getDB } from "@/lib/db";
import { readSetting, NOISE_FILTER_SETTING } from "@/lib/settings";
import { emit, EVENT_COMMITS_UPDATED, EVENT_USAGE_STATUS } from "@/lib/events";
import type { CollectStatus } from "@/lib/coverage";
import { singleFlight } from "@/lib/singleFlight";
import { loadAppBranchOverrides } from "@/lib/processor/utils";
import { advanceDbEpoch, chooseSeed, drainBatch, epochAction, readProcessedMark, readUsageEpoch } from "@/lib/usageDrain";

/** Pre-Step-6 JS cursor: read once as the seed of the very first native window (upgrade), never written or deleted. */
const LEGACY_USAGE_CURSOR_KEY = "lifecommit_usage_cursor";
const MAX_DRAIN_ROUNDS = 20;
const PEEK_MAX = 500;

/**
 * oss only: the native store collects (stateful sessionizer, its own cursor and queue); this drains its queue into
 * SQLite and confirms only after the transaction committed. Single-flight: the poll and a manual/resume sync never overlap.
 */
export const syncUsageSessions = singleFlight(syncUsageOnce);

/** Current collection status for the TODAY "수집 확인 불가" line: from the native store's lastFailure (which also
 * reflects a failed periodic run until the next collect), not from any log line. In memory only. */
let collectStatus: CollectStatus = { permitted: true, lastFailure: null };
export const getCollectStatus = () => collectStatus;
/**
 * One EVENT_USAGE_STATUS per round at most: on a change, on every round while unhealthy (TODAY reloads and the flagged
 * tail keeps reaching "now"), or when coverage may have changed (`drained`, emitted after the commits).
 */
function setCollectStatus(s: CollectStatus, drained = false) {
  const changed = s.permitted !== collectStatus.permitted || s.lastFailure !== collectStatus.lastFailure;
  collectStatus = s;
  if (changed || drained || !s.permitted || s.lastFailure != null) emit(EVENT_USAGE_STATUS);
}

/** Reasons this file can set (each has a label in lib/coverage.ts - the coverage check reads this list). */
const SYNC_FAILURES = ["write_failed", "store_unavailable", "sync_failed"];
/** Plugin rejects carry their reason as a message prefix; anything else (DB errors in catch-up or drain) is sync_failed. */
const failureReason = (e: unknown) => {
  const msg = String((e as Error)?.message ?? e ?? "");
  return SYNC_FAILURES.find((r) => r !== "sync_failed" && msg.startsWith(r)) ?? "sync_failed";
};

async function syncUsageOnce(): Promise<number> {
  // the status covers the whole round - permission check, DB, settings, catch-up, collect, drain - and is set once at
  // its end, so it does not flip and no step's failure leaves it looking healthy
  let status: CollectStatus;
  let inserted = 0;
  let drained = false;
  try {
    const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
    if (!(await LifeCommitPlugin.checkSystemPermissions()).usage) {
      setCollectStatus({ permitted: false, lastFailure: "permission" });
      return 0;
    }
    const db = getDB();
    // not a failure: the filter is seeded by useAppInit right after the DB opens; the status stays as it was
    if ((await readSetting(db, NOISE_FILTER_SETTING)) == null) return 0;

    // 1. epoch catch-up (a reset whose native half did not run, or a wiped DB file)
    const dbEpoch = await readUsageEpoch(db);
    const nativeEpoch = (await LifeCommitPlugin.usageEpoch()).epoch;
    const a = epochAction(dbEpoch, nativeEpoch);
    if (a.kind === "native_reset") await LifeCommitPlugin.resetUsage({ target: a.target });
    if (a.kind === "db_advance") await executeInTransaction((d) => advanceDbEpoch(d, a.target), { requireTransaction: true });

    // 2. collect. Every catch-up branch leaves native at >= epoch, so a reset after this point makes native skip the
    // collect (checked under its lock): the seed is never applied to another generation. The seed (chooseSeed) is used
    // only while native has no cursor and starts at what this DB already processed, so no range is read twice.
    const epoch = Math.max(dbEpoch, nativeEpoch);
    const install = (await LifeCommitPlugin.getInstallTime()).installTime ?? Date.now();
    const legacy = Number(localStorage.getItem(LEGACY_USAGE_CURSOR_KEY)) || null;
    const seedCursor = chooseSeed({ epoch, legacy, install, processedTo: await readProcessedMark(db) });
    const c = await LifeCommitPlugin.collectUsage({ seedCursor, expectedEpoch: epoch });
    if (!c.collected) return 0; // a reset landed in between: the next round re-reads both epochs
    status = { permitted: true, lastFailure: c.lastFailure };

    // 3. drain: peek -> one transaction -> confirm after commit (a crash in between re-drains idempotently)
    await loadAppBranchOverrides(db);
    for (let i = 0; i < MAX_DRAIN_ROUNDS; i++) {
      const batch = await LifeCommitPlugin.peekUsage({ max: PEEK_MAX });
      if (batch.items.length === 0) break;
      const r = await executeInTransaction((d) => drainBatch(d, batch, Date.now()), { requireTransaction: true });
      if (r.stale) break; // a reset landed in between: the next round catches the epoch up
      inserted += r.inserted;
      drained = true; // coverage may have changed even with no new rows
      if (!(await LifeCommitPlugin.confirmUsage({ epoch: batch.epoch, upToSeq: batch.upToSeq })).confirmed) break;
    }
  } catch (e) {
    console.warn("[usageSync] round failed:", e); // native state unchanged on failure; retried next round
    status = { permitted: true, lastFailure: failureReason(e) };
  }
  setCollectStatus(status, drained); // after the commits: coverage rows may have changed
  if (inserted > 0) emit(EVENT_COMMITS_UPDATED);
  return inserted;
}
