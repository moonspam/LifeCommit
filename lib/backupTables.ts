import { removeRetiredDefaults } from "./filters";
import { computeContactKey, rematchAuthorTags } from "./tagManager";
export { FILTERS_STORAGE_KEY } from "./filters";

/**
 * Backup table list: export and import both iterate this, so they cannot drift apart.
 * Order matters on import (FK parents first).
 */
export interface BackupTable {
  key: string;
  table: string;
  /** columns written on restore (device-local integer ids of settings tables are not restored) */
  columns: string[];
  /** natural key: rows merge on it (UPSERT), so restoring never deletes an unrelated row that shares an id */
  conflict: string;
  /** on conflict keep an existing value when the file has none (an older backup must not erase newer fields) */
  keepExisting?: boolean;
}

export const BACKUP_TABLES: BackupTable[] = [
  { key: "branches", table: "branches", columns: ["id", "name", "color", "created_at"], conflict: "name" }, // restored by name, see restoreBackup
  { key: "appBranchOverrides", table: "app_branch_overrides", columns: ["app_package", "branch_id"], conflict: "app_package" },
  { key: "geofences", table: "geofences", columns: ["name", "lat", "lng", "radius_m", "branch_trigger"], conflict: "name" },
  { key: "contactTags", table: "contact_tags", columns: ["contact_key", "contact_name", "tag", "phone_number"], conflict: "contact_key" },
  { key: "appBlacklist", table: "app_blacklist", columns: ["package", "reason"], conflict: "package" },
  // before commits: tombstone wins. app/range (v5) let a shifted re-read of a deleted usage session stay deleted
  { key: "tombstones", table: "commit_tombstones", columns: ["id", "deleted_at", "app_package", "started_at", "ended_at"], conflict: "id", keepExisting: true },
  {
    key: "commits",
    table: "commits",
    columns: [
      "id", "branch_id", "parent_id", "subject", "body", "author_tag", "started_at", "ended_at", "duration_sec",
      "app_package", "event_type", "geofence_name", "lat", "lng", "created_at", "squashed_events",
    ],
    conflict: "id",
  },
];

type Row = Record<string, unknown>;
interface Db {
  query(sql: string, values?: unknown[]): Promise<{ values?: Row[] }>;
  run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown>;
}

// 3: saved filter text no longer contains the retired navigation defaults (lib/filters.ts)
// 4: commit_tombstones included
export const BACKUP_VERSION = 5;

export async function collectBackup(db: Pick<Db, "query">, customFilters: string | null) {
  const backup: Record<string, unknown> = { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), customFilters };
  for (const t of BACKUP_TABLES) {
    const order = t.table === "commits" ? " ORDER BY started_at ASC" : "";
    backup[t.key] = (await db.query(`SELECT * FROM ${t.table}${order}`)).values || [];
  }
  return backup;
}

/**
 * The period the file's usage data covers: from the earliest start to the latest end of its usage rows and usage
 * tombstones (a deleted session at the edge must not come back). A tombstone's start comes from its v5 range or its
 * `us:<pkg>:<startMs>` id; its end only from the v5 range. Null when the file has no usage data.
 * Edges: a re-collected copy shifted to start before the span survives (at most one session); a real session that
 * starts inside the span and ends after it is replaced by the file's version.
 */
export function usageSpan(backup: Record<string, unknown>): { start: number; end: number } | null {
  const starts: number[] = [];
  const ends: number[] = [];
  for (const r of rowsOf(backup, "commits")) {
    if (!String(r.id).startsWith("us:")) continue;
    starts.push(Number(r.started_at));
    ends.push(Number(r.ended_at));
  }
  for (const t of rowsOf(backup, "tombstones")) {
    const id = String(t.id);
    if (!id.startsWith("us:")) continue;
    const s = t.started_at != null ? Number(t.started_at) : Number(id.slice(id.lastIndexOf(":") + 1));
    if (Number.isFinite(s)) starts.push(s);
    if (t.ended_at != null) ends.push(Number(t.ended_at));
  }
  if (!starts.length || !ends.length) return null;
  return { start: Math.min(...starts), end: Math.max(...ends) };
}

/** Filter text to store after a restore. Backups older than v3 still carry the retired nav defaults: strip them (a v3+ file keeps deliberate entries). */
export function restoredFilters(backup: Record<string, unknown>): string | null {
  if (typeof backup.customFilters !== "string") return null;
  return Number(backup.version) < 3 ? removeRetiredDefaults(backup.customFilters) : backup.customFilters;
}

const rowsOf = (backup: Record<string, unknown>, key: string) => (Array.isArray(backup[key]) ? (backup[key] as Row[]) : []);

/** Rejects branch data that would have to be guessed (throws before anything is written). */
export function validateBackupBranches(backup: Record<string, unknown>) {
  const branches = rowsOf(backup, "branches");
  const ids = new Set(branches.map((b) => b.id));
  const names = new Set(branches.map((b) => b.name));
  if (ids.size !== branches.length) throw new Error("백업 파일의 브랜치 id가 중복되어 복원할 수 없습니다.");
  if (names.size !== branches.length) throw new Error("백업 파일의 브랜치 이름이 중복되어 복원할 수 없습니다.");
  const refs = [...rowsOf(backup, "commits"), ...rowsOf(backup, "appBranchOverrides")];
  if (refs.length && !branches.length) throw new Error("백업 파일에 브랜치 정보가 없어 커밋의 분류를 알 수 없습니다.");
  const missing = refs.find((r) => !ids.has(r.branch_id));
  if (missing) throw new Error(`백업 파일에 없는 브랜치(id ${String(missing.branch_id)})를 참조하는 기록이 있어 복원할 수 없습니다.`);
}

