// Pure SQL (no Capacitor imports) so tests can run it on node:sqlite.
// ── 인라인 스키마 분리 정의 ──────────────────────────────────────────────

export const BASE_TABLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS branches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  color      TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO branches (name, color, created_at) VALUES
  ('main',           '#f1e05a', 1700000000000),
  ('feature/web',    '#50fa7b', 1700000000000),
  ('feature/media',  '#ff79c6', 1700000000000),
  ('feature/sns',    '#8be9fd', 1700000000000),
  ('feature/work',   '#bd93f9', 1700000000000),
  ('feature/life',   '#ffb86c', 1700000000000),
  ('feature/etc',    '#6272a4', 1700000000000),
  ('feature/system', '#a0a8b8', 1700000000000),
  ('feature/game',   '#ff5555', 1700000000000);

CREATE TABLE IF NOT EXISTS app_branch_overrides (
  app_package TEXT PRIMARY KEY,
  branch_id   INTEGER NOT NULL REFERENCES branches(id)
);

CREATE TABLE IF NOT EXISTS commits (
  id              TEXT    PRIMARY KEY,
  branch_id       INTEGER NOT NULL REFERENCES branches(id),
  parent_id       TEXT    REFERENCES commits(id),
  subject         TEXT    NOT NULL,
  body            TEXT,
  author_tag      TEXT,
  started_at      INTEGER NOT NULL,
  ended_at        INTEGER NOT NULL,
  duration_sec    INTEGER NOT NULL,
  app_package     TEXT,
  event_type      TEXT    NOT NULL CHECK(event_type IN
                    ('APP_USAGE','CALL','SMS','LOCATION','PHOTO','REPLY','MERGE','manual')),
  squashed_events TEXT    DEFAULT '[]',
  geofence_name   TEXT,
  lat             REAL,
  lng             REAL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_commits_branch  ON commits(branch_id);
CREATE INDEX IF NOT EXISTS idx_commits_started ON commits(started_at DESC);
-- child lookup for the parent_id FK check and the relink trigger; without it every deleted row scans the table
CREATE INDEX IF NOT EXISTS idx_commits_parent ON commits(parent_id);
-- 선택형 조회: 종류 + 기간
CREATE INDEX IF NOT EXISTS idx_commits_type_started ON commits(event_type, started_at);

CREATE TABLE IF NOT EXISTS raw_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type   TEXT    NOT NULL,
  app_package  TEXT,
  raw_data     TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  is_processed INTEGER NOT NULL DEFAULT 0 CHECK(is_processed IN (0,1)),
  error_message TEXT,
  processed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_raw_events_processed ON raw_events(is_processed, started_at);

CREATE TABLE IF NOT EXISTS contact_tags (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_key  TEXT    NOT NULL UNIQUE,
  contact_name TEXT    NOT NULL,
  tag          TEXT    NOT NULL,
  phone_number TEXT
);

CREATE TABLE IF NOT EXISTS geofences (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL UNIQUE,
  lat            REAL    NOT NULL,
  lng            REAL    NOT NULL,
  radius_m       INTEGER NOT NULL DEFAULT 150,
  branch_trigger TEXT    NOT NULL DEFAULT 'main'
);

INSERT OR IGNORE INTO geofences (name, lat, lng, radius_m, branch_trigger) VALUES
  ('🏠 Home', 37.5665, 126.9780, 150, 'main');

CREATE TABLE IF NOT EXISTS app_blacklist (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  package TEXT    NOT NULL UNIQUE,
  reason  TEXT
);

INSERT OR IGNORE INTO app_blacklist (package, reason) VALUES
  ('com.android.systemui',           'system_ui'),
  ('com.sec.android.app.launcher',   'launcher'),
  ('com.android.launcher3',          'launcher'),
  ('com.google.android.apps.nexuslauncher', 'launcher'),
  ('com.samsung.android.app.cocktailbarservice', 'system_ui');

-- settings that must commit atomically with the data they govern (noise filter text: lib/settings.ts)
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- generation of the usage data (lib/usageDrain.ts): a native queue batch from another epoch is never drained
CREATE TABLE IF NOT EXISTS usage_state (
  id           INTEGER PRIMARY KEY CHECK(id = 1),
  epoch        INTEGER NOT NULL,
  processed_to INTEGER NOT NULL DEFAULT 0 -- end of what this DB processed; never decreases (except a reset)
);

INSERT OR IGNORE INTO usage_state (id, epoch) VALUES (1, 0);

-- ranges the usage collector processed (or could not trust: reason); id is content-based, not seq-based
CREATE TABLE IF NOT EXISTS usage_coverage (
  id      TEXT    PRIMARY KEY,
  from_ms INTEGER NOT NULL,
  to_ms   INTEGER NOT NULL,
  reason  TEXT
);

-- deletion intent (lib/tombstones.ts): a tombstoned commit id is never inserted again
CREATE TABLE IF NOT EXISTS commit_tombstones (
  id          TEXT    PRIMARY KEY,
  deleted_at  INTEGER NOT NULL,
  app_package TEXT,
  started_at  INTEGER,
  ended_at    INTEGER
);
`;

export const CREATE_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts USING fts5(
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
`;

export const TRIGGER_COMMITS_AI = `
CREATE TRIGGER IF NOT EXISTS commits_ai AFTER INSERT ON commits BEGIN
  INSERT INTO commits_fts(rowid, id, subject, body, app_package, geofence_name, author_tag)
  VALUES (new.rowid, new.id, new.subject, new.body, new.app_package, new.geofence_name, new.author_tag);
END;
`;

export const TRIGGER_COMMITS_AD = `
CREATE TRIGGER IF NOT EXISTS commits_ad AFTER DELETE ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, id, subject, body, app_package, geofence_name, author_tag)
  VALUES ('delete', old.rowid, old.id, old.subject, old.body, old.app_package, old.geofence_name, old.author_tag);
END;
`;

export const TRIGGER_COMMITS_AU = `
CREATE TRIGGER IF NOT EXISTS commits_au AFTER UPDATE ON commits BEGIN
  INSERT INTO commits_fts(commits_fts, rowid, id, subject, body, app_package, geofence_name, author_tag)
  VALUES ('delete', old.rowid, old.id, old.subject, old.body, old.app_package, old.geofence_name, old.author_tag);
  INSERT INTO commits_fts(rowid, id, subject, body, app_package, geofence_name, author_tag)
  VALUES (new.rowid, new.id, new.subject, new.body, new.app_package, new.geofence_name, new.author_tag);
END;
`;

// Re-link children before a commit is deleted (git-style: the child takes the deleted commit's parent).
// With foreign_keys ON, deleting any commit that a memo points to as parent_id used to fail on every delete path.
export const TRIGGER_COMMITS_RELINK = `
CREATE TRIGGER IF NOT EXISTS commits_relink_children BEFORE DELETE ON commits BEGIN
  UPDATE commits SET parent_id = old.parent_id WHERE parent_id = old.id;
END;
`;

// commits indexes, re-run after migrations (the 1c table swap leaves the old names on the renamed table, so the
// CREATE ... IF NOT EXISTS inside BASE_TABLES_SCHEMA is skipped for the new table and the drop takes them away)
export const COMMITS_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_commits_branch ON commits(branch_id)",
  "CREATE INDEX IF NOT EXISTS idx_commits_started ON commits(started_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_commits_parent ON commits(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_commits_pkg_started ON commits(app_package, started_at)", // usage overlap checks
  "CREATE INDEX IF NOT EXISTS idx_commits_type_started ON commits(event_type, started_at)", // 선택형 조회: 종류 + 기간
];
