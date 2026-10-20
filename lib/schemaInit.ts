/**
 * Schema creation + migrations, free of Capacitor imports so a real-SQLite check can run the same sequence.
 * `execute` receives multi-statement SQL (the Android plugin splits it on ";\n"); everything else goes through `run`.
 */
import { BASE_TABLES_SCHEMA, COMMITS_INDEXES, CREATE_FTS_TABLE, TRIGGER_COMMITS_AI, TRIGGER_COMMITS_AD, TRIGGER_COMMITS_AU, TRIGGER_COMMITS_RELINK } from "./schema";
import { computeContactKey, rematchAuthorTags } from "./tagManager";

export interface InitDb {
  query(sql: string, values?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
  run(sql: string, values?: unknown[], tx?: boolean): Promise<unknown>;
  execute(sql: string): Promise<unknown>;
}

const FTS_REBUILD_PENDING = "migration_fts_rebuild_pending";
const CONTACT_TAG_REMATCH_PENDING = "migration_contact_tag_rematch_pending";

export async function initSchema(db: InitDb): Promise<void> {
  // 이번 initSchema 호출 전 contact_tags 테이블이 이미 존재했는지 확인 (새 설치 판별용)
  const contactTagsExistedBeforeInit = !!(
    await db.query(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND (name = 'contact_tags' OR name = 'contact_tags_legacy_migration')`
    )
  ).values?.length;

  // 1. 기본 테이블, 인덱스 및 초기 데이터 생성
  await db.execute(BASE_TABLES_SCHEMA);

  // 1b. 기존 설치본 마이그레이션: raw_events.error_message 컬럼이 없으면 추가
  //     (CREATE TABLE IF NOT EXISTS는 이미 존재하는 테이블에 컬럼을 추가하지 않음)
  try {
    await db.run(`ALTER TABLE raw_events ADD COLUMN error_message TEXT`);
  } catch {
    // 컬럼이 이미 존재하는 정상적인 경우
  }

  // 1b. raw_events.processed_at (the 7-day purge clock, lib/processBatch.ts). Rows processed before it existed get "now"
  //     on every start (idempotent), so nothing already processed is purged on upgrade day.
  const rawCols = new Set(((await db.query("PRAGMA table_info(raw_events)")).values || []).map((r) => String(r.name)));
  if (!rawCols.has("processed_at")) await db.run("ALTER TABLE raw_events ADD COLUMN processed_at INTEGER");
  await db.run("UPDATE raw_events SET processed_at = ? WHERE is_processed = 1 AND processed_at IS NULL", [Date.now()]);

  // 1b'. usage tombstones carry the deleted row's app + range (used for a backup's usage span). Older ones keep NULLs.
  const tombCols = new Set(((await db.query("PRAGMA table_info(commit_tombstones)")).values || []).map((r) => String(r.name)));
  for (const [col, type] of [["app_package", "TEXT"], ["started_at", "INTEGER"], ["ended_at", "INTEGER"]]) {
    if (!tombCols.has(col)) await db.run(`ALTER TABLE commit_tombstones ADD COLUMN ${col} ${type}`);
  }

  // 1b''. usage_state.processed_to (the seed for a native store without cursor), then on EVERY start raised to the
  //       processed coverage: idempotent, so a crash between the ALTER and this UPDATE is repaired on the next start.
  //       Coverage only - usage rows may come from a restored backup and would jump over periods nobody processed.
  const stateCols = new Set(((await db.query("PRAGMA table_info(usage_state)")).values || []).map((r) => String(r.name)));
  if (!stateCols.has("processed_to")) await db.run("ALTER TABLE usage_state ADD COLUMN processed_to INTEGER NOT NULL DEFAULT 0");
  await db.run("UPDATE usage_state SET processed_to = MAX(processed_to, COALESCE((SELECT MAX(to_ms) FROM usage_coverage), 0))");

  // 1c. 기존 설치본 마이그레이션: commits.event_type CHECK 제약에 'MERGE'/'manual'이
  //     빠져있던 구버전 스키마(스키마 통합 과정에서 누락됨)를 감지하면 테이블을
  //     재생성해 데이터를 보존한 채 이관한다. SQLite는 ALTER TABLE로 CHECK 제약을
  //     바꿀 수 없어 테이블 재생성이 유일한 방법이다.
  //     Resumable: step 1 recreates an empty new-style commits on every start, so an interrupted migration (after
  //     the RENAME) is recognised by the leftover legacy table, not by the commits SQL. A failure propagates: the app
  //     shows the DB error screen (lib/db.ts keeps the data) instead of opening on an empty commits table.
  //     The FTS re-index is part of the migration: a durable flag (set before the legacy table goes) keeps it pending
  //     across restarts until a rebuild succeeds, and a failed rebuild fails init instead of opening a broken index.
  const legacyLeft = !!(await db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'commits_legacy_migration'`)).values?.length;
  const currentSql = String((await db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'commits'`)).values?.[0]?.sql || "");
  if (!legacyLeft && currentSql && !currentSql.includes("MERGE")) {
    await db.run(`ALTER TABLE commits RENAME TO commits_legacy_migration`);
    await db.execute(BASE_TABLES_SCHEMA); // commits가 없어졌으니 새 CHECK 제약으로 재생성됨
  }
  if (legacyLeft || (currentSql && !currentSql.includes("MERGE"))) {
    // OR IGNORE: a resumed copy may meet rows a previous attempt already copied
    await db.run(`
      INSERT OR IGNORE INTO commits (
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      )
      SELECT
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      FROM commits_legacy_migration
    `);
    await db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('${FTS_REBUILD_PENDING}', '1')`);
    await db.run(`DROP TABLE commits_legacy_migration`);
    console.log("[DB] commits 테이블을 새 event_type 제약(MERGE/manual 포함)으로 마이그레이션했습니다.");
  }

  // 1c'. 인덱스는 테이블 교체가 끝난 뒤에 (교체 전에 만들면 옛 테이블 이름에 묶여 같이 삭제됨)
  for (const sql of COMMITS_INDEXES) await db.run(sql);

  // 1d. 삭제 시 자식 커밋 재연결 트리거 (FK ON에서 부모 커밋 삭제가 실패하던 문제)
  await db.run(TRIGGER_COMMITS_RELINK);

  // 1e. contact_tags 마이그레이션: contact_key 추가 및 contact_name UNIQUE 제거.
  //     SQLite는 ALTER TABLE로 UNIQUE 제약을 제거할 수 없어 테이블 재생성 이관을 수행한다.
  //     중간에 끊겨도 다음 시작에 이어서/다시 안전하게 복구(Resumable, Idempotent).
  const legacyTagsLeft = !!(await db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_tags_legacy_migration'`)).values?.length;
  const currentTagSql = String((await db.query(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'contact_tags'`)).values?.[0]?.sql || "");
  const hasContactKey = currentTagSql.includes("contact_key");
  const isTagMigrating = legacyTagsLeft || (currentTagSql && !hasContactKey);

  if (!legacyTagsLeft && currentTagSql && !hasContactKey) {
    await db.run(`ALTER TABLE contact_tags RENAME TO contact_tags_legacy_migration`);
    await db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('${CONTACT_TAG_REMATCH_PENDING}', '1')`);
    await db.execute(BASE_TABLES_SCHEMA);
  } else if (legacyTagsLeft) {
    await db.run(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('${CONTACT_TAG_REMATCH_PENDING}', '1')`);
  }

  if (isTagMigrating) {
    const newTagExists = !!(await db.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'contact_tags'`)).values?.length;
    if (!newTagExists) {
      await db.execute(BASE_TABLES_SCHEMA);
    }

    const rows = (await db.query(`SELECT id, contact_name, tag, phone_number FROM contact_tags_legacy_migration ORDER BY id ASC`)).values || [];
    const seenKeys = new Set<string>();

    for (const r of rows) {
      const id = Number(r.id);
      const name = String(r.contact_name ?? "");
      const tag = String(r.tag ?? "");
      const phone = r.phone_number != null ? String(r.phone_number) : null;
      const key = computeContactKey(name, phone);

      if (seenKeys.has(key)) {
        console.warn(`[DB Migration] contact_tags 중복 키 감지: id=${id}, key=${key}, name=${name} - 기존(작은 id) 유지`);
        continue;
      }
      seenKeys.add(key);

      await db.run(
        `INSERT OR IGNORE INTO contact_tags (id, contact_key, contact_name, tag, phone_number) VALUES (?, ?, ?, ?, ?)`,
        [id, key, name, tag, phone]
      );
    }

    await db.run(`DROP TABLE contact_tags_legacy_migration`);
    console.log("[DB] contact_tags 테이블을 새 스키마(contact_key UNIQUE)로 마이그레이션했습니다.");
  }

  // 1e'. contact_tags 시드 데이터: 이번 initSchema에서 contact_tags 테이블을 처음 만든 경우(새 설치)에만 시드
  if (!contactTagsExistedBeforeInit) {
    await db.run(`
      INSERT OR IGNORE INTO contact_tags (contact_key, contact_name, tag) VALUES
        ('name:Family', 'Family', '#family'),
        ('name:Friend', 'Friend', '#friend'),
        ('name:Work',   'Work',   '#work')
    `);
  }

  // 2. FTS5 가상 테이블 및 트리거는 run()으로 각각 단일 실행 (세미콜론 split 파싱 에러 방지)
  // 1c에서 commits 테이블을 재생성했다면 FTS5 external-content 인덱스가 예전 rowid를 참조하던 상태라 새 rowid와
  // 어긋난다 -- 전체 재색인 필요. While that is pending (flag above), creating the FTS table/triggers and re-indexing
  // must all succeed before the flag is cleared; any failure propagates (DB error screen, data kept, retried next
  // start). A swallowed step left search empty and a later delete failing "database disk image is malformed".
  const ftsPending = !!(await db.query(`SELECT 1 FROM app_settings WHERE key = '${FTS_REBUILD_PENDING}'`)).values?.length;
  try {
    await db.run(CREATE_FTS_TABLE);
    await db.run(TRIGGER_COMMITS_AI);
    await db.run(TRIGGER_COMMITS_AD);
    await db.run(TRIGGER_COMMITS_AU);
  } catch (ftsErr) {
    if (ftsPending) throw ftsErr;
    console.warn("[DB] FTS5 테이블/트리거 생성 경고:", ftsErr);
  }
  if (ftsPending) {
    await db.run(`INSERT INTO commits_fts(commits_fts) VALUES('rebuild')`);
    await db.run(`DELETE FROM app_settings WHERE key = '${FTS_REBUILD_PENDING}'`);
  }

  // 2b. contact_tags 이관 시 과거 CALL/SMS 커밋의 author_tag 재계산 (FTS 반영)
  const rematchPending = !!(await db.query(`SELECT 1 FROM app_settings WHERE key = '${CONTACT_TAG_REMATCH_PENDING}'`)).values?.length;
  if (rematchPending) {
    await rematchAuthorTags(db);
    await db.run(`DELETE FROM app_settings WHERE key = '${CONTACT_TAG_REMATCH_PENDING}'`);
    console.log("[DB] contact_tags 이관에 따른 과거 커밋 author_tag 재계산을 완료했습니다.");
  }
}