/** Settings rows merge on their natural key, so an empty key would create a nameless row (throws before anything is written). */
export function validateNaturalKeys(backup: Record<string, unknown>) {
  for (const t of BACKUP_TABLES) {
    if (t.key === "commits" || t.key === "branches") continue; // commits: id is checked by the PK; branches: validateBackupBranches
    if (t.key === "contactTags") {
      // 옛 백업(contact_key 없음) 복원 시 phone_number/contact_name으로 키 계산
      for (const r of rowsOf(backup, "contactTags")) {
        if (!r.contact_key || typeof r.contact_key !== "string" || !(r.contact_key as string).trim()) {
          const name = String(r.contact_name ?? "");
          const phone = r.phone_number != null ? String(r.phone_number) : null;
          r.contact_key = computeContactKey(name, phone);
        }
      }
    }
    const bad = rowsOf(backup, t.key).find((r) => typeof r[t.conflict] !== "string" || !(r[t.conflict] as string).trim());
    if (bad) throw new Error(`백업 파일의 ${t.table} 항목에 비어 있는 ${t.conflict} 값이 있어 복원할 수 없습니다.`);
  }
}

/**
 * Restores every table in BACKUP_TABLES (merge; the only deletes are commits that a tombstone covers); returns the restored commit count. Missing keys (v1 files) are skipped.
 * Branch ids are device-local: backup branches are matched by NAME and ids remapped for commits/overrides.
 * Commits upsert on id (UPDATE keeps the FTS triggers consistent; REPLACE's implicit delete does not fire them),
 * are inserted unlinked and parents linked afterwards (foreign_keys is ON and a back-dated memo can precede its parent).
 */
export async function restoreBackup(db: Db, backup: Record<string, unknown>): Promise<number> {
  validateBackupBranches(backup);
  validateNaturalKeys(backup);
  const branchMap = new Map<unknown, number>();
  for (const b of rowsOf(backup, "branches")) {
    let id = (await db.query("SELECT id FROM branches WHERE name = ?", [b.name])).values?.[0]?.id as number | undefined;
    if (id == null) {
      await db.run("INSERT INTO branches (name, color, created_at) VALUES (?, ?, ?)", [b.name, b.color, b.created_at ?? Date.now()], false);
      id = (await db.query("SELECT id FROM branches WHERE name = ?", [b.name])).values?.[0]?.id as number;
    }
    branchMap.set(b.id, id);
  }

  let commits = 0;
  for (const t of BACKUP_TABLES) {
    if (t.key === "branches") continue;
    const cols = t.columns.join(", ");
    const marks = t.columns.map(() => "?").join(", ");
    // parent_id is linked in pass 2; leaving it out of SET keeps an existing link instead of nulling it
    const set = t.columns.filter((c) => c !== t.conflict && c !== "parent_id").map((c) => t.keepExisting ? `${c} = COALESCE(excluded.${c}, ${c})` : `${c} = excluded.${c}`).join(", ");
    const sql = `INSERT INTO ${t.table} (${cols}) VALUES (${marks}) ON CONFLICT(${t.conflict}) DO UPDATE SET ${set}`;
    let tombstoned = new Set<unknown>();
    if (t.key === "commits") {
      // tombstones (file + target) are already in place: they win over both the file's and the target's commits
      await db.run("DELETE FROM commits WHERE id IN (SELECT id FROM commit_tombstones)", [], false);
      tombstoned = new Set(((await db.query("SELECT id FROM commit_tombstones")).values || []).map((r) => r.id));
      // The file's usage period replaces the DB's: a period re-collected after a reset can carry other ids (UsageStats
      // can shift stored timestamps), and matching sessions by timestamps has no safe rule. Deterministic and idempotent.
      const span = usageSpan(backup);
      if (span) {
        const fileIds = new Set(rowsOf(backup, "commits").map((r) => r.id));
        const inSpan = (await db.query("SELECT id FROM commits WHERE id LIKE 'us:%' AND started_at >= ? AND started_at < ?", [span.start, span.end])).values || [];
        for (const { id } of inSpan) if (!fileIds.has(id)) await db.run("DELETE FROM commits WHERE id = ?", [id], false);
      }
    }
    for (const r of rowsOf(backup, t.key)) {
      if (tombstoned.has(r.id)) continue;
      const params = t.columns.map((c) => {
        if (c === "branch_id") return branchMap.get(r.branch_id)!; // validated above
        if (t.table === "commits" && c === "parent_id") return null;
        const v = r[c];
        if (v === undefined) return c === "squashed_events" ? "[]" : null;
        return v;
      });
      await db.run(sql, params, false);
      if (t.table === "commits") commits++;
    }
  }
  for (const r of rowsOf(backup, "commits")) {
    if (r.parent_id == null) continue;
    // links parents found in the file or already in the DB; a parent missing everywhere stays unlinked
    await db.run(
      "UPDATE commits SET parent_id = ? WHERE id = ? AND EXISTS (SELECT 1 FROM commits WHERE id = ?)",
      [r.parent_id, r.id, r.parent_id],
      false
    );
  }
  await rematchAuthorTags(db);
  return commits;
}
