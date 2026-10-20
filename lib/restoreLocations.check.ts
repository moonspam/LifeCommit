/**
 * LifeCommit - restoreSquashedLocations 단위 및 통합 검증 (sqliteTestDb)
 * 지시서 LOC-ETC-4 요구사항:
 * ① 흡수된 Home 커밋 + 구간 안 이동 원시(300m·1.5분) → 같은 id는 첫 체류로 줄고 이동 커밋 여러 개, 정지 구간은 1개
 * ② 원시 없는 백업 위치 커밋 → 그대로 유지
 * ③ 사용자가 deleteCommitWithTombstone으로 지운 위치(원시만 남음) → 다시 생기지 않음
 * ④ gps: 병원 진료 메모 제목 + 구간 안 이동 원시 → 손대지 않음
 * ⑤ 150m 이내 원시만 있는 정상 체류 → 변화 0
 * ⑥ 2회 실행 변화 0, 미처리 원시 제외, 동 이름 제목, 롤백, 파이프라인 순서
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openRaw } from "./sqliteTestDb";
import { BASE_TABLES_SCHEMA } from "./schema";
import { restoreSquashedLocations, RESTORE_LOCATIONS_FLAG } from "./restoreLocations";
import { loadDongs } from "./dong";
import { processBatch } from "./processBatch";
import { deleteCommitWithTombstone } from "./tombstones";

// 앱처럼 번들 행정동 경계를 /dong.geojson 으로 제공
globalThis.fetch = (async (url: string) => url === "/dong.geojson"
  ? { ok: true, json: async () => JSON.parse(readFileSync("android/app/src/full/assets/public/dong.geojson", "utf8")) }
  : { ok: false }) as unknown as typeof fetch;

const M = 60_000;
const DELTA_300M = 0.0027; // 약 300m

function setupDb() {
  const raw = openRaw();
  raw.d.exec(BASE_TABLES_SCHEMA);
  raw.d.prepare(`
    UPDATE geofences SET lat = 37.5000, lng = 127.0000, radius_m = 150 WHERE name = '🏠 Home'
  `).run();
  return raw;
}

/**
 * ① 흡수된 Home 커밋 + 구간 안 이동 원시(300m·1.5분)
 * → 같은 id는 첫 체류로 줄고(ended_at=started_at, duration_sec=1), 이동 커밋 여러 개, 정지 구간은 1개 생성
 */
