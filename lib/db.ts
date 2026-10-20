/**
 * LifeCommit - DB 초기화 모듈
 *
 * @capacitor-community/sqlite을 사용하여 SQLite DB를 열고, 아래 인라인 스키마
 * (BASE_TABLES_SCHEMA 등)를 실행하여 테이블과 FTS5 가상 테이블을 생성합니다.
 * SQLCipher 암호화가 활성화됩니다.
 *
 * 이 파일이 실제 실행되는 스키마의 유일한 소스입니다 (별도 .sql 파일 없음 --
 * 과거 lib/schema.sql이 여기 인라인 스키마와 따로 관리되며 서로 어긋난 적이
 * 있어 통합했습니다).
 */

import { isPlainSelect } from "./sqlGuard";
import { resetNativeUsageAfterFileWipe } from "./usageDrain";
import { initSchema } from "./schemaInit";
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from "@capacitor-community/sqlite";
import { Capacitor } from "@capacitor/core";

const DB_NAME = "lifecommit";

// pre-fix 설치본에 남아있을 수 있는 레거시 하드코딩 패스프레이즈.
// 새 설치에는 절대 사용되지 않으며, 1회성 rekey 마이그레이션 판별에만 쓰인다.
const LEGACY_HARDCODED_KEY = "lifecommit_secure_secret_passphrase_2026";

// SQLite DB 커넥션 관리
let db: SQLiteDBConnection | null = null;
const sqlite = new SQLiteConnection(CapacitorSQLite);

// 물리적으로 손상된 파일임이 명확한 경우에만 wipe-and-recreate를 허용한다.
// "file is not a database"/sqlite_notadb 등 키 불일치 에러는 복구 가능한 키/설정 문제이므로
// 절대 물리적 손상(corruption)으로 취급해 DB를 삭제하지 않고 보존한다.
const CORRUPTION_PATTERNS = [/database disk image is malformed/i, /sqlite_corrupt/i];

function matchesAny(err: unknown, patterns: RegExp[]): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  return patterns.some((p) => p.test(msg));
}

/**
 * DB 연결 초기화. 앱 시작 시 한 번만 호출.
 */
