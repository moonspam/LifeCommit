/**
 * LifeCommit - 합쳐진 LOCATION 커밋 1회 복구 마이그레이션 (LOC-ETC-4 새 방식)
 * 삭제/tombstone 없이, 실제로 흡수된 커밋만 그 안의 원시(150m 초과 증거)로 쪼갠다.
 */

import { LocationStrategy } from "./processor/strategies/LocationStrategy";
import type { DBRawEvent, ProcessorContext } from "./processor/types";
import { GEOFENCES_SQL, isAutoLocationSubject } from "./rematch";
import { haversineDistance } from "./geo";
import { applyProcessResult } from "./processor/utils";

export const RESTORE_LOCATIONS_FLAG = "migration_restore_squashed_locations";

export interface RestoreDb {
  query(sql: string, values?: unknown[]): Promise<{ values?: any[] }>;
  run(sql: string, params?: unknown[], tx?: boolean): Promise<unknown>;
}

export interface RestoreResult {
  restored: boolean;
  changed: number;
  splitCommitsCount?: number;
  createdCommitsCount?: number;
  reason?: string;
}

interface CommitRow {
  id: string;
  branch_id: number;
  parent_id: string | null;
  subject: string;
  body: string | null;
  author_tag: string | null;
  started_at: number;
  ended_at: number;
  duration_sec: number;
  app_package: string | null;
  event_type: string;
  squashed_events: string | null;
  geofence_name: string | null;
  lat: number | null;
  lng: number | null;
  created_at: number;
}

/**
 * 자동 커밋 여부 판별 (P2: 제목이 자동 제목과 정확히 일치하는지 포함)
 */
export function isAutoLocationCommit(
  commit: CommitRow,
  hasChild: boolean
): boolean {
  if (commit.event_type !== "LOCATION") return false;
  if (commit.author_tag != null) return false;
  if (commit.parent_id != null) return false;
  if (hasChild) return false;
  if (commit.branch_id !== 2) return false;

  // 좌표 파싱
  let lat = commit.lat;
  let lng = commit.lng;

  if (commit.body != null) {
    try {
      const parsed = JSON.parse(commit.body);
      if (typeof parsed !== "object" || parsed === null) return false;
      if (typeof parsed.lat !== "number" || (typeof parsed.lng !== "number" && typeof parsed.lon !== "number")) {
        return false;
      }
      if (lat == null) lat = parsed.lat;
      if (lng == null) lng = parsed.lng ?? parsed.lon;
    } catch {
      return false; // JSON이 아닌 일반 텍스트 메모
    }
  }

  if (lat == null || lng == null) return false;

  // 제목이 자동 제목과 정확히 일치하는지 검사 (gps: 병원 진료 메모 등은 제외)
  const geofenceName = commit.geofence_name ?? null;
  return isAutoLocationSubject(commit.subject, geofenceName, lat, lng);
}

/**
 * 합쳐진 위치 커밋 1회 복구 실행 함수 (단일 트랜잭션 내에서 실행)
 */