async function testSquashedHomeCommitSplit() {
  const { d, adapter } = setupDb();

  const t0 = 100 * M;
  const step = Math.floor(1.5 * M); // 90초 (1.5분)

  // 과거 버그로 10개 원시가 통째로 합쳐져 있던 Home 커밋 1개
  d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (
      'squashed_home_commit', 2, null, 'gps: 🏠 Home 도착 및 머무름',
      '{"lat":37.5000,"lng":127.0000,"accuracy":10}', null,
      ?, ?, ?, 'system.location', 'LOCATION', '[]', '🏠 Home', 37.5000, 127.0000, ?
    )
  `).run(t0, t0 + 9 * step, Math.floor((9 * step) / 1000), t0);

  // 구간 안 원시 10개 삽입 (300m 간격 이동 -> 마지막 2개는 같은 위치로 정지, is_processed = 1)
  const insertRaw = d.prepare(`
    INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
    VALUES ('LOCATION', 'system.location', ?, ?, ?, 1)
  `);

  // 0: Home 좌표 (t0)
  insertRaw.run(JSON.stringify({ lat: 37.5000, lng: 127.0000, accuracy: 15 }), t0, t0);
  // 1~7: 300m씩 이동 (7개)
  for (let i = 1; i <= 7; i++) {
    const lat = 37.5000 + i * DELTA_300M;
    const lng = 127.0000;
    const evTime = t0 + i * step;
    insertRaw.run(JSON.stringify({ lat, lng, accuracy: 15 }), evTime, evTime);
  }
  // 8~9: 7번과 동일 위치 (정지 상태 머무름 구간 2개)
  const stayLat = 37.5000 + 7 * DELTA_300M;
  insertRaw.run(JSON.stringify({ lat: stayLat, lng: 127.0000, accuracy: 15 }), t0 + 8 * step, t0 + 8 * step);
  insertRaw.run(JSON.stringify({ lat: stayLat, lng: 127.0000, accuracy: 15 }), t0 + 9 * step, t0 + 9 * step);

  // 복구 실행
  const res = await restoreSquashedLocations(adapter);
  assert.equal(res.restored, true, "복구 성공");
  assert.equal(res.splitCommitsCount, 1, "흡수된 커밋 1개 쪼개짐");

  // 원래 id 커밋은 삭제/tombstone되지 않고 첫 체류로 줄어듦
  const homeCommit = d.prepare("SELECT * FROM commits WHERE id = 'squashed_home_commit'").get() as any;
  assert.ok(homeCommit, "원래 squashed_home_commit id 보존됨");
  assert.equal(homeCommit.started_at, t0);
  assert.equal(homeCommit.ended_at, t0, "ended_at이 started_at으로 줄어듦");
  assert.equal(homeCommit.duration_sec, 1, "duration_sec이 1로 줄어듦");
  assert.equal(homeCommit.subject, "gps: 🏠 Home 도착 및 머무름", "제목 보존");

  // tombstone에 들어가지 않음 확인
  const tomb = d.prepare("SELECT * FROM commit_tombstones WHERE id = 'squashed_home_commit'").get();
  assert.equal(tomb, undefined, "원래 커밋 id는 tombstone에 등록되지 않음");

  // 구간 안에서 새로 생성된 커밋들 확인
  // 1~6번은 300m 이동 커밋 (6개), 7~9번은 정지 구간 커밋 1개 병합 -> 총 7개 신규 생성
  const newCommits = d.prepare(
    "SELECT * FROM commits WHERE event_type = 'LOCATION' AND started_at > ? ORDER BY started_at ASC"
  ).all(t0) as any[];

  assert.equal(newCommits.length, 7, "이동 커밋 6개 + 정지 머무름 커밋 1개 = 7개 신규 생성");

  // 마지막 정지 커밋 확인
  const lastStay = newCommits[6];
  assert.equal(lastStay.started_at, t0 + 7 * step);
  assert.equal(lastStay.ended_at, t0 + 9 * step);
  assert.equal(lastStay.duration_sec, Math.floor((2 * step) / 1000));
}

/**
 * ② 원시 없는 백업 위치 커밋 → 그대로 유지
 */
async function testBackupLocationCommitPreserved() {
  const { d, adapter } = setupDb();
  const t0 = 200 * M;

  // 백업에서 복원된 LOCATION 커밋 (원시 없음)
  d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (
      'backup_loc_commit', 2, null, 'gps: 위치(37.5665, 126.9780) 도착 및 머무름',
      '{"lat":37.5665,"lng":126.9780}', null,
      ?, ?, 1800, 'system.location', 'LOCATION', '[]', null, 37.5665, 126.9780, ?
    )
  `).run(t0, t0 + 30 * M, t0);

  // 복구 실행 (해당 구간에 raw_events 없음)
  const res = await restoreSquashedLocations(adapter);
  assert.equal(res.restored, true);

  // 백업 커밋이 삭제되거나 줄어들지 않고 완벽히 보존됨
  const backupCommit = d.prepare("SELECT * FROM commits WHERE id = 'backup_loc_commit'").get() as any;
  assert.ok(backupCommit, "백업 커밋 유지됨");
  assert.equal(backupCommit.started_at, t0);
  assert.equal(backupCommit.ended_at, t0 + 30 * M, "ended_at 불변");
  assert.equal(backupCommit.duration_sec, 1800, "duration_sec 불변");
}

/**
 * ③ 사용자가 deleteCommitWithTombstone으로 지운 위치(원시만 남음) → 다시 생기지 않음
 */
