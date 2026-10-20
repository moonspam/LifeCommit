import assert from "node:assert/strict";
import { BASE_TABLES_SCHEMA } from "./schema";
import { initSchema } from "./schemaInit";
import { openRaw, openInitialised } from "./sqliteTestDb";

type Row = Record<string, unknown>;
const names = (d: ReturnType<typeof openRaw>["d"], type: string, tbl: string) =>
  (d.prepare("SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type, tbl) as Row[]).map((r) => r.name);

async function main() {
  // the schema survives the plugin's ";\n" split as one statement per chunk (a one-line multi-statement schema would fail here)
  await openInitialised();

  // legacy install: commits CHECK without MERGE/manual, carrying the old indexes, rows with a parent link
  const { d, adapter, deviceExec } = openRaw();
  const legacy = BASE_TABLES_SCHEMA.replace("'APP_USAGE','CALL','SMS','LOCATION','PHOTO','REPLY','MERGE','manual'", "'APP_USAGE','CALL','SMS','LOCATION','PHOTO','REPLY'");
  assert.notEqual(legacy, BASE_TABLES_SCHEMA, "legacy schema built");
  deviceExec(legacy);
  const ins = d.prepare("INSERT INTO commits (id, branch_id, parent_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES (?,1,?,?,?,?,1,'APP_USAGE',1)");
  ins.run("P", null, "s-P", 1, 1); ins.run("C", "P", "s-C", 2, 2);

  await initSchema(adapter);

  assert.ok(String((d.prepare("SELECT sql FROM sqlite_master WHERE name='commits'").get() as Row).sql).includes("MERGE"), "migrated");
  assert.deepEqual((d.prepare("SELECT id, parent_id FROM commits ORDER BY id").all() as Row[]).map((r) => ({ ...r })), [{ id: "C", parent_id: "P" }, { id: "P", parent_id: null }]);
  assert.deepEqual(names(d, "index", "commits"), ["idx_commits_branch", "idx_commits_parent", "idx_commits_pkg_started", "idx_commits_started", "idx_commits_type_started"], "indexes rebuilt after the table swap");
  const plan = (d.prepare("EXPLAIN QUERY PLAN UPDATE commits SET parent_id = NULL WHERE parent_id = 'x'").all() as Row[]).map((r) => String(r.detail)).join(" | ");
  assert.match(plan, /idx_commits_parent/, plan);
  assert.deepEqual(names(d, "trigger", "commits"), ["commits_ad", "commits_ai", "commits_au", "commits_relink_children"]);
  d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
  assert.equal((d.prepare("SELECT COUNT(*) AS n FROM commits_fts WHERE commits_fts MATCH 's'").get() as Row).n, 2, "migrated rows are re-indexed (FTS rebuild)");
  // round 32: the copy fails once (after RENAME + new table). The error propagates (no app on an empty commits table),
  // the rows stay in the legacy table, and the next start resumes: rows back, legacy dropped, indexes/triggers/FTS intact
  {
    const r = openRaw();
    r.deviceExec(legacy);
    const ins2 = r.d.prepare("INSERT INTO commits (id, branch_id, parent_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES (?,1,?,?,?,?,1,'APP_USAGE',1)");
    ins2.run("P", null, "s-P", 1, 1); ins2.run("C", "P", "s-C", 2, 2);
    let fail = true;
    const flaky = { ...r.adapter, run: async (sql: string, v?: unknown[]) => {
      if (fail && sql.includes("FROM commits_legacy_migration")) { fail = false; throw new Error("injected copy failure"); }
      return r.adapter.run(sql, v);
    } };
    await assert.rejects(initSchema(flaky), /injected copy failure/, "the failure reaches the caller");
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits_legacy_migration").get() as Row).n, 2, "rows kept in the legacy table");
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits").get() as Row).n, 0);
    await initSchema(r.adapter); // next start
    assert.deepEqual((r.d.prepare("SELECT id, parent_id FROM commits ORDER BY id").all() as Row[]).map((x) => ({ ...x })), [{ id: "C", parent_id: "P" }, { id: "P", parent_id: null }], "resumed");
    assert.equal(r.d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'commits_legacy_migration'").get(), undefined, "legacy dropped");
    assert.deepEqual(names(r.d, "index", "commits"), ["idx_commits_branch", "idx_commits_parent", "idx_commits_pkg_started", "idx_commits_started", "idx_commits_type_started"]);
    assert.deepEqual(names(r.d, "trigger", "commits"), ["commits_ad", "commits_ai", "commits_au", "commits_relink_children"]);
    r.d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits_fts WHERE commits_fts MATCH 's'").get() as Row).n, 2, "FTS rebuilt on the resume path");
    await initSchema(r.adapter); // and a third start is a no-op
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits").get() as Row).n, 2);
  }
  // round 33: the FTS re-index is part of the migration. Stop right after the legacy table is dropped (the rebuild throws
  // once): init fails (no app on a stale index), the pending flag survives the restart, the next start re-indexes
  {
    const r = openRaw();
    r.deviceExec(legacy);
    r.d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES ('Q',1,'searchme',1,1,1,'APP_USAGE',1)").run();
    let fail = true;
    const flaky = { ...r.adapter, run: async (sql: string, v?: unknown[]) => {
      if (fail && sql.includes("VALUES('rebuild')")) { fail = false; throw new Error("killed before the re-index"); }
      return r.adapter.run(sql, v);
    } };
    await assert.rejects(initSchema(flaky), /killed before the re-index/);
    assert.equal(r.d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'commits_legacy_migration'").get(), undefined, "copy done, legacy gone");
    await initSchema(r.adapter); // restart
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits_fts WHERE commits_fts MATCH 'searchme'").get() as Row).n, 1, "re-indexed on the next start");
    r.d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
    r.d.prepare("DELETE FROM commits WHERE id = 'Q'").run(); // the reviewer's "malformed" delete
    assert.equal(r.d.prepare("SELECT 1 FROM app_settings WHERE key = 'migration_fts_rebuild_pending'").get(), undefined, "flag cleared");
  }
  // round 34: creating the FTS table fails once while the re-index is pending -> init fails and the flag stays; the
  // restart creates the table and re-indexes (not "no FTS5, clear the flag")
  {
    const r = openRaw();
    r.deviceExec(legacy);
    r.d.exec("DROP TABLE IF EXISTS commits_fts"); // so the next init really has to create it
    r.d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES ('R',1,'findme',1,1,1,'APP_USAGE',1)").run();
    let fail = true;
    const flaky = { ...r.adapter, run: async (sql: string, v?: unknown[]) => {
      if (fail && /CREATE VIRTUAL TABLE/i.test(sql)) { fail = false; throw new Error("transient FTS create failure"); }
      return r.adapter.run(sql, v);
    } };
    await assert.rejects(initSchema(flaky), /transient FTS create failure/);
    assert.ok(r.d.prepare("SELECT 1 FROM app_settings WHERE key = 'migration_fts_rebuild_pending'").get(), "flag kept");
    await initSchema(r.adapter); // restart
    assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits_fts WHERE commits_fts MATCH 'findme'").get() as Row).n, 1, "created and re-indexed");
    r.d.prepare("DELETE FROM commits WHERE id = 'R'").run();
    assert.equal(r.d.prepare("SELECT 1 FROM app_settings WHERE key = 'migration_fts_rebuild_pending'").get(), undefined);
  }
  // the whole class: fail EVERY statement of a legacy-migration start in turn (run/execute/query), then restart normally ->
  // rows and parent links kept, search finds them, FTS integrity holds, deleting works, nothing left pending
  {
    let total = 0;
    { // count the statements of one clean legacy start
      const r = openRaw(); r.deviceExec(legacy);
      const counting = { query: (q: string, v?: unknown[]) => (total++, r.adapter.query(q, v)), run: (q: string, v?: unknown[]) => (total++, r.adapter.run(q, v)), execute: (q: string) => (total++, r.adapter.execute(q)) };
      await initSchema(counting);
    }
    assert.ok(total > 20, `statements counted: ${total}`);
    for (let k = 0; k < total; k++) {
      const r = openRaw(); r.deviceExec(legacy);
      const add = r.d.prepare("INSERT INTO commits (id, branch_id, parent_id, subject, started_at, ended_at, duration_sec, event_type, created_at) VALUES (?,1,?,?,?,?,1,'APP_USAGE',1)");
      add.run("P", null, "s-P", 1, 1); add.run("C", "P", "s-C", 2, 2);
      let n = 0;
      const boom = <T>(f: () => Promise<T>) => (n++ === k ? Promise.reject(new Error(`injected at statement ${k}`)) : f());
      const flaky = { query: (q: string, v?: unknown[]) => boom(() => r.adapter.query(q, v)), run: (q: string, v?: unknown[]) => boom(() => r.adapter.run(q, v)), execute: (q: string) => boom(() => r.adapter.execute(q)) };
      await initSchema(flaky).catch(() => {}); // fails or (a tolerated warning) succeeds
      await initSchema(r.adapter); // restart
      const at = `failure at statement ${k}`;
      assert.deepEqual((r.d.prepare("SELECT id, parent_id FROM commits ORDER BY id").all() as Row[]).map((x) => ({ ...x })), [{ id: "C", parent_id: "P" }, { id: "P", parent_id: null }], at);
      assert.equal((r.d.prepare("SELECT COUNT(*) AS n FROM commits_fts WHERE commits_fts MATCH 's'").get() as Row).n, 2, at);
      r.d.exec("INSERT INTO commits_fts(commits_fts, rank) VALUES('integrity-check', 1)");
      r.d.prepare("DELETE FROM commits WHERE id = 'C'").run();
      assert.equal(r.d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'commits_legacy_migration'").get(), undefined, at);
      assert.equal(r.d.prepare("SELECT 1 FROM app_settings WHERE key = 'migration_fts_rebuild_pending'").get(), undefined, at);
    }
  }
  // an install whose commit_tombstones predates the range columns gets them; a second init is a no-op; data kept
  {
    const r = openRaw();
    r.d.exec("CREATE TABLE commit_tombstones (id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL)");
    r.d.exec("INSERT INTO commit_tombstones VALUES ('old', 1)");
    await initSchema(r.adapter);
    await initSchema(r.adapter);
    const cols = (r.d.prepare("PRAGMA table_info(commit_tombstones)").all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, ["id", "deleted_at", "app_package", "started_at", "ended_at"]);
    assert.equal((r.d.prepare("SELECT COUNT(*) n FROM commit_tombstones").get() as { n: number }).n, 1);
  }
  // an install whose usage_state predates processed_to gets it, backfilled from coverage / usage rows (max)
  {
    const r = openRaw();
    r.d.exec("CREATE TABLE usage_state (id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL)");
    r.d.exec("INSERT INTO usage_state VALUES (1, 1)");
    r.d.exec("CREATE TABLE usage_coverage (id TEXT PRIMARY KEY, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT)");
    r.d.exec("INSERT INTO usage_coverage VALUES ('c', 0, 7000, NULL)");
    await initSchema(r.adapter);
    r.d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES ('us:a:1',1,'s',1,9000,1,'a','APP_USAGE',1)").run();
    assert.equal((r.d.prepare("SELECT processed_to p FROM usage_state").get() as { p: number }).p, 7000);
    await initSchema(r.adapter); // already migrated: not recomputed
    assert.equal((r.d.prepare("SELECT epoch e, processed_to p FROM usage_state").get() as { e: number; p: number }).p, 7000);
  }
  // a crash between adding processed_to and backfilling it is repaired on the next start
  {
    const r = openRaw();
    r.d.exec("CREATE TABLE usage_state (id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL, processed_to INTEGER NOT NULL DEFAULT 0)");
    r.d.exec("INSERT INTO usage_state (id, epoch) VALUES (1, 1)");
    r.d.exec("CREATE TABLE usage_coverage (id TEXT PRIMARY KEY, from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL, reason TEXT)");
    r.d.exec("INSERT INTO usage_coverage VALUES ('c', 0, 7000, NULL)");
    await initSchema(r.adapter);
    assert.equal((r.d.prepare("SELECT processed_to p FROM usage_state").get() as { p: number }).p, 7000);
  }

  // contact_tags 마이그레이션: 구 스키마(UNIQUE contact_name, contact_key 없음) -> 새 스키마(contact_key UNIQUE)
  {
    const r = openRaw();
    // 구버전 스키마 수동 생성
    r.d.exec(`
      CREATE TABLE contact_tags (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_name TEXT    NOT NULL UNIQUE,
        tag          TEXT    NOT NULL,
        phone_number TEXT
      )
    `);
    const ins = r.d.prepare("INSERT INTO contact_tags (contact_name, tag, phone_number) VALUES (?, ?, ?)");
    ins.run("Family", "#family", null);
    ins.run("Friend", "#friend", "+82 10-1234-5678");
    ins.run("Work", "#work", "010-9876-5432");

    await initSchema(r.adapter);

    const cols = (r.d.prepare("PRAGMA table_info(contact_tags)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("contact_key"), "contact_key 컬럼이 존재해야 함");

    const rows = r.d.prepare("SELECT * FROM contact_tags ORDER BY id ASC").all() as { id: number; contact_key: string; contact_name: string; tag: string; phone_number: string | null }[];
    assert.equal(rows.length, 3, "모든 기존 행 보존");
    assert.equal(rows[0].contact_key, "name:Family", "번호 없는 행은 name: 키");
    assert.equal(rows[1].contact_key, "tel:01012345678", "번호 있는 행은 tel:<normalizePhone> 키");
    assert.equal(rows[2].contact_key, "tel:01098765432", "하이픈 포함 번호 정규화 키");

    // 동명이인(contact_name 중복) 추가 가능 여부 검증 (contact_name의 UNIQUE 제거 확인)
    assert.doesNotThrow(() => {
      r.d.prepare("INSERT INTO contact_tags (contact_key, contact_name, tag, phone_number) VALUES (?, ?, ?, ?)").run(
        "tel:01011112222", "Friend", "#other-friend", "01011112222"
      );
    }, "동명이인 contact_name 삽입이 가능해야 함");

    // 마이그레이션 멱등성: 다시 실행해도 데이터 손실 없음
    await initSchema(r.adapter);
    const countAfter = (r.d.prepare("SELECT COUNT(*) AS n FROM contact_tags").get() as { n: number }).n;
    assert.equal(countAfter, 4, "재실행해도 안전(멱등성)");
    assert.equal(r.d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'contact_tags_legacy_migration'").get(), undefined, "임시 테이블 삭제됨");
  }

  // contact_tags 마이그레이션 중단 및 재개(Resumable) 검증:
  // RENAME 후 새 테이블만 있거나 부분 복사된 상태에서 재시작해도 정상 복원
  {
    const r = openRaw();
    r.d.exec(`
      CREATE TABLE contact_tags_legacy_migration (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_name TEXT    NOT NULL,
        tag          TEXT    NOT NULL,
        phone_number TEXT
      )
    `);
    const ins = r.d.prepare("INSERT INTO contact_tags_legacy_migration (contact_name, tag, phone_number) VALUES (?, ?, ?)");
    ins.run("Interrupted1", "#tag1", "010-1111-0001");
    ins.run("Interrupted2", "#tag2", null);

    // 새 테이블이 이미 비어있게 생성된 상태 시뮬레이션
    r.d.exec(`
      CREATE TABLE contact_tags (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_key  TEXT    NOT NULL UNIQUE,
        contact_name TEXT    NOT NULL,
        tag          TEXT    NOT NULL,
        phone_number TEXT
      )
    `);

    await initSchema(r.adapter);

    const rows = r.d.prepare("SELECT * FROM contact_tags ORDER BY id ASC").all() as { id: number; contact_key: string; contact_name: string }[];
    assert.equal(rows.length, 2, "중단된 상태에서 재시작 시 정상 복구");
    assert.equal(rows[0].contact_key, "tel:01011110001");
    assert.equal(rows[1].contact_key, "name:Interrupted2");
    assert.equal(r.d.prepare("SELECT 1 FROM sqlite_master WHERE name = 'contact_tags_legacy_migration'").get(), undefined, "레거시 테이블 정리");
  }

  // contact_tags 구 DB 이관 시 중복 키(같은 번호 둘) 발생 시 id 작은 행 유지 검증
  {
    const r = openRaw();
    r.d.exec(`
      CREATE TABLE contact_tags_legacy_migration (
        id           INTEGER PRIMARY KEY,
        contact_name TEXT    NOT NULL,
        tag          TEXT    NOT NULL,
        phone_number TEXT
      )
    `);
    const ins = r.d.prepare("INSERT INTO contact_tags_legacy_migration (id, contact_name, tag, phone_number) VALUES (?, ?, ?, ?)");
    ins.run(1, "PersonA", "#first", "010-5555-5555");
    ins.run(2, "PersonB", "#second", "+82 10-5555-5555"); // 같은 정규화 번호 -> 중복 키

    await initSchema(r.adapter);

    const rows = r.d.prepare("SELECT * FROM contact_tags WHERE contact_key = 'tel:01055555555'").all() as { id: number; tag: string }[];
    assert.equal(rows.length, 1, "중복 키 발생 시 1행만 남음");
    assert.equal(rows[0].id, 1, "id가 작은 행 유지");
    assert.equal(rows[0].tag, "#first");
  }

  // P3: 시드 태그 재삽입 방지 검증: 전부 삭제 후 재시작해도 0개 유지
  {
    const r = openRaw();
    // 1) 새 설치: contact_tags가 처음 생성되므로 기본 시드 3개 삽입
    await initSchema(r.adapter);
    const countInit = (r.d.prepare("SELECT COUNT(*) AS n FROM contact_tags").get() as { n: number }).n;
    assert.equal(countInit, 3, "새 설치 시 시드 태그 3개 생성");

    // 2) 사용자가 태그를 전부 삭제
    r.d.exec("DELETE FROM contact_tags");
    const countDeleted = (r.d.prepare("SELECT COUNT(*) AS n FROM contact_tags").get() as { n: number }).n;
    assert.equal(countDeleted, 0, "태그 전부 삭제");

    // 3) 앱 재시작(initSchema 재실행): 테이블이 이미 존재했으므로 시드가 다시 삽입되지 않아야 함
    await initSchema(r.adapter);
    const countRestart = (r.d.prepare("SELECT COUNT(*) AS n FROM contact_tags").get() as { n: number }).n;
    assert.equal(countRestart, 0, "전부 삭제 후 재시작해도 0개 유지");
  }

  // P2: contact_tags 이관 직후 과거 커밋 author_tag 재계산 및 두 번째 실행 시 미실행 검증
  {
    const r = openRaw();
    // 구버전 contact_tags (contact_name UNIQUE, contact_key 없음)
    r.d.exec(`
      CREATE TABLE contact_tags (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_name TEXT    NOT NULL UNIQUE,
        tag          TEXT    NOT NULL,
        phone_number TEXT
      );
      INSERT INTO contact_tags (contact_name, tag, phone_number) VALUES ('Hong', '#WorkTag', '010-1111-1111');

      CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE commits (
        id              TEXT PRIMARY KEY,
        branch_id       INTEGER NOT NULL,
        parent_id       TEXT,
        subject         TEXT NOT NULL,
        body            TEXT,
        author_tag      TEXT,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER NOT NULL,
        duration_sec    INTEGER NOT NULL,
        app_package     TEXT,
        event_type      TEXT NOT NULL CHECK(event_type IN ('APP_USAGE', 'CALL', 'SMS', 'LOCATION', 'REPLY', 'SCREEN_UNLOCK', 'MERGE', 'manual')),
        squashed_events TEXT,
        geofence_name   TEXT,
        lat             REAL,
        lng             REAL,
        created_at      INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE commits_fts USING fts5(
        id          UNINDEXED,
        subject,
        body,
        app_package,
        geofence_name,
        author_tag,
        content     = 'commits',
        content_rowid = 'rowid',
        tokenize    = 'unicode61'
      );
      CREATE TRIGGER commits_ai AFTER INSERT ON commits BEGIN
        INSERT INTO commits_fts(rowid, id, subject, body, app_package, geofence_name, author_tag)
        VALUES (new.rowid, new.id, new.subject, new.body, new.app_package, new.geofence_name, new.author_tag);
      END;
      CREATE TRIGGER commits_au AFTER UPDATE ON commits BEGIN
        INSERT INTO commits_fts(commits_fts, rowid, id, subject, body, app_package, geofence_name, author_tag)
        VALUES ('delete', old.rowid, old.id, old.subject, old.body, old.app_package, old.geofence_name, old.author_tag);
        INSERT INTO commits_fts(rowid, id, subject, body, app_package, geofence_name, author_tag)
        VALUES (new.rowid, new.id, new.subject, new.body, new.app_package, new.geofence_name, new.author_tag);
      END;
    `);

    // 옛 스키마 + 옛 규칙으로 찍힌 동명이인 커밋 2개 삽입
    // A: 번호 010-1111-1111, 이름 Hong, 태그 #WorkTag
    // B: 번호 010-2222-2222, 이름 Hong (동명이인), 태그 #WorkTag (옛 규칙 이름 우선으로 잘못 박제됨)
    const insCommit = r.d.prepare(`
      INSERT INTO commits (id, branch_id, subject, body, author_tag, started_at, ended_at, duration_sec, event_type, created_at)
      VALUES (?, 1, 'call', ?, '#WorkTag', 1000, 1060, 60, 'CALL', 1000)
    `);
    insCommit.run("commit-a", JSON.stringify({ phoneNumber: "010-1111-1111", contactName: "Hong" }));
    insCommit.run("commit-b", JSON.stringify({ phoneNumber: "010-2222-2222", contactName: "Hong" }));

    // FTS 초기 상태 확인: 둘 다 #WorkTag로 검색됨
    const ftsBefore = (r.d.prepare("SELECT id FROM commits_fts WHERE commits_fts MATCH 'author_tag:\"#WorkTag\"'").all() as { id: string }[]).map((x) => x.id);
    assert.deepEqual(ftsBefore.sort(), ["commit-a", "commit-b"], "이관 전에는 두 커밋 모두 FTS에 #WorkTag로 등록됨");

    // contact_tags 이관 발생
    await initSchema(r.adapter);

    // 1) 커밋 태그 변경 검증: A 유지, B 해제
    const commitA = r.d.prepare("SELECT author_tag FROM commits WHERE id = 'commit-a'").get() as { author_tag: string | null };
    const commitB = r.d.prepare("SELECT author_tag FROM commits WHERE id = 'commit-b'").get() as { author_tag: string | null };
    assert.equal(commitA.author_tag, "#WorkTag", "A 커밋 태그 유지");
    assert.equal(commitB.author_tag, null, "B 커밋 태그 해제 (동명이인 번호 불일치)");

    // 2) FTS 반영 검증
    const ftsAfter = (r.d.prepare("SELECT id FROM commits_fts WHERE commits_fts MATCH 'author_tag:\"#WorkTag\"'").all() as { id: string }[]).map((x) => x.id);
    assert.deepEqual(ftsAfter, ["commit-a"], "FTS 검색에 commit-a만 반영되고 commit-b는 제외됨");

    // 3) 두 번째 initSchema는 rematch 안 함 검증
    //    인위적으로 B 커밋에 #dummy 태그를 설정하고, rematch가 돌지 않으면 #dummy가 유지됨
    r.d.prepare("UPDATE commits SET author_tag = '#dummy' WHERE id = 'commit-b'").run();
    await initSchema(r.adapter);
    const commitBAfterSecond = (r.d.prepare("SELECT author_tag FROM commits WHERE id = 'commit-b'").get() as { author_tag: string | null }).author_tag;
    assert.equal(commitBAfterSecond, "#dummy", "두 번째 initSchema에서는 rematch가 실행되지 않아 dummy 태그 유지");
    assert.equal(r.d.prepare("SELECT 1 FROM app_settings WHERE key = 'migration_contact_tag_rematch_pending'").get(), undefined, "pending 플래그 삭제됨");
  }

  console.log("schema init checks passed");
}
main();
