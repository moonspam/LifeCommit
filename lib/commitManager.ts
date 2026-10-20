/**
 * LifeCommit - 수동 커밋 생성 & 커밋 관리 모듈
 */

import { deleteCommitWithTombstone } from "./tombstones";
import { executeInTransaction } from "./db";
import { matchGeofence } from "./geo";
import { GEOFENCES_SQL } from "./rematch";
import { getCurrentGPSCoordinates } from "./geofenceManager";
import { emit, EVENT_COMMITS_UPDATED } from "./events";
import { setAppBranchOverride as setCachedAppBranchOverride } from "./processor/utils";

export interface ManualCommitInput {
  subject: string;
  body?: string;
  branchName?: string;
  authorTag?: string;
  durationMinutes?: number;
  startedAt?: number;
  endedAt?: number;
}

/**
 * 수동 커밋 등록 (Quick Manual Commit)
 */
export async function createManualCommit(input: ManualCommitInput): Promise<string> {
  const now = Date.now();
  const commitId = `commit_m_${now}_${Math.random().toString(36).substring(2, 6)}`;
  
  const durationSec = (input.durationMinutes || 0) * 60;
  const endedAt = input.endedAt || now;
  const startedAt = input.startedAt || (endedAt - durationSec * 1000);
  const branchName = input.branchName?.trim() || "main";

  // 현재 위치 — 외부 대기(GPS)는 트랜잭션 밖에서, 장소 매칭은 삽입 트랜잭션 안에서
  let lat: number | null = null;
  let lng: number | null = null;

  try {
    const coords = await getCurrentGPSCoordinates();
    if (coords) {
      lat = coords.lat;
      lng = coords.lng;
    }
  } catch {}

  const authorTag = input.authorTag?.trim()
    ? (input.authorTag.startsWith("#") ? input.authorTag : `#${input.authorTag}`)
    : "#manual";

  // 브랜치·부모 조회와 삽입은 한 트랜잭션: 조회한 부모가 삽입 전에 지워져 FK가 깨지는 경쟁을 막는다
  await executeInTransaction(async (d) => {
    // 0. 장소 매칭 (같은 트랜잭션: 장소 편집과 경쟁하지 않음)
    const geofenceName: string | null = lat !== null && lng !== null
      ? matchGeofence(lat, lng, (await d.query(GEOFENCES_SQL)).values || [])?.name ?? null
      : null;

    // 1. 브랜치 ID 확인 (없으면 자동 생성)
    let branchId = 1;
    const branchRes = await d.query("SELECT id FROM branches WHERE name = ?", [branchName]);
    if (branchRes.values && branchRes.values.length > 0) {
      branchId = branchRes.values[0].id;
    } else {
      const newBranch = await d.run("INSERT INTO branches (name, color, created_at) VALUES (?, ?, ?)", [branchName, "#a371f7", now], false);
      branchId = newBranch.changes?.lastId || 1;
    }

    // 2. 부모 커밋 ID 조회
    const parentRes = await d.query("SELECT id FROM commits WHERE branch_id = ? ORDER BY started_at DESC LIMIT 1", [branchId]);
    const parentId = parentRes.values && parentRes.values.length > 0 ? parentRes.values[0].id : null;

    // 3. 커밋 삽입
    await d.run(
      `INSERT INTO commits (
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [commitId, branchId, parentId, input.subject.trim(), input.body?.trim() || null, authorTag,
       startedAt, endedAt, durationSec, "com.lifecommit.manual", "manual", "[]", geofenceName, lat, lng, now],
      false
    );
  }, { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
  return commitId;
}

/**
 * 커밋 삭제 (Delete / Revert)
 */
export async function deleteCommit(commitId: string): Promise<void> {
  // tombstone + delete in one transaction: the id is never re-inserted by usage sync or a restore
  await executeInTransaction((d) => deleteCommitWithTombstone(d, commitId, Date.now()), { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 커밋 브랜치 또는 메시지 수정
 */
export async function updateCommit(
  commitId: string,
  subject: string,
  body?: string,
  authorTag?: string
): Promise<void> {
  await executeInTransaction((d) => d.run(
    `UPDATE commits
     SET subject = ?, body = ?, author_tag = ?
     WHERE id = ?`,
    [subject.trim(), body?.trim() || null, authorTag?.trim() || null, commitId],
    false
  ), { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}

export async function setAppBranchOverride(appPackage: string, branchId: number): Promise<void> {
  if (!appPackage || appPackage === "com.lifecommit.manual") return;
  await executeInTransaction(async (db) => {
    await db.run(
      `INSERT INTO app_branch_overrides (app_package, branch_id) VALUES (?, ?)
       ON CONFLICT(app_package) DO UPDATE SET branch_id = excluded.branch_id`,
      [appPackage, branchId]
    );
    await db.run("UPDATE commits SET branch_id = ? WHERE app_package = ?", [branchId, appPackage]);
  });
  setCachedAppBranchOverride(appPackage, branchId);
  emit(EVENT_COMMITS_UPDATED);
}

export interface DuplicateCommitCandidate {
  id?: string;
  started_at?: number;
  ended_at?: number;
  startedAt?: number;
  endedAt?: number;
  duration_sec?: number;
  durationSec?: number;
  event_type?: string | null;
  eventType?: string | null;
  app_package?: string | null;
  appPackage?: string | null;
  subject?: string | null;
  body?: string | null;
}

/**
 * 두 연속 커밋이 중복으로 병합 대상인지 판정하는 순수 함수.
 * LOCATION 커밋은 LocationStrategy에서 이미 150m/LOCATION_GAP_MS 기준으로 관리되므로
 * 거리와 무관하게 병합/삭제되는 것을 방지하기 위해 항상 false를 반환합니다.
 */
export function shouldMergeDuplicate(
  prev: DuplicateCommitCandidate,
  curr: DuplicateCommitCandidate
): boolean {
  const prevType = (prev.event_type ?? prev.eventType ?? "").toUpperCase();
  const currType = (curr.event_type ?? curr.eventType ?? "").toUpperCase();

  // LOCATION 커밋은 cleanupDuplicateCommits에서 병합/삭제 대상에서 제외
  if (prevType === "LOCATION" || currType === "LOCATION") {
    return false;
  }

  const prevEndedAt = prev.ended_at ?? prev.endedAt ?? 0;
  const currStartedAt = curr.started_at ?? curr.startedAt ?? 0;
  const gap = currStartedAt - prevEndedAt;

  // 1. SMS 커밋 중복/연속 수신 정리 (동일 발신자 번호/이름 및 5분 이내 연속 SMS)
  if (currType === "SMS" && prevType === "SMS") {
    if (gap >= 300000) return false;
    let prevPhone = "";
    let currPhone = "";
    try {
      prevPhone = JSON.parse(prev.body || "{}").phoneNumber || "";
      currPhone = JSON.parse(curr.body || "{}").phoneNumber || "";
    } catch {}

    if (prevPhone && currPhone) {
      return prevPhone === currPhone;
    }
    const prevPrefix = (prev.subject || "").split('"')[0];
    const currPrefix = (curr.subject || "").split('"')[0];
    return !!prevPrefix && prevPrefix === currPrefix;
  }

  // 2. 동일 앱 패키지 및 3분 이내 연속 사용 커밋 병합
  const prevPkg = prev.app_package ?? prev.appPackage;
  const currPkg = curr.app_package ?? curr.appPackage;
  if (
    prevPkg &&
    currPkg &&
    prevPkg === currPkg &&
    prevType === currType &&
    gap < 180000
  ) {
    return true;
  }

  // 3. 동일한 제목(subject)이고 3분 이내 간격인 커밋 병합
  const prevSubject = prev.subject || "";
  const currSubject = curr.subject || "";
  if (prevSubject && prevSubject === currSubject && gap < 180000) {
    return true;
  }

  return false;
}

export interface DedupDb {
  query(sql: string, values?: unknown[]): Promise<{ values?: any[] }>;
  run(sql: string, values?: unknown[], tx?: boolean): Promise<any>;
}

/**
 * 트랜잭션 DB 핸들을 받아 중복 커밋을 병합/삭제하는 코어 로직
 */
export async function cleanupDuplicateCommitsIn(d: DedupDb): Promise<{ mergedCount: number; deletedCount: number }> {
  let mergedCount = 0;
  let deletedCount = 0;

  // the list is read inside the transaction: a delete between reading and merging cannot leave a stale list
  // 최근 150개 커밋만 빠르게 스캔하여 불필요한 전체 테이블 풀스캔 방지
  const res = await d.query(
    // us: = UsageStats sessions (lib/usageSync.ts); already exact, merging/deleting them would break the sync cursor
    "SELECT * FROM (SELECT * FROM commits WHERE id NOT LIKE 'us:%' ORDER BY started_at DESC LIMIT 150) ORDER BY started_at ASC"
  );
  const commits: any[] = res.values || [];
  if (commits.length === 0) return { mergedCount: 0, deletedCount: 0 };
  let prev = commits[0];

  for (let i = 1; i < commits.length; i++) {
    const curr = commits[i];

    // 1. 연속된 불필요한 MERGE 커밋 정리 (LOCATION 커밋은 제외)
    if (
      curr.event_type === "MERGE" &&
      (prev.event_type === "MERGE" || (prev.event_type !== "LOCATION" && curr.started_at - prev.ended_at < 5000))
    ) {
      await d.run("DELETE FROM commits WHERE id = ?", [curr.id], false);
      deletedCount++;
      continue;
    }

    if (!shouldMergeDuplicate(prev, curr)) {
      prev = curr;
      continue;
    }

    const gap = curr.started_at - prev.ended_at;

    // 2. SMS 커밋 중복/연속 수신 정리 (동일 발신자 번호/이름이거나 5분 이내 연속 SMS)
    if (curr.event_type === "SMS" && prev.event_type === "SMS" && gap < 300000) {
      let prevPhone = "";
      let currPhone = "";
      try {
        prevPhone = JSON.parse(prev.body || "{}").phoneNumber || "";
        currPhone = JSON.parse(curr.body || "{}").phoneNumber || "";
      } catch {}

      const isSamePhone = prevPhone && currPhone ? prevPhone === currPhone : (prevPhone === currPhone || (prev.subject.split('"')[0] === curr.subject.split('"')[0]));

      if (isSamePhone) {
        const newEndedAt = Math.max(prev.ended_at, curr.ended_at);
        const newDuration = Math.max(1, Math.floor((newEndedAt - prev.started_at) / 1000));

        // 이전 커밋에 최신 SMS 본문 및 시간 반영
        await d.run(
          "UPDATE commits SET ended_at = ?, duration_sec = ?, subject = ?, body = ? WHERE id = ?",
          [newEndedAt, newDuration, curr.subject, curr.body, prev.id],
          false
        );
        await d.run("DELETE FROM commits WHERE id = ?", [curr.id], false);
        prev.ended_at = newEndedAt;
        prev.duration_sec = newDuration;
        prev.subject = curr.subject;
        prev.body = curr.body;
        mergedCount++;
        deletedCount++;
        continue;
      }
    }

    // 3. 동일 앱 패키지 및 동일 제목 커밋 병합
    const newEndedAt = Math.max(prev.ended_at, curr.ended_at);
    const newDuration = Math.max(1, Math.floor((newEndedAt - prev.started_at) / 1000));

    await d.run(
      "UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?",
      [newEndedAt, newDuration, prev.id],
      false
    );
    await d.run("DELETE FROM commits WHERE id = ?", [curr.id], false);
    prev.ended_at = newEndedAt;
    prev.duration_sec = newDuration;
    mergedCount++;
    deletedCount++;
    continue;
  }

  return { mergedCount, deletedCount };
}

/**
 * 기존에 중복으로 누적된 커밋들을 단 1개로 통합/정리 (Auto-Deduplication, 최근 150개 커밋 고속 스캔)
 */
export async function cleanupDuplicateCommits(): Promise<{ mergedCount: number; deletedCount: number }> {
  try {
    let result = { mergedCount: 0, deletedCount: 0 };

    await executeInTransaction(async (d) => {
      result = await cleanupDuplicateCommitsIn(d);
    });

    if (result.deletedCount > 0) {
      emit(EVENT_COMMITS_UPDATED);
      console.log(`[Deduplication] Cleaned up ${result.deletedCount} duplicate/redundant commits.`);
    }

    return result;
  } catch (err) {
    console.error("[Deduplication] Failed to cleanup duplicates:", err);
    return { mergedCount: 0, deletedCount: 0 };
  }
}