async function testUserDeletedLocationNotRevived() {
  const { d, adapter } = setupDb();
  const t0 = 300 * M;

  // 사용자가 이미 과거에 생성되었다가 deleteCommitWithTombstone으로 지웠던 커밋
  d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (
      'user_deleted_id', 2, null, 'gps',
      '{"lat":37.5000,"lng":127.0000}', null,
      ?, ?, 60, 'system.location', 'LOCATION', '[]', null, 37.5000, 127.0000, ?
    )
  `).run(t0, t0 + 60_000, t0);

  // 원시 위치는 남아있음 (7일 보관)
  d.prepare(`
    INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
    VALUES ('LOCATION', 'system.location', '{"lat":37.5000,"lng":127.0000,"accuracy":10}', ?, ?, 1)
  `).run(t0, t0);

  // 사용자가 삭제 수행
  await deleteCommitWithTombstone(adapter, "user_deleted_id", t0 + 1000);
  assert.equal((d.prepare("SELECT COUNT(*) as cnt FROM commits").get() as any).cnt, 0);

  // 복구 실행
  await restoreSquashedLocations(adapter);

  // 삭제된 구간에 커밋이 다시 생성되지 않음!
  const commitCount = (d.prepare("SELECT COUNT(*) as cnt FROM commits").get() as any).cnt;
  assert.equal(commitCount, 0, "사용자가 지운 위치는 원시가 남아있어도 부활하지 않음");
}

/**
 * ④ gps: 병원 진료 메모 제목 + 구간 안 이동 원시 → 손대지 않음
 */
async function testUserCustomTitlePreserved() {
  const { d, adapter } = setupDb();
  const t0 = 400 * M;
  const step = Math.floor(1.5 * M);

  // 사용자가 gps: 접두가 붙은 커스텀 제목으로 수정한 커밋
  d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (
      'custom_title_commit', 2, null, 'gps: 병원 진료 메모',
      '{"lat":37.5000,"lng":127.0000}', null,
      ?, ?, 300, 'system.location', 'LOCATION', '[]', null, 37.5000, 127.0000, ?
    )
  `).run(t0, t0 + 5 * step, t0);

  // 구간 안 이동 원시(150m 초과)가 있더라도
  d.prepare(`
    INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
    VALUES ('LOCATION', 'system.location', '{"lat":37.5200,"lng":127.0200,"accuracy":10}', ?, ?, 1)
  `).run(t0 + step, t0 + step);

  // 복구 실행
  await restoreSquashedLocations(adapter);

  // 사용자 제목 커밋은 전혀 손대지 않음 (ended_at, duration_sec 유지)
  const commit = d.prepare("SELECT * FROM commits WHERE id = 'custom_title_commit'").get() as any;
  assert.ok(commit, "사용자 커스텀 제목 커밋 유지됨");
  assert.equal(commit.ended_at, t0 + 5 * step, "ended_at 유지됨");
  assert.equal(commit.subject, "gps: 병원 진료 메모", "사용자 제목 유지됨");
}

/**
 * ⑤ 150m 이내 원시만 있는 정상 체류 → 변화 0
 */
