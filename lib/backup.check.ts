import assert from "node:assert/strict";
// @ts-expect-error node:sqlite typings need @types/node >= 22 (runtime is Node 24)
import { DatabaseSync } from "node:sqlite";
import { BACKUP_TABLES, collectBackup, restoreBackup, restoredFilters } from "./backupTables";
import * as schema from "./schema";

// Real SQLite with the production schema and foreign_keys ON (a fake DB cannot show FK/UNIQUE failures).
type Row = Record<string, unknown>;
const plain = (rows: unknown) => (rows as Row[]).map((r) => ({ ...r }));
const open = () => {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  d.exec(schema.BASE_TABLES_SCHEMA);
  for (const [k, v] of Object.entries(schema)) if (k !== "BASE_TABLES_SCHEMA") for (const sql of [v].flat()) d.exec(sql as string); // production FTS + every trigger
  return {
    d,
    async query(sql: string, v: unknown[] = []) { return { values: plain(d.prepare(sql).all(...(v as never[]))) }; },
    async run(sql: string, p: unknown[]) { d.prepare(sql).run(...(p as never[])); },
  };
};
const commit = (id: string, branchId: number, startedAt: number, parent: string | null = null) => ({
  id, branch_id: branchId, parent_id: parent, subject: `s-${id}`, body: null, author_tag: null, started_at: startedAt, ended_at: startedAt,
  duration_sec: 1, app_package: null, event_type: "manual", geofence_name: null, lat: null, lng: null, created_at: 1, squashed_events: "[]",
});
const insertCommit = (db: ReturnType<typeof open>, c: Row) =>
  db.d.prepare(`INSERT INTO commits (${Object.keys(c).join(",")}) VALUES (${Object.keys(c).map(() => "?").join(",")})`).run(...(Object.values(c) as never[]));
const commitsOf = (db: ReturnType<typeof open>) => plain(db.d.prepare("SELECT c.id, c.parent_id, b.name AS branch FROM commits c JOIN branches b ON b.id = c.branch_id ORDER BY c.id").all());