export async function restoreSquashedLocations(db: RestoreDb): Promise<RestoreResult> {
  // 1. 이미 마이그레이션이 완료되었는지 확인
  const flagCheck = await db.query(
    `SELECT 1 FROM app_settings WHERE key = ?`,
    [RESTORE_LOCATIONS_FLAG]
  );
  if (flagCheck.values && flagCheck.values.length > 0) {
    return { restored: false, changed: 0, reason: "already_completed" };
  }

  // 2. 부모 참조 커밋 ID 조회 (자식 존재 여부 확인용)
  const parentRefsRes = await db.query(
    `SELECT DISTINCT parent_id FROM commits WHERE parent_id IS NOT NULL`
  );
  const parentRefIds = new Set<string>(
    (parentRefsRes.values || []).map((r) => String(r.parent_id))
  );

  // 3. 지오펜스 목록 조회
  const geofencesRes = await db.query(GEOFENCES_SQL);
  const geofences: any[] = geofencesRes.values || [];

  // 4. tombstone ID 목록 조회 (새 커밋 생성 시 tombstone된 id 재사용 방지)
  const tombstonesRes = await db.query(`SELECT id FROM commit_tombstones`);
  const tombstones = new Set<string>(
    (tombstonesRes.values || []).map((r) => String(r.id))
  );

  // 5. 전체 LOCATION 커밋 순회
  const commitsRes = await db.query(
    `SELECT * FROM commits WHERE event_type = 'LOCATION' ORDER BY started_at ASC`
  );
  const locationCommits = (commitsRes.values || []) as unknown as CommitRow[];

  const strategy = new LocationStrategy();
  const context: ProcessorContext = {
    lat: null,
    lng: null,
    geofenceName: null,
    geofences,
  };

  let splitCount = 0;
  let totalCreated = 0;

  for (const C of locationCommits) {
    // 자동 커밋 판별
    const hasChild = parentRefIds.has(C.id);
    if (!isAutoLocationCommit(C, hasChild)) {
      continue;
    }

    const cLat = C.lat;
    const cLng = C.lng;
    if (cLat == null || cLng == null) continue;

    // 다른 LOCATION과 구간이 겹치면(백업 병합 등) 원시의 주인이 불분명: 같은 원시를 두 번 재생하지 않게 보존
    const overlap = await db.query(
      `SELECT 1 FROM commits WHERE event_type = 'LOCATION' AND id <> ? AND started_at <= ? AND ended_at >= ? LIMIT 1`,
      [C.id, C.ended_at, C.started_at]
    );
    if (overlap.values && overlap.values.length > 0) continue;

    // C 구간 [C.started_at, C.ended_at] 안의 is_processed=1 인 LOCATION 원시 조회
    const rawRes = await db.query(
      `SELECT id, app_package, raw_data, started_at, ended_at, is_processed
       FROM raw_events
       WHERE is_processed = 1
         AND event_type = 'LOCATION'
         AND raw_data <> '{}'
         AND raw_data IS NOT NULL
         AND started_at >= ?
         AND started_at <= ?
       ORDER BY started_at ASC`,
      [C.started_at, C.ended_at]
    );
    const rawEvents = (rawRes.values || []) as unknown as DBRawEvent[];
    if (rawEvents.length === 0) continue; // 원시 없는 백업 커밋 등 -> 손대지 않음

    // 유효 좌표 파싱 및 150m 초과 흡수 증거 확인
    const validEvents: { ev: DBRawEvent; lat: number; lng: number }[] = [];
    let hasAbsorption = false;

    for (const ev of rawEvents) {
      try {
        const raw = JSON.parse(ev.raw_data);
        const lat = raw?.lat;
        const lng = raw?.lng ?? raw?.lon;
        if (typeof lat === "number" && typeof lng === "number") {
          validEvents.push({ ev, lat, lng });
          if (haversineDistance(cLat, cLng, lat, lng) > 150) {
            hasAbsorption = true;
          }
        }
      } catch {}
    }

    // 흡수 증거(150m 초과)가 없으면 손대지 않음 (정상 체류 커밋 보존)
    if (!hasAbsorption) {
      continue;
    }

    // ── 커밋 쪼개기 실행 ──
    // 1. C를 ended_at = started_at, duration_sec = 1로 줄임 (id/제목/태그 그대로 유지)
    await db.run(
      `UPDATE commits SET ended_at = started_at, duration_sec = 1 WHERE id = ?`,
      [C.id],
      false
    );
    splitCount++;

    // 줄인 행을 다시 읽어 lastCommitCache로 설정
    const freshCRes = await db.query(`SELECT * FROM commits WHERE id = ?`, [C.id]);
    let lastCommitCache = freshCRes.values?.[0] ?? null;

    // 2. C 구간 안의 원시(started_at > C.started_at, 시간순)를 LocationStrategy에 넣어 병합/생성
    const subsequentEvents = validEvents.filter(
      (v) => Number(v.ev.started_at) > Number(C.started_at)
    );

    for (const item of subsequentEvents) {
      const result = await strategy.process(db as any, item.ev, lastCommitCache, context);
      const applied = await applyProcessResult(db, result, lastCommitCache, tombstones);
      lastCommitCache = applied.lastCommitCache;
      totalCreated += applied.createdCount;
    }
  }

  // 6. 마이그레이션 플래그 기록
  await db.run(
    `INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, '1')`,
    [RESTORE_LOCATIONS_FLAG]
  );

  // 내부 emit 제거 (processor 성공 후 emit만)

  const totalChanged = splitCount + totalCreated;
  return {
    restored: true,
    changed: totalChanged,
    splitCommitsCount: splitCount,
    createdCommitsCount: totalCreated,
  };
}

/**
 * 앱 구동 시/배치 주기마다 실행하는 최초 1회 위치 복구 오케스트레이션.
 * 실패 시 로그만 남기고 다음 주기에 재시도할 수 있도록 처리하며, 수집 처리를 방해하지 않는다.
 */
export async function restoreSquashedLocationsOnStartup<T extends RestoreDb>(
  runTx: (fn: (d: T) => Promise<RestoreResult>) => Promise<RestoreResult>
): Promise<{ changed: number }> {
  try {
    const r = await runTx((d) => restoreSquashedLocations(d));
    return { changed: r.changed };
  } catch (e) {
    console.error("Location restore failed (will retry):", e);
    return { changed: 0 };
  }
}
