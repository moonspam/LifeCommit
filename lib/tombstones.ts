/**
 * Deletion intent, kept apart from the sync cursor: a tombstoned commit id is never inserted again
 * (usage collection, backup restore), whatever window a later pull or an old backup covers.
 */
interface Db {
  run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown>;
}

/** Records the tombstone and deletes the commit. Call inside ONE transaction so both happen or neither. */
export async function deleteCommitWithTombstone(db: Db, id: string, now: number) {
  // a usage row also records its app + range (informational: kept so a backup's span includes a deleted edge session)
  await db.run(`INSERT INTO commit_tombstones (id, deleted_at, app_package, started_at, ended_at)
    SELECT id, ?, app_package, started_at, ended_at FROM commits WHERE id = ? AND id LIKE 'us:%' AND app_package IS NOT NULL
    ON CONFLICT(id) DO NOTHING`, [now, id], false);
  await db.run("INSERT INTO commit_tombstones (id, deleted_at) VALUES (?, ?) ON CONFLICT(id) DO NOTHING", [id, now], false);
  await db.run("DELETE FROM commits WHERE id = ?", [id], false); // children are re-linked by the commits_relink_children trigger
}

/** Usage-session insert that skips tombstoned ids; OR IGNORE keeps re-pulls idempotent. No timestamp matching: a
 * processed range is never collected again (seed = processed mark, see chooseSeed), and restore replaces its period. */
export const USAGE_INSERT_SQL = `INSERT OR IGNORE INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec,
   app_package, event_type, created_at, squashed_events)
 SELECT ?, ?, ?, ?, ?, ?, ?, 'APP_USAGE', ?, '[]'
 WHERE NOT EXISTS (SELECT 1 FROM commit_tombstones WHERE id = ?)`;

export const usageInsertParams = (id: string, branchId: number, subject: string, startMs: number, endMs: number, pkg: string, now: number) =>
  [id, branchId, subject, startMs, endMs, Math.max(1, Math.round((endMs - startMs) / 1000)), pkg, now, id];