async function main() {
  // 1. round trip incl. a back-dated memo whose parent (today's commit) sorts AFTER it, plus a custom branch
  const src = open();
  src.d.prepare("INSERT INTO branches (name, color, created_at) VALUES ('local-work', '#123456', 1)").run();
  const workId = (src.d.prepare("SELECT id FROM branches WHERE name = 'local-work'").get() as { id: number }).id;
  src.d.prepare("INSERT INTO app_branch_overrides (app_package, branch_id) VALUES ('com.x', ?)").run(workId);
  insertCommit(src, commit("today", 1, 2000));
  insertCommit(src, commit("memo", workId, 1000, "today"));
  const backup = JSON.parse(JSON.stringify(await collectBackup(src, "pkg.a")));
  assert.deepEqual(
    Object.keys(backup).sort(),
    ["customFilters", "exportedAt", "version", ...BACKUP_TABLES.map((t) => t.key)].sort(),
    "export keys == table list",
  );
  const dst = open();
  assert.equal(await restoreBackup(dst, backup), 2);
  assert.deepEqual(commitsOf(dst), [
    { id: "memo", parent_id: "today", branch: "local-work" },
    { id: "today", parent_id: null, branch: "main" },
  ]);
  const dstWorkId = (dst.d.prepare("SELECT id FROM branches WHERE name = 'local-work'").get() as { id: number }).id;
  assert.equal(dst.d.prepare("SELECT branch_id FROM app_branch_overrides WHERE app_package='com.x'").get()!.branch_id, dstWorkId);

  // 2. same branch id, different branch on another device: no UNIQUE failure, no relabelling of local commits
  const tgt = open();
  tgt.d.prepare("INSERT INTO branches (id, name, color, created_at) VALUES (99, 'local-work', '#111', 1)").run();
  insertCommit(tgt, commit("L", 99, 10));
  const other = open();
  other.d.prepare("INSERT INTO branches (id, name, color, created_at) VALUES (99, 'imported-holiday', '#222', 1)").run();
  other.d.prepare("INSERT INTO branches (id, name, color, created_at) VALUES (100, 'local-work', '#333', 1)").run();
  insertCommit(other, commit("H", 99, 20));
  insertCommit(other, commit("W", 100, 30));
  await restoreBackup(tgt, JSON.parse(JSON.stringify(await collectBackup(other, null))));
  const byId = Object.fromEntries(commitsOf(tgt).map((r) => [r.id as string, r.branch]));
  assert.deepEqual(byId, { L: "local-work", W: "local-work", H: "imported-holiday" });

  // 3. parent only in the target DB links; a parent missing everywhere stays null without throwing
  const t3 = open();
  insertCommit(t3, commit("P", 1, 1));
  const b3 = { version: 2, branches: [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }], commits: [commit("C1", 1, 2, "P"), commit("C2", 1, 3, "GONE")] };
  await restoreBackup(t3, b3);
  const parents = Object.fromEntries(plain(t3.d.prepare("SELECT id, parent_id FROM commits").all()).map((r) => [r.id as string, r.parent_id]));
  assert.deepEqual(parents, { P: null, C1: "P", C2: null });

  // 4. restoring the same backup twice (with a changed subject) keeps the FTS index consistent
  const t4 = open();
  const b4 = { version: 2, branches: [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }], commits: [commit("X", 1, 5), commit("Y", 1, 6)] };
  // two rows so a REPLACE of X gets a new rowid and would leave X's old FTS entry behind
  await restoreBackup(t4, b4);
  await restoreBackup(t4, { ...b4, commits: [{ ...commit("X", 1, 5), subject: "changed" }, commit("Y", 1, 6)] });
  // rank=1 also compares the index with the external content table (plain integrity-check does not)
  t4.d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
  assert.equal((t4.d.prepare("SELECT subject FROM commits WHERE id='X'").get() as Row).subject, "changed");

  // 5. settings tables merge on their natural key: target 2=Office,3=Gym + backup 2=Gym -> both survive
  const t5 = open();
  t5.d.exec("DELETE FROM geofences");
  t5.d.exec("INSERT INTO geofences (id, name, lat, lng) VALUES (2, 'Office', 1, 1), (3, 'Gym', 2, 2)");
  await restoreBackup(t5, { version: 2, branches: [], geofences: [{ id: 2, name: "Gym", lat: 9, lng: 9, radius_m: 150, branch_trigger: "main" }] });
  assert.deepEqual(plain(t5.d.prepare("SELECT name, lat FROM geofences ORDER BY name").all()), [{ name: "Gym", lat: 9 }, { name: "Office", lat: 1 }]);

  // 6. ambiguous branch data is rejected before anything is written
  const bad = [
    { version: 2, branches: [{ id: 7, name: "A", color: "#1", created_at: 1 }, { id: 7, name: "B", color: "#2", created_at: 1 }], commits: [commit("D1", 7, 1)] },
    { version: 2, branches: [{ id: 1, name: "main", color: "#1", created_at: 1 }], commits: [commit("D2", 9, 1)] },
    { version: 2, branches: [], commits: [commit("D3", 7, 1)] },
    { version: 2, branches: [{ id: 1, name: "A", color: "#1", created_at: 1 }, { id: 2, name: "A", color: "#2", created_at: 1 }], commits: [] },
  ];
  for (const b of bad) {
    const t6 = open();
    const before = JSON.stringify(plain(t6.d.prepare("SELECT * FROM branches ORDER BY id").all()));
    await assert.rejects(() => restoreBackup(t6, b as never));
    assert.equal(JSON.stringify(plain(t6.d.prepare("SELECT * FROM branches ORDER BY id").all())), before);
    assert.equal((t6.d.prepare("SELECT COUNT(*) AS n FROM commits").get() as Row).n, 0);
  }

  // 8. an empty natural key is rejected before anything is written
  const t8 = open();
  const before8 = (t8.d.prepare("SELECT COUNT(*) AS n FROM geofences").get() as Row).n;
  await assert.rejects(() => restoreBackup(t8, { version: 3, branches: [], geofences: [{ name: "  ", lat: 1, lng: 1 }] }), /비어 있는/);
  assert.equal((t8.d.prepare("SELECT COUNT(*) AS n FROM geofences").get() as Row).n, before8);

  // 7. filters from an old (<v3) backup lose the retired nav defaults; a v3 file keeps a deliberate maps entry
  const oldText = "com.sec.android.app.launcher\ncom.google.android.apps.maps\ncom.example.private";
  assert.equal(restoredFilters({ version: 2, customFilters: oldText }), "com.sec.android.app.launcher\ncom.example.private");
  assert.equal(restoredFilters({ version: 3, customFilters: oldText }), oldText);
  assert.equal(restoredFilters({ version: 3 }), null);
  // 9. restore replaces the file's usage period (rows starting inside [first start, last end)); named counterexamples
  {
    const us = (id: string, s: number, e: number, pkg = "a") => ({ ...commit(id, 1, s), app_package: pkg, ended_at: e, event_type: "APP_USAGE" });
    const main = [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }];
    const ids = (t: ReturnType<typeof open>) => plain(t.d.prepare("SELECT id FROM commits ORDER BY id").all()).map((r) => r.id);
    // round 10 #1 restore: DB [0,100000), file [100,1000) -> the DB row starts before the span: kept
    const a1 = open();
    insertCommit(a1, us("us:a:0", 0, 100_000));
    await restoreBackup(a1, { version: 5, branches: main, commits: [us("us:a:100", 100, 1000)] });
    assert.deepEqual(ids(a1), ["us:a:0", "us:a:100"]);
    // round 10 #1 adjacent: DB [10284,20284), file [0,10400) -> starts inside the file's period: replaced (accepted edge,
    // the file covers that period; a session still open at export is the only real loss and LifeCommit is in front then)
    const a2 = open();
    insertCommit(a2, us("us:a:10284", 10_284, 20_284));
    await restoreBackup(a2, { version: 5, branches: main, commits: [us("us:a:0", 0, 10_400)] });
    assert.deepEqual(ids(a2), ["us:a:0"]);
    // round 11 #2: DB [700,4700),[716,4716), file [1000,5000) -> both start before the span: kept; a second restore of
    // the same file changes nothing
    const a3 = open();
    insertCommit(a3, us("us:a:700", 700, 4700));
    insertCommit(a3, us("us:a:716", 716, 4716));
    const f3 = { version: 5, branches: main, commits: [us("us:a:1000", 1000, 5000)] };
    await restoreBackup(a3, f3);
    const once = ids(a3);
    await restoreBackup(a3, f3);
    assert.deepEqual(ids(a3), once);
    assert.deepEqual(once, ["us:a:1000", "us:a:700", "us:a:716"]);
    // round 11 #3 restore form: file [M-600100, M-100), DB has the shifted copy split at midnight [M-599816, M) + [M, M+184)
    // -> the 10-minute piece starts inside the span: replaced; the 184 ms piece after midnight starts after it: kept
    const M = new Date(2026, 9, 6).getTime();
    const a4 = open();
    insertCommit(a4, us(`us:a:${M - 599_816}`, M - 599_816, M));
    insertCommit(a4, us(`us:a:${M}`, M, M + 184));
    await restoreBackup(a4, { version: 5, branches: main, commits: [us(`us:a:${M - 600_100}`, M - 600_100, M - 100)] });
    assert.deepEqual(ids(a4), [`us:a:${M - 600_100}`, `us:a:${M}`]);
    // other apps inside the span are replaced too (the file covers the whole period); memos and later rows are kept
    const a5 = open();
    insertCommit(a5, us("us:l:2000", 2000, 2500, "l"));
    insertCommit(a5, commit("memo", 1, 1500));
    insertCommit(a5, us("us:a:9000", 9000, 9500));
    await restoreBackup(a5, { version: 5, branches: main, commits: [us("us:a:1000", 1000, 5000)] });
    assert.deepEqual(ids(a5), ["memo", "us:a:1000", "us:a:9000"]);
  }
  // 10. restore never deletes a non-usage commit whose id differs from the file's (round 23 #1): the backup holds
  //     photo A only, the DB holds a re-collected bundle A+B (other id, same start) - B must survive. In LifeCommit+
  //     this can leave a call / SMS / photo doubled after reset -> restore (documented; deterministic provider ids later)
  {
    const t10 = open();
    const ev = (id: string, type: string, s: number, pkg: string, extra: object = {}) => ({ ...commit(id, 1, s), event_type: type, app_package: pkg, ended_at: s + 5000, ...extra });
    insertCommit(t10, ev("recollected-bundle", "PHOTO", 1000, "com.android.camera2", { subject: "photo: A, B", squashed_events: JSON.stringify([{ fileName: "B.jpg" }]) }));
    await restoreBackup(t10, { version: 5, branches: [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }],
      commits: [ev("file-photo-a", "PHOTO", 1000, "com.android.camera2", { subject: "photo: A" })] });
    const ids = plain(t10.d.prepare("SELECT id FROM commits ORDER BY id").all()).map((r) => r.id);
    assert.deepEqual(ids, ["file-photo-a", "recollected-bundle"], "the bundle holding B is kept");
  }
  // 11. contact_tags 백업/복원:
  //     (a) 옛 백업(contact_key 없음) 복원 시 phone_number/contact_name으로 키 계산
  //     (b) 내보내기에 contact_key 포함
  //     (c) conflict 기준 contact_key 동작 (동일 contact_key는 UPDATE, 다른 키는 동명이인도 병합)
  {
    const t11 = open();
    // 옛 백업: contact_key 없음
    const legacyBackup = {
      version: 4,
      branches: [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }],
      contactTags: [
        { contact_name: "홍길동", tag: "#friends", phone_number: "010-1234-5678" },
        { contact_name: "가족", tag: "#family", phone_number: null },
      ],
      commits: [],
    };
    await restoreBackup(t11, legacyBackup);
    const restoredRows = plain(t11.d.prepare("SELECT * FROM contact_tags ORDER BY id").all());
    assert.equal(restoredRows.find((r) => r.contact_name === "홍길동")?.contact_key, "tel:01012345678");
    assert.equal(restoredRows.find((r) => r.contact_name === "가족")?.contact_key, "name:가족");

    // 내보내기 시 contact_key 포함 검증
    const exported = await collectBackup(t11, null);
    const expTags = exported.contactTags as Row[];
    assert.ok(expTags.every((r) => typeof r.contact_key === "string" && r.contact_key.length > 0));

    // 새 백업 복원 시 conflict 기준이 contact_key:
    // 같은 이름 다른 번호(동명이인)가 새 백업에 있으면 기존 행을 덮어쓰지 않고 추가됨
    const newBackup = {
      version: 5,
      branches: [{ id: 1, name: "main", color: "#f1e05a", created_at: 1 }],
      contactTags: [
        { contact_key: "tel:01099998888", contact_name: "홍길동", tag: "#work", phone_number: "010-9999-8888" },
      ],
      commits: [],
    };
    await restoreBackup(t11, newBackup);
    const allTags = plain(t11.d.prepare("SELECT * FROM contact_tags ORDER BY id").all());
    const hongs = allTags.filter((r) => r.contact_name === "홍길동");
    assert.equal(hongs.length, 2, "contact_key가 다르므로 동명이인 태그가 함께 보존됨");
  }
  console.log("backup real-sqlite checks passed");
}
main();
