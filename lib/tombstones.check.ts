import assert from "node:assert/strict";
// @ts-expect-error node:sqlite typings need @types/node >= 22 (runtime is Node 24)
import { DatabaseSync } from "node:sqlite";
import * as schema from "./schema";
import { deleteCommitWithTombstone, USAGE_INSERT_SQL, usageInsertParams } from "./tombstones";
import { collectBackup, restoreBackup } from "./backupTables";

// Real SQLite with the production schema, every production trigger and foreign_keys ON.
type Row = Record<string, unknown>;
export const openDb = () => {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(schema.BASE_TABLES_SCHEMA);
  for (const [k, v] of Object.entries(schema)) if (k !== "BASE_TABLES_SCHEMA") for (const sql of [v].flat()) d.exec(sql as string);
  return d;
};
const ins = (d: ReturnType<typeof openDb>, id: string, parent: string | null) =>
  d.prepare("INSERT INTO commits (id, branch_id, parent_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES (?,1,?,?,1,1,1,'manual',1)").run(id, parent, `s-${id}`);

// 1. deleting a commit that is another commit's parent re-links the child (git-style) instead of failing on the FK
{
  const d = openDb();
  ins(d, "G", null); ins(d, "P", "G"); ins(d, "C", "P");
  d.prepare("DELETE FROM commits WHERE id = ?").run("P");
  assert.equal((d.prepare("SELECT parent_id FROM commits WHERE id = 'C'").get() as Row).parent_id, "G");
  d.prepare("DELETE FROM commits WHERE parent_id IS NULL").run(); // a root with children: they become roots
  assert.equal((d.prepare("SELECT parent_id FROM commits WHERE id = 'C'").get() as Row).parent_id, null);
  d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
}

const adapt = (d: ReturnType<typeof openDb>) => ({
  async query(sql: string, v: unknown[] = []) { return { values: (d.prepare(sql).all(...(v as never[])) as Row[]).map((r) => ({ ...r })) }; },
  async run(sql: string, p: unknown[]) { d.prepare(sql).run(...(p as never[])); },
});
const ids = (d: ReturnType<typeof openDb>) => (d.prepare("SELECT id FROM commits ORDER BY id").all() as Row[]).map((r) => r.id);
const tombs = (d: ReturnType<typeof openDb>) => (d.prepare("SELECT id FROM commit_tombstones ORDER BY id").all() as Row[]).map((r) => r.id);
const MAIN = { id: 1, name: "main", color: "#f1e05a", created_at: 1 };

async function main() {
  // 2. tombstone + delete are one unit: a failure on the DELETE (inside the caller's transaction) leaves no tombstone
  {
    const d = openDb();
    ins(d, "X", null);
    const db = adapt(d);
    const failing = { ...db, async run(sql: string, p: unknown[]) { if (sql.startsWith("DELETE FROM commits")) throw new Error("injected"); return db.run(sql, p); } };
    d.exec("BEGIN");
    try { await deleteCommitWithTombstone(failing, "X", 10); d.exec("COMMIT"); } catch { d.exec("ROLLBACK"); }
    assert.deepEqual(tombs(d), []);
    assert.deepEqual(ids(d), ["X"]);
    await deleteCommitWithTombstone(db, "X", 10);
    assert.deepEqual(ids(d), []);
    assert.deepEqual(tombs(d), ["X"]);
  }
  // 3. delete X, then restore an old backup that still contains X: X stays gone (tombstone wins)
  {
    const src = openDb();
    ins(src, "X", null); ins(src, "Y", null);
    const oldBackup = JSON.parse(JSON.stringify(await collectBackup(adapt(src), null)));
    delete oldBackup.tombstones; // a backup from before tombstones existed
    const d = openDb();
    ins(d, "X", null);
    await deleteCommitWithTombstone(adapt(d), "X", 10);
    assert.equal(await restoreBackup(adapt(d), oldBackup), 1, "only Y counts as restored");
    assert.deepEqual(ids(d), ["Y"]);
    d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
  }
  // 4. a tombstone in the file removes the target's copy of that commit
  {
    const d = openDb();
    ins(d, "X", null); ins(d, "Z", "X");
    await restoreBackup(adapt(d), { version: 4, branches: [MAIN], tombstones: [{ id: "X", deleted_at: 5 }], commits: [] });
    assert.deepEqual(ids(d), ["Z"]);
    assert.deepEqual(tombs(d), ["X"]);
    d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
  }
  // 5. usage collection skips tombstoned ids and still inserts the others (and stays idempotent)
  {
    const d = openDb();
    d.prepare("INSERT INTO commit_tombstones (id, deleted_at) VALUES ('us:a:1', 1)").run();
    const db = adapt(d);
    for (const s of [{ pkg: "a", startMs: 1, endMs: 5 }, { pkg: "b", startMs: 2, endMs: 6 }, { pkg: "b", startMs: 2, endMs: 6 }]) {
      await db.run(USAGE_INSERT_SQL, usageInsertParams(`us:${s.pkg}:${s.startMs}`, 1, `feat: ${s.pkg} 사용`, s.startMs, s.endMs, s.pkg, 9));
    }
    assert.deepEqual(ids(d), ["us:b:2"]);
  }
  // 7. tombstones in backups: v5 round-trips its range; a v4 file does not erase existing ranges; a file's usage
  //    tombstone at the edge widens the span, so a re-collected copy of that deleted session is replaced, not revived
  {
    const src = openDb();
    src.prepare("INSERT INTO commit_tombstones (id, deleted_at, app_package, started_at, ended_at) VALUES ('us:a:5000', 5, 'a', 5000, 6000)").run();
    const v5 = JSON.parse(JSON.stringify(await collectBackup(adapt(src), null)));
    assert.equal(v5.version, 5);
    const usage = (id: string, s: number, e: number) => ({ id, branch_id: 1, parent_id: null, subject: id, started_at: s, ended_at: e, duration_sec: 1, app_package: "a", event_type: "APP_USAGE", created_at: 1, squashed_events: "[]" });
    const d = openDb();
    d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES ('us:a:5284',1,'s',5284,6284,1,'a','APP_USAGE',1)").run();
    d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES ('us:a:9000',1,'s',9000,9500,1,'a','APP_USAGE',1)").run();
    await restoreBackup(adapt(d), { ...v5, commits: [usage("us:a:100", 100, 1000)] });
    assert.deepEqual(ids(d), ["us:a:100", "us:a:9000"], "the shifted copy of the deleted session is gone, later rows kept");
    await restoreBackup(adapt(d), { version: 4, branches: [MAIN], tombstones: [{ id: "us:a:5000", deleted_at: 5 }], commits: [] });
    assert.deepEqual({ ...(d.prepare("SELECT app_package, started_at, ended_at FROM commit_tombstones WHERE id = 'us:a:5000'").get() as Row) },
      { app_package: "a", started_at: 5000, ended_at: 6000 });
  }
    // 6. deletes stay index-driven: the FK child lookup / relink UPDATE must use idx_commits_parent (20k-row full delete: 6.6 s without, 40 ms with)
  {
    const d = openDb();
    const plan = (d.prepare("EXPLAIN QUERY PLAN UPDATE commits SET parent_id = NULL WHERE parent_id = 'x'").all() as Row[]).map((r) => String(r.detail)).join(" | ");
    assert.match(plan, /USING (COVERING )?INDEX idx_commits_parent/, plan);
  }
  console.log("tombstone checks passed");
}
main();