/** Opens and initialises the DB. Returns nothing: callers use getDB() (read-only) and executeInTransaction (writes). */
export async function initDB(): Promise<void> {
  if (db) return;

  const platform = Capacitor.getPlatform();
  if (platform === "web") {
    throw "WEB_MODE_SKIP_DB";
  }

  // 네이티브(Android Keystore) 암호화 키 조회. NEXT_PUBLIC_* 환경변수나 하드코딩된
  // 폴백은 절대 사용하지 않는다 -- 네이티브 키를 못 가져오면 크게 실패시킨다.
  const getNativeEncryptionKey = async (): Promise<string> => {
    const { default: KeystorePlugin } = await import("@/plugins/KeystorePlugin");
    const res = await KeystorePlugin.getOrCreateEncryptionKey();
    if (!res?.key) {
      throw new Error("[DB] Native keystore returned no encryption key.");
    }
    return res.key;
  };

  // 암호화 키 점검 및 세팅 헬퍼
  const setupSecret = async () => {
    const { default: KeystorePlugin } = await import("@/plugins/KeystorePlugin");
    const newKey = await getNativeEncryptionKey();

    const isStoredRes = await sqlite.isSecretStored();
    if (!isStoredRes.result) {
      // 완전 신규 설치: 네이티브 키를 바로 등록
      await sqlite.setEncryptionSecret(newKey);
      return;
    }

    // checkEncryptionSecret은 틀린 키일 때 { result: false }를 반환하는 게 아니라
    // 실제로 DB를 열어보다가 예외(SQLiteNotADatabaseException 등)를 던지는 경우가
    // 있다 -- 이 예외를 못 잡으면 아래 legacy-key rekey 시도 자체가 실행되지 않고
    // 곧장 상위로 튀어서, 구버전 설치본이 영원히 마이그레이션 기회를 못 얻는다.
    const checkRes = await sqlite.checkEncryptionSecret(newKey).catch(() => ({ result: false }));
    if (checkRes.result) {
      return; // 이미 올바른(네이티브) 키로 저장되어 있음
    }

    // 저장된 시크릿이 네이티브 키와 다름 -- pre-fix 설치본이 레거시 하드코딩
    // 패스프레이즈를 쓰고 있을 가능성이 있으므로 1회성 rekey를 시도한다.
    let rekeyDone = false;
    try {
      rekeyDone = (await KeystorePlugin.getRekeyStatus()).done;
    } catch {
      rekeyDone = false;
    }

    if (!rekeyDone) {
      const legacyCheck = await sqlite.checkEncryptionSecret(LEGACY_HARDCODED_KEY).catch(() => ({ result: false }));
      if (legacyCheck.result) {
        // SQLCipher 재암호화: 기존 데이터를 보존한 채 새 네이티브 키로 전환
        await sqlite.changeEncryptionSecret(newKey, LEGACY_HARDCODED_KEY);
        // 재암호화가 성공했을 때만 완료 플래그 기록 (실패 시 다음 실행에서 재시도)
        await KeystorePlugin.markRekeyDone();
        return;
      }
    }

    throw new Error("[DB] Stored encryption secret does not match the native key and no legacy rekey applies.");
  };

  const openAndInitSchema = async (): Promise<SQLiteDBConnection> => {
    await setupSecret();

    // 기존 연결이 남아있는지 확인
    const isConnRes = await sqlite.isConnection(DB_NAME, false);
    if (isConnRes.result) {
      try {
        db = await sqlite.retrieveConnection(DB_NAME, false);
      } catch {
        db = await sqlite.createConnection(DB_NAME, true, "secret", 1, false);
      }
    } else {
      db = await sqlite.createConnection(DB_NAME, true, "secret", 1, false);
    }

    await db.open();

    // PRAGMA 설정
    try {
      await db.query("PRAGMA journal_mode = WAL;");
      await db.query("PRAGMA foreign_keys = ON;");
    } catch (e) {
      console.warn("[DB] PRAGMA 설정 경고:", e);
    }

    await initSchema(db);

    return db;
  };

  try {
    await openAndInitSchema();
  } catch (err: any) {
    // 명확한 물리적 손상(disk image malformed / sqlite_corrupt)이 아니면 절대
    // DB를 지우지 않는다. "file is not a database"/sqlite_notadb는 SQLCipher가
    // 잘못되거나 없는 키로 열렸을 때도 던지는 에러라서 -- 복구 가능한 키/설정
    // 문제를 손상으로 오판해 정상 데이터를 날리는 것을 막기 위한 구분이다.
    const isCorruption = matchesAny(err, CORRUPTION_PATTERNS);

    if (!isCorruption) {
      console.error("[DB] DB 초기화 실패 (손상으로 판단되지 않아 데이터를 보존합니다):", err);
      throw new Error(`DB 초기화 실패: ${err?.message || String(err)}`);
    }

    console.warn("[DB] 물리적 DB 손상 감지. 백업 후 재생성을 시도합니다...", err);

    try {
      db = null;
      try { await sqlite.closeConnection(DB_NAME, false); } catch {}

      // 삭제 전 .db/-wal/-shm 백업. 백업 자체가 실패하면 데이터를 잃을 위험을
      // 감수하고 지우기보다는 에러를 표면화하고 재시도를 유도한다.
      const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
      await LifeCommitPlugin.backupCorruptDatabase({ database: `${DB_NAME}SQLite.db` });

      try { await CapacitorSQLite.deleteDatabase({ database: DB_NAME, readonly: false }); } catch {}
      await resetNativeUsageAfterFileWipe();
    } catch (backupErr) {
      console.error("[DB] Corrupt DB backup failed; aborting wipe to avoid data loss:", backupErr);
      throw new Error(`DB 손상 복구 실패 (백업 불가): ${(backupErr as any)?.message || String(backupErr)}`);
    }

    // 손상된 DB 재생성 재시도
    try {
      await openAndInitSchema();
    } catch (retryErr: any) {
      console.error("[DB] Critical DB initialization failure on retry:", retryErr);
      throw new Error(`DB 초기화 실패: ${retryErr?.message || String(retryErr)}`);
    }
  }

  console.log("[DB] LifeCommit DB initialized ✓");
  return;
}

/**
 * 현재 DB 연결 반환. initDB() 이후에만 사용.
 */