async function testNormalStayNoAbsorptionNoChange() {
  const { d, adapter } = setupDb();
  const t0 = 500 * M;
  const step = Math.floor(1.5 * M);

  // 정상 체류 커밋 (Home에서 30분 머무름)
  d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (
      'normal_stay_commit', 2, null, 'gps: 🏠 Home 도착 및 머무름',
      '{"lat":37.5000,"lng":127.0000,"accuracy":10}', null,
      ?, ?, 1800, 'system.location', 'LOCATION', '[]', '🏠 Home', 37.5000, 127.0000, ?
    )
  `).run(t0, t0 + 20 * step, t0);

  // 구간 안 원시들이 모두 150m 이내 (Home 50m 이내 미세 이동)
  const insertRaw = d.prepare(`
    INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
    VALUES ('LOCATION', 'system.location', ?, ?, ?, 1)
  `);
  for (let i = 0; i < 5; i++) {
    // 0.0001도 = 약 11m
    const lat = 37.5000 + i * 0.0001;
    insertRaw.run(JSON.stringify({ lat, lng: 127.0000, accuracy: 10 }), t0 + i * step, t0 + i * step);
  }

  // 복구 실행
  const res = await restoreSquashedLocations(adapter);
  assert.equal(res.restored, true);
  assert.equal(res.changed, 0, "흡수 증거가 없으므로 변경 0");

  const commit = d.prepare("SELECT * FROM commits WHERE id = 'normal_stay_commit'").get() as any;
  assert.equal(commit.ended_at, t0 + 20 * step, "정상 체류 커밋의 ended_at은 축소되지 않음");
  assert.equal(commit.duration_sec, 1800);
}

/**
 * ⑥ 2회 실행 변화 0, 미처리 원시 제외, 동 이름 제목, 롤백, 파이프라인 순서
 */
async function testAdditionalInvariants() {
  await loadDongs();

  // 1) 동 이름 제목 검증: 흡수된 커밋 쪼개기 시 지오펜스 없는 지역이면 동 이름으로 새 커밋 생성
  {
    const raw = openRaw();
    raw.d.exec(BASE_TABLES_SCHEMA);
    raw.d.exec("DELETE FROM geofences"); // 지오펜스 제거
    const t0 = 600 * M;
    const step = Math.floor(1.5 * M);

    // 서울 시청 좌표 (서울특별시 중구 명동)
    const cityHallLat = 37.5663;
    const cityHallLng = 126.9779;

    raw.d.prepare(`
      INSERT INTO commits (
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      ) VALUES (
        'city_squashed', 2, null, 'gps: 서울특별시 중구 명동 도착 및 머무름',
        '{"lat":37.5663,"lng":126.9779}', null,
        ?, ?, 600, 'system.location', 'LOCATION', '[]', null, ?, ?, ?
      )
    `).run(t0, t0 + 2 * step, cityHallLat, cityHallLng, t0);

    // 0: 시청 좌표 (t0)
    raw.d.prepare(`
      INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
      VALUES ('LOCATION', 'system.location', ?, ?, ?, 1)
    `).run(JSON.stringify({ lat: cityHallLat, lng: cityHallLng, accuracy: 10 }), t0, t0);

    // 1: 300m 떨어진 이동 원시 (t0 + step)
    raw.d.prepare(`
      INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
      VALUES ('LOCATION', 'system.location', ?, ?, ?, 1)
    `).run(JSON.stringify({ lat: cityHallLat + DELTA_300M, lng: cityHallLng, accuracy: 10 }), t0 + step, t0 + step);

    const res = await restoreSquashedLocations(raw.adapter);
    assert.equal(res.restored, true);

    // 쪼개져서 새로 생긴 커밋의 subject가 동 이름인지 확인
    const newCommit = raw.d.prepare("SELECT * FROM commits WHERE started_at = ?").get(t0 + step) as any;
    assert.ok(newCommit, "이동 커밋 생성됨");
    assert.ok(!newCommit.subject.includes("위치("), "좌표 라벨 아님");
    assert.ok(newCommit.subject.includes("도착 및 머무름"), "도착 및 머무름 서식 포함");
  }

  // 2) is_processed = 0 원시 제외 검증
  {
    const { d, adapter } = setupDb();
    const t0 = 700 * M;
    const t1 = t0 + 2 * M;

    d.prepare(`
      INSERT INTO commits (
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      ) VALUES (
        'squashed_to_test_unprocessed', 2, null, 'gps: 🏠 Home 도착 및 머무름',
        '{"lat":37.5000,"lng":127.0000}', null,
        ?, ?, 600, 'system.location', 'LOCATION', '[]', '🏠 Home', 37.5000, 127.0000, ?
      )
    `).run(t0, t0 + 5 * M, t0);

    // t0 시점 원시 (is_processed = 1)
    d.prepare(`
      INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
      VALUES ('LOCATION', 'system.location', '{"lat":37.5000,"lng":127.0000,"accuracy":10}', ?, ?, 1)
    `).run(t0, t0);

    // t0+1분: 300m 이동 원시 (is_processed = 1) -> 흡수 증거
    d.prepare(`
      INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
      VALUES ('LOCATION', 'system.location', '{"lat":37.5100,"lng":127.0100,"accuracy":10}', ?, ?, 1)
    `).run(t0 + M, t0 + M);

    // t1: 수집된 지 얼마 안 된 미처리 원시 (is_processed = 0)
    d.prepare(`
      INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed)
      VALUES ('LOCATION', 'system.location', '{"lat":37.5200,"lng":127.0200,"accuracy":10}', ?, ?, 0)
    `).run(t1, t1);

    await restoreSquashedLocations(adapter);

    // 복구 직후: t1 시각 커밋은 생성되지 않아야 함 (미처리 원시는 복구 대상 아님)
    const commitAtT1 = d.prepare("SELECT * FROM commits WHERE started_at = ?").get(t1);
    assert.equal(commitAtT1, undefined, "미처리 원시는 복구에서 처리되지 않음");

    // 뒤이어 processBatch 실행 시 t1 원시 정상 처리
    const processed = await processBatch(adapter as any);
    assert.equal(processed, 1, "processBatch가 미처리 원시 1개 처리");
    assert.ok(d.prepare("SELECT * FROM commits WHERE started_at = ?").get(t1), "processBatch로 커밋 생성됨");
  }

  // 3) 2회차 실행 변화 0
  {
    const { d, adapter } = setupDb();
    d.prepare("INSERT INTO app_settings (key, value) VALUES (?, '1')").run(RESTORE_LOCATIONS_FLAG);
    const res = await restoreSquashedLocations(adapter);
    assert.equal(res.restored, false);
    assert.equal(res.changed, 0);
  }

  // 4) 트랜잭션 롤백 검증: 복구 중 예외 발생 시 플래그와 커밋 롤백 확인
  {
    const raw = openRaw();
    raw.d.exec(BASE_TABLES_SCHEMA);
    const t0 = 800 * M;
    raw.d.prepare(`
      INSERT INTO commits (
        id, branch_id, parent_id, subject, body, author_tag,
        started_at, ended_at, duration_sec, app_package,
        event_type, squashed_events, geofence_name, lat, lng, created_at
      ) VALUES ('commit_tx_test', 2, null, 'gps: 🏠 Home 도착 및 머무름', '{"lat":37.5,"lng":127.0}', null, ?, ?, 600, 'system.location', 'LOCATION', '[]', '🏠 Home', 37.5, 127.0, ?)
    `).run(t0, t0 + 600_000, t0);

    // 트랜잭션 시작 후 복구 호출하고 예외 던져서 ROLLBACK
    raw.d.exec("BEGIN");
    try {
      await restoreSquashedLocations(raw.adapter);
      throw new Error("simulated failure after restore");
    } catch {
      raw.d.exec("ROLLBACK");
    }

    // 롤백 확인: 플래그 미생성, 원래 커밋 유지
    const flag = raw.d.prepare("SELECT value FROM app_settings WHERE key = ?").get(RESTORE_LOCATIONS_FLAG);
    assert.equal(flag, undefined, "예외 시 플래그 롤백");
    const commit = raw.d.prepare("SELECT ended_at FROM commits WHERE id = 'commit_tx_test'").get() as any;
    assert.equal(commit.ended_at, t0 + 600_000, "예외 시 커밋 상태 롤백");
  }

  // 5) 파이프라인 순서 검증 (processRawEventsBatch 함수 본문 내)
  {
    const processorSrc = readFileSync("lib/processor.ts", "utf8");
    const fnBody = processorSrc.slice(processorSrc.indexOf("async function processRawEventsBatch"));
    const loadDongsIdx = fnBody.indexOf("await loadDongs()");
    const rematchIdx = fnBody.indexOf("rematchOnStartup");
    const restoreIdx = fnBody.indexOf("restoreSquashedLocationsOnStartup");
    const processBatchIdx = fnBody.indexOf("processBatch(d)");

    assert.ok(loadDongsIdx > 0, "loadDongs 호출 존재");
    assert.ok(rematchIdx > loadDongsIdx, "loadDongs 이후 rematchOnStartup 호출");
    assert.ok(restoreIdx > rematchIdx, "rematchOnStartup 이후 restoreSquashedLocationsOnStartup 호출");
    assert.ok(processBatchIdx > restoreIdx, "restoreSquashedLocationsOnStartup 이후 processBatch 호출");
  }
}

/** 89차: 백업으로 겹치게 들어온 LOCATION 구간 → 둘 다 보존, 새 커밋 0 */
async function testOverlappingCommitsPreserved() {
  const { d, adapter } = setupDb();
  const ins = d.prepare(`INSERT INTO commits (id, branch_id, parent_id, subject, body, author_tag, started_at, ended_at, duration_sec,
    app_package, event_type, squashed_events, geofence_name, lat, lng, created_at)
    VALUES (?, 2, null, ?, ?, null, ?, ?, ?, 'system.location', 'LOCATION', '[]', null, ?, 127, 0)`);
  await loadDongs();
  const { locationSubject } = await import("./rematch");
  ins.run("A", locationSubject(null, 37.50, 127), JSON.stringify({ lat: 37.50, lng: 127 }), 100 * M, 110 * M, 600, 37.50);
  ins.run("B", locationSubject(null, 37.51, 127), JSON.stringify({ lat: 37.51, lng: 127 }), 105 * M, 110 * M, 300, 37.51);
  const raw = d.prepare(`INSERT INTO raw_events (event_type, app_package, raw_data, started_at, ended_at, is_processed, processed_at)
    VALUES ('LOCATION', 'system.location', ?, ?, ?, 1, ?)`);
  for (const [min, lat] of [[100, 37.50], [105, 37.51], [106, 37.52], [107, 37.52], [110, 37.52]] as const)
    raw.run(JSON.stringify({ lat, lng: 127 }), min * M, min * M, min * M);
  const res = await restoreSquashedLocations(adapter);
  assert.equal(res.changed, 0, "겹친 구간은 손대지 않음");
  const rows = d.prepare("SELECT id, started_at, ended_at FROM commits ORDER BY id").all() as any[];
  assert.deepEqual(rows.map((r) => [r.id, r.started_at, r.ended_at]), [["A", 100 * M, 110 * M], ["B", 105 * M, 110 * M]]);
}

async function main() {
  await testSquashedHomeCommitSplit();
  await testBackupLocationCommitPreserved();
  await testUserDeletedLocationNotRevived();
  await testUserCustomTitlePreserved();
  await testNormalStayNoAbsorptionNoChange();
  await testAdditionalInvariants();
  await testOverlappingCommitsPreserved();
  console.log("all restoreLocations checks passed");
}

main();