function rawDB(): SQLiteDBConnection {
  if (!db) throw new Error("[DB] Not initialized. Call initDB() first.");
  return db;
}

/** Read-only handle. Every write goes through the `d` that executeInTransaction passes in (one serialized write path). */
export type ReadOnlyDB = Pick<SQLiteDBConnection, "query">;

export function getDB(): ReadOnlyDB {
  const conn = rawDB();
  return {
    query: (statement, values, isSQL92) => {
      if (!isPlainSelect(statement)) throw new Error("[DB] getDB().query accepts one plain SELECT; write through executeInTransaction");
      return conn.query(statement, values, isSQL92);
    },
  };
}

// ── 비동기 직렬화 Mutex 큐 (동시 트랜잭션 충돌 방지) ──
let dbLockChain: Promise<any> = Promise.resolve();

/**
 * 안전한 트랜잭션 래퍼. Mutex 큐를 통해 동시 트랜잭션 충돌을 원천 차단하고 자동 Commit/Rollback 처리.
 */
export async function executeInTransaction<T>(
  action: (db: SQLiteDBConnection) => Promise<T>,
  opts: { requireTransaction?: boolean } = {}
): Promise<T> {
  // 이전 락이 풀릴 때까지 대기
  let releaseLock: () => void;
  const nextLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const prevLock = dbLockChain;
  dbLockChain = dbLockChain.then(() => nextLock).catch(() => nextLock);

  await prevLock.catch(() => {});

  try {
    const d = rawDB();
    let isRoot = false;
    try {
      const activeRes = typeof d.isTransactionActive === "function" ? await d.isTransactionActive() : { result: false };
      if (!activeRes.result && typeof d.beginTransaction === "function") {
        await d.beginTransaction();
        isRoot = true;
      }
    } catch (e) {
      // default: run without a transaction (legacy behaviour). Restore must not: a later failure would leave a partial import.
      if (opts.requireTransaction) throw new Error(`트랜잭션을 시작할 수 없어 작업을 중단했습니다: ${String(e)}`);
    }

    // 트랜잭션 내부에서는 run() 호출 시 transaction: false가 항상 강제되도록 래핑하여 중첩 트랜잭션 충돌을 원천 차단
    const wrappedDb = new Proxy(d, {
      get(target, prop, receiver) {
        if (prop === "run") {
          return (statement: string, values?: any[], _transaction?: boolean, returnMode?: string) => {
            return target.run(statement, values, false, returnMode);
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    try {
      const result = await action(wrappedDb);
      if (isRoot) {
        await d.commitTransaction();
      }
      return result;
    } catch (err) {
      if (isRoot) {
        try {
          await d.rollbackTransaction();
        } catch (rbErr) {
          console.warn("[DB] Rollback warning:", rbErr);
        }
      }
      throw err;
    }
  } finally {
    releaseLock!();
  }
}

/**
 * DB 연결 종료
 */
export async function closeDB(): Promise<void> {
  try {
    await sqlite.closeConnection(DB_NAME, false);
  } catch {}
  db = null;
}

/** 테스트 전용: mock DB를 주입하여 node:sqlite 환경에서 executeInTransaction 등을 검증 가능하게 함 */
export function __setDBForTest(mock: any): void {
  db = mock;
}

/**
 * DB 및 암호화 시크릿 완전 삭제 (리셋 버튼용)
 */
export async function resetDatabase(): Promise<void> {
  // wait for in-flight transactions (drain, delete, restore) before closing and deleting the file
  await dbLockChain.catch(() => {});
  db = null;
  try { await sqlite.closeConnection(DB_NAME, false); } catch {}
  try { await CapacitorSQLite.deleteDatabase({ database: DB_NAME, readonly: false }); } catch {}
  try { await sqlite.clearEncryptionSecret(); } catch {}
  await resetNativeUsageAfterFileWipe();
  console.log("[DB] Database and encryption secret completely reset.");
}

/**
 * 등록된 지오펜스 목록을 가져옵니다.
 */
export async function getGeofences(): Promise<any[]> {
  const d = getDB();
  const res = await d.query("SELECT * FROM geofences ORDER BY id ASC"); // 모든 판정 경로와 같은 정렬 (lib/rematch.ts GEOFENCES_SQL)
  return res.values || [];
}




