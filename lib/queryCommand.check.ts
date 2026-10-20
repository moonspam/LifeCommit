/**
 * lib/queryCommand.check.ts
 * QB-C-2: 76차 검수 반려 대응 종합 검증
 * - 숫자 섞인 사람 이름 vs 전화번호 정확 판별 & 전화/메신저 분리
 * - 포맷터 왕복 (동명 전화 2명 각각, 동명 앱 라벨 2개 각각, 동명 geofence/dong, 특수문자 공백/"/'/\/@ 시작 대상)
 * - 대상 옵션 둘 이상 지정 오류, 값 없는 플래그에 =... 오류
 * - 장소 반경·좌표 유효성 검증 (add/update) 및 과거 기록 불변
 * - 터미널 git log 확장 명령 및 git commit -m 메시지 저장 검증
 */

import assert from "node:assert";
import { openInitialised } from "./sqliteTestDb";
import { tokenizeCommandLine } from "./commandToken";
import { parseQueryCommand, formatQueryCommand, parseDateSpec } from "./queryCommand";
import { loadQueryContext, runQuery } from "./queryRun";
import { type QueryRequest, datePreset, validateRequest, normalizeTag } from "./query";
import { executeTerminalCommand } from "../components/Terminal/terminalCommands";
import { addGeofence, updateGeofence, fetchGeofences, validateGeofenceParams } from "./geofenceManager";
import { addContactTag, updateContactTag, fetchContactTags } from "./tagManager";
import { __setDBForTest } from "./db";

async function runQueryCommandChecks() {
  console.log("=== 1. 토크나이저 및 따옴표 3가지 형태 검증 ===");
  // 따옴표 세 형태 동일 결과
  const t1 = tokenizeCommandLine('git log --app="삼성 인터넷"');
  const t2 = tokenizeCommandLine("git log --app='삼성 인터넷'");
  const t3 = tokenizeCommandLine('git log "--app=삼성 인터넷"');
  assert.deepStrictEqual(t1, ["git", "log", "--app=삼성 인터넷"]);
  assert.deepStrictEqual(t2, ["git", "log", "--app=삼성 인터넷"]);
  assert.deepStrictEqual(t3, ["git", "log", "--app=삼성 인터넷"]);

  // 이스케이프 및 특수문자
  const tEsc = tokenizeCommandLine('git log --app="My \\"Best\\" \\\\ App"');
  assert.deepStrictEqual(tEsc, ["git", "log", '--app=My "Best" \\ App']);

  // 닫히지 않은 따옴표 에러
  assert.throws(() => tokenizeCommandLine('git log --app="삼성 인터넷'), /닫히지 않은 따옴표/);
  assert.throws(() => tokenizeCommandLine("git log --app='삼성 인터넷"), /닫히지 않은 따옴표/);

  // git commit -m "공백 있는 메시지" 유지
  const tCommit = tokenizeCommandLine('git commit -m "오늘의 의미 있는 커밋 메시지"');
  assert.deepStrictEqual(tCommit, ["git", "commit", "-m", "오늘의 의미 있는 커밋 메시지"]);

  console.log("=== 2. 실제 SQLite DB 준비 및 테스트 데이터 삽입 ===");
  const { adapter } = await openInitialised();

  await adapter.run("DELETE FROM geofences");
  await adapter.run("DELETE FROM contact_tags");
  await adapter.run("DELETE FROM commits");

  // 지오펜스 장소 등록
  await adapter.run(
    "INSERT INTO geofences (id, name, lat, lng, radius_m, branch_trigger) VALUES (1, '회사', 37.5000, 127.0300, 150, 'work')"
  );
  await adapter.run(
    "INSERT INTO geofences (id, name, lat, lng, radius_m, branch_trigger) VALUES (2, '카페', 37.5010, 127.0310, 100, 'cafe')"
  );
  await adapter.run(
    "INSERT INTO geofences (id, name, lat, lng, radius_m, branch_trigger) VALUES (3, '역삼1동', 37.5020, 127.0320, 150, 'main')"
  );

  // 연락처 태그 매핑
  await adapter.run(
    "INSERT INTO contact_tags (id, contact_key, contact_name, tag, phone_number) VALUES (1, 'tel:01011112222', '김동료', '#work', '010-1111-2222')"
  );
  await adapter.run(
    "INSERT INTO contact_tags (id, contact_key, contact_name, tag, phone_number) VALUES (2, 'tel:01033334444', '이친구', '#friends', '010-3333-4444')"
  );
  await adapter.run(
    "INSERT INTO contact_tags (id, contact_key, contact_name, tag, phone_number) VALUES (3, 'tel:01055556666', '박친구', '#friends', '010-5555-6666')"
  );

  // 커밋 기록 삽입 (기준 시각: 2026-10-18T14:00:00+09:00)
  const now = new Date("2026-10-18T15:00:00+09:00");
  const tsBase = new Date("2026-10-18T10:00:00+09:00").getTime();
  const tsAfternoon = new Date("2026-10-18T14:00:00+09:00").getTime();
  const tsEvening = new Date("2026-10-18T19:00:00+09:00").getTime();
  const tsYesterday = new Date("2026-10-17T14:00:00+09:00").getTime();

  // 1) APP_USAGE
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, app_package, created_at)
     VALUES ('app-1', 1, 'APP_USAGE', '유튜브 시청', ${tsBase}, ${tsBase + 1800000}, 1800, 'com.google.android.youtube', ${tsBase})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, app_package, created_at)
     VALUES ('app-2', 1, 'APP_USAGE', '유튜브 시청 2', ${tsAfternoon}, ${tsAfternoon + 1200000}, 1200, 'com.google.android.youtube', ${tsAfternoon})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, app_package, created_at)
     VALUES ('app-3', 1, 'APP_USAGE', '카카오톡 확인', ${tsEvening}, ${tsEvening + 300000}, 300, 'com.kakao.talk', ${tsEvening})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, app_package, created_at)
     VALUES ('app-4', 1, 'APP_USAGE', '어제 유튜브', ${tsYesterday}, ${tsYesterday + 600000}, 600, 'com.google.android.youtube', ${tsYesterday})`
  );

  // 2) CALL
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('call-1', 1, 'CALL', '김동료 통화', ${tsBase}, ${tsBase + 180000}, 180, '{"phoneNumber":"010-1111-2222","contactName":"김동료"}', ${tsBase})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('call-2', 1, 'CALL', '이친구 통화', ${tsAfternoon}, ${tsAfternoon + 300000}, 300, '{"phoneNumber":"010-3333-4444","contactName":"이친구"}', ${tsAfternoon})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('call-3', 1, 'CALL', '박친구 통화', ${tsEvening}, ${tsEvening + 120000}, 120, '{"phoneNumber":"010-5555-6666","contactName":"박친구"}', ${tsEvening})`
  );

  // 3) SMS
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('sms-1', 1, 'SMS', '이친구 문자', ${tsBase}, ${tsBase}, 0, '{"phoneNumber":"010-3333-4444","contactName":"이친구"}', ${tsBase})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('sms-2', 1, 'SMS', '이친구 문자 2', ${tsAfternoon}, ${tsAfternoon}, 0, '{"phoneNumber":"010-3333-4444","contactName":"이친구"}', ${tsAfternoon})`
  );

  // 4) REPLY
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, body, created_at)
     VALUES ('rep-1', 1, 'REPLY', '이친구 카톡 답장', ${tsAfternoon}, ${tsAfternoon}, 0, '{"sender":"이친구","packageName":"com.kakao.talk"}', ${tsAfternoon})`
  );

  // 5) LOCATION
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, geofence_name, lat, lng, created_at)
     VALUES ('loc-1', 1, 'LOCATION', '회사 근무', ${tsBase}, ${tsBase + 14400000}, 14400, '회사', 37.5000, 127.0300, ${tsBase})`
  );
  await adapter.run(
    `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, geofence_name, lat, lng, created_at)
     VALUES ('loc-2', 1, 'LOCATION', '카페 휴식', ${tsAfternoon}, ${tsAfternoon + 3600000}, 3600, '카페', 37.5010, 127.0310, ${tsAfternoon})`
  );

  // Mock 행정동 함수 제공하는 query context 로드
  const mockDongAt = (lat: number, lng: number): string | null => {
    if (lat > 37.49 && lat < 37.51) return "역삼1동";
    return null;
  };

  const qctx = await loadQueryContext(adapter);
  qctx.dongAt = mockDongAt;
  qctx.candidates.places.push({ source: "dong", name: "역삼1동", visited: true });

  console.log("=== 3. 패널 경로 vs 명령 경로 로직 통일 (12개 조건) ===");
  const testCases: { name: string; req: QueryRequest; cmdStr: string }[] = [
    {
      name: "1) 앱 전체 오늘 시간",
      req: { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "app", target: null, metric: "duration" },
      cmdStr: "git log --type=app --duration",
    },
    {
      name: "2) 특정 앱(YouTube) 오늘 시간",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "app",
        target: { type: "app", pkg: "com.google.android.youtube" },
        metric: "duration",
      },
      cmdStr: "git log --type=app --app=com.google.android.youtube --duration",
    },
    {
      name: "3) 특정 앱(YouTube) 단독 추론 및 횟수",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "app",
        target: { type: "app", pkg: "com.google.android.youtube" },
        metric: "count",
      },
      cmdStr: "git log --app=com.google.android.youtube --count",
    },
    {
      name: "4) 통화 전체 오늘 횟수",
      req: { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "call", target: null, metric: "count" },
      cmdStr: "git log --type=call --count",
    },
    {
      name: "5) 특정 사람 통화 횟수",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "call",
        target: { type: "person", key: "tel:01033334444" },
        metric: "count",
      },
      cmdStr: "git log --type=call --author=이친구 --count",
    },
    {
      name: "6) 태그 통화 횟수 (@friends)",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "call",
        target: { type: "tag", tag: "friends" },
        metric: "count",
      },
      cmdStr: "git log --type=call --author=@friends --count",
    },
    {
      name: "7) 문자 특정 사람 대화 횟수",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "sms",
        target: { type: "person", key: "tel:01033334444" },
        metric: "count",
      },
      cmdStr: "git log --type=sms --author=이친구 --count",
    },
    {
      name: "8) 답장 특정 사람 횟수",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "reply",
        target: { type: "person", key: "msg:com.kakao.talk:이친구" },
        metric: "count",
      },
      cmdStr: "git log --type=reply --author=이친구 --count",
    },
    {
      name: "9) 장소 전체 방문 횟수",
      req: { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: null, metric: "count" },
      cmdStr: "git log --type=location --count",
    },
    {
      name: "10) 특정 등록 장소(회사) 방문 시간 (단독 추론)",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "location",
        target: { type: "place", source: "geofence", name: "회사" },
        metric: "duration",
      },
      cmdStr: 'git log --place="geofence:회사" --duration',
    },
    {
      name: "11) 특정 시간대 (afternoon) 앱 목록",
      req: {
        from: "2026-10-18",
        to: "2026-10-18",
        timeOfDay: "afternoon",
        kind: "app",
        target: null,
        metric: "list",
      },
      cmdStr: "git log --type=app --time=afternoon",
    },
    {
      name: "12) 기간 조건 (어제부터 오늘까지)",
      req: {
        from: "2026-10-17",
        to: "2026-10-18",
        timeOfDay: "any",
        kind: "app",
        target: { type: "app", pkg: "com.google.android.youtube" },
        metric: "duration",
      },
      cmdStr: "git log --type=app --app=com.google.android.youtube --since=yesterday --until=today --duration",
    },
  ];

  for (const tc of testCases) {
    const panelRes = await runQuery(tc.req, adapter, qctx);
    assert.strictEqual(panelRes.ok, true, `패널 경로 실패: ${tc.name}`);

    const tokens = tokenizeCommandLine(tc.cmdStr);
    const parsed = parseQueryCommand(tokens, qctx.candidates, now);
    assert.strictEqual(parsed.ok, true, `명령 파싱 실패: ${tc.name} (${tc.cmdStr})`);
    const cmdRes = await runQuery(parsed.value, adapter, qctx);
    assert.strictEqual(cmdRes.ok, true, `명령 경로 실행 실패: ${tc.name}`);

    assert.strictEqual(panelRes.value.value, cmdRes.value.value, `value 불일치: ${tc.name}`);
    assert.strictEqual(panelRes.value.summary, cmdRes.value.summary, `summary 불일치: ${tc.name}`);
    const panelRowIds = panelRes.value.rows.map((r) => r.id);
    const cmdRowIds = cmdRes.value.rows.map((r) => r.id);
    assert.deepStrictEqual(panelRowIds, cmdRowIds, `근거 행 id 목록 불일치: ${tc.name}`);
    console.log(`  ✓ ${tc.name} 통과`);
  }

  console.log("=== 4. P2-1: 숫자 섞인 이름 vs 전화번호 정확 판별 & 전화/메신저 분리 검증 ===");
  const testCandidatesWithNumberName = {
    ...qctx.candidates,
    call: [
      { key: "tel:01055556666", name: "Team01011112222", label: "Team01011112222", saved: true, tag: null, tags: [], lastAt: 100 },
      { key: "tel:01011112222", name: "SameName", label: "SameName", saved: true, tag: null, tags: [], lastAt: 200 },
    ],
  };

  // 1) Team01011112222 입력 시 이름 경로로 Team...이 선택되어야 함 (SameName의 01011112222로 오해 금지)
  const pTeam = parseQueryCommand(tokenizeCommandLine("git log --type=call --author=Team01011112222 --count"), testCandidatesWithNumberName, now);
  assert.strictEqual(pTeam.ok, true);
  assert.deepStrictEqual(pTeam.value.target, { type: "person", key: "tel:01055556666" }, "Team01011112222 이름이 정확히 매칭되어야 함");

  // 2) 01011112222 전화번호 입력 시 번호 경로로 SameName이 선택되어야 함
  const pPhone = parseQueryCommand(tokenizeCommandLine("git log --type=call --author=01011112222 --count"), testCandidatesWithNumberName, now);
  assert.strictEqual(pPhone.ok, true);
  assert.deepStrictEqual(pPhone.value.target, { type: "person", key: "tel:01011112222" }, "01011112222 번호가 tel 키와 정확히 매칭되어야 함");

  // 3) 직접 키 입력 지원 검증
  const pDirectKey = parseQueryCommand(tokenizeCommandLine("git log --type=call --author=tel:01055556666 --count"), testCandidatesWithNumberName, now);
  assert.strictEqual(pDirectKey.ok, true);
  assert.deepStrictEqual(pDirectKey.value.target, { type: "person", key: "tel:01055556666" });

  console.log("  ✓ 숫자 섞인 이름 vs 전화번호 판별 검증 완료");

  console.log("=== 5. P2-2: 포맷터 왕복 검증 (동명 전화 2명, 동명 앱 라벨 2개, 동명 geofence/dong, 특수문자) ===");
  const testRoundTripCandidates = {
    ...qctx.candidates,
    call: [
      { key: "tel:01012345678", name: "동명이인", label: "동명이인 (5678)", saved: true, tag: null, tags: [], lastAt: 100 },
      { key: "tel:01087654321", name: "동명이인", label: "동명이인 (4321)", saved: true, tag: null, tags: [], lastAt: 200 },
    ],
    apps: [
      { pkg: "com.test.app1", label: "같은라벨", totalSec: 100 },
      { pkg: "com.test.app2", label: "같은라벨", totalSec: 200 },
      { pkg: "com.special.app", label: 'Special "App" \\ Name', totalSec: 300 },
    ],
    reply: [
      { key: 'msg:com.kakao.talk:Special "Sender" \\ Name', name: 'Special "Sender" \\ Name', label: 'Special "Sender" \\ Name', saved: true, tag: null, tags: [], lastAt: 100 },
      { key: "msg:com.kakao.talk:@AtFriend", name: "@AtFriend", label: "@AtFriend", saved: true, tag: null, tags: [], lastAt: 200 },
    ],
    places: [
      { source: "geofence" as const, name: "역삼1동", visited: true },
      { source: "dong" as const, name: "역삼1동", visited: true },
      { source: "geofence" as const, name: 'Special "Place" \\ Name', visited: true },
      { source: "geofence" as const, name: "@AtPlace", visited: true },
      { source: "geofence" as const, name: "McDonald's", visited: true },
    ],
  };

  const precisionRoundTripReqs: QueryRequest[] = [
    // 1) 동명 전화인 A
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "call", target: { type: "person", key: "tel:01012345678" }, metric: "count" },
    // 2) 동명 전화인 B
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "call", target: { type: "person", key: "tel:01087654321" }, metric: "count" },
    // 3) 같은 라벨 앱 A
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "app", target: { type: "app", pkg: "com.test.app1" }, metric: "duration" },
    // 4) 같은 라벨 앱 B
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "app", target: { type: "app", pkg: "com.test.app2" }, metric: "duration" },
    // 5) 동명 장소 (geofence)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: { type: "place", source: "geofence", name: "역삼1동" }, metric: "count" },
    // 6) 동명 장소 (dong)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: { type: "place", source: "dong", name: "역삼1동" }, metric: "count" },
    // 7) 메신저 사람 (특수문자 따옴표, 역슬래시, 공백)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "reply", target: { type: "person", key: 'msg:com.kakao.talk:Special "Sender" \\ Name' }, metric: "count" },
    // 8) 메신저 사람 (@ 시작 이름)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "reply", target: { type: "person", key: "msg:com.kakao.talk:@AtFriend" }, metric: "count" },
    // 9) 장소 (특수문자 따옴표, 역슬래시, 공백)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: { type: "place", source: "geofence", name: 'Special "Place" \\ Name' }, metric: "duration" },
    // 10) 장소 (@ 시작 이름)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: { type: "place", source: "geofence", name: "@AtPlace" }, metric: "duration" },
    // 11) 앱 (특수문자)
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "app", target: { type: "app", pkg: "com.special.app" }, metric: "duration" },
    // 12) 태그
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "call", target: { type: "tag", tag: "friends" }, metric: "count" },
    // 13) 작은따옴표가 들어간 이름
    { from: "2026-10-18", to: "2026-10-18", timeOfDay: "any", kind: "location", target: { type: "place", source: "geofence", name: "McDonald's" }, metric: "duration" },
  ];

  for (const origReq of precisionRoundTripReqs) {
    const formatted = formatQueryCommand(origReq, testRoundTripCandidates, now);
    const roundTokens = tokenizeCommandLine(formatted);
    const roundParsed = parseQueryCommand(roundTokens, testRoundTripCandidates, now);
    assert.strictEqual(roundParsed.ok, true, `왕복 파싱 실패: ${formatted} -> ${(roundParsed as any).reason}`);
    assert.strictEqual(roundParsed.value.from, origReq.from);
    assert.strictEqual(roundParsed.value.to, origReq.to);
    assert.strictEqual(roundParsed.value.timeOfDay, origReq.timeOfDay);
    assert.strictEqual(roundParsed.value.kind, origReq.kind);
    assert.deepStrictEqual(roundParsed.value.target, origReq.target, `target 불일치: ${formatted}`);
    assert.strictEqual(roundParsed.value.metric, origReq.metric);
    console.log(`  ✓ 정밀 왕복 검증 성공: ${formatted}`);
  }

  console.log("=== 6. P2-3: 대상 옵션 상호 배타성 및 값 없는 플래그 검증 ===");
  // 1) 대상 옵션 둘 이상
  const errMultiTarget1 = parseQueryCommand(tokenizeCommandLine("git log --type=location --author=@friends --place=geofence:회사"), qctx.candidates, now);
  assert.strictEqual(errMultiTarget1.ok, false);
  assert.match(errMultiTarget1.reason, /대상 옵션.*둘 이상 지정할 수 없습니다/);

  const errMultiTarget2 = parseQueryCommand(tokenizeCommandLine("git log --type=app --app=com.test --author=이친구"), qctx.candidates, now);
  assert.strictEqual(errMultiTarget2.ok, false);
  assert.match(errMultiTarget2.reason, /대상 옵션.*둘 이상 지정할 수 없습니다/);

  // 2) 값 없는 플래그에 =... 부착
  const errCountVal = parseQueryCommand(tokenizeCommandLine("git log --type=app --count=false"), qctx.candidates, now);
  assert.strictEqual(errCountVal.ok, false);
  assert.match(errCountVal.reason, /--count 옵션에는 값을 지정할 수 없습니다/);

  const errDurVal = parseQueryCommand(tokenizeCommandLine("git log --type=app --duration=10"), qctx.candidates, now);
  assert.strictEqual(errDurVal.ok, false);
  assert.match(errDurVal.reason, /--duration 옵션에는 값을 지정할 수 없습니다/);

  // 3) 기존 오류 케이스들
  const errUnknown = parseQueryCommand(tokenizeCommandLine("git log --unknownOption"), qctx.candidates, now);
  assert.strictEqual(errUnknown.ok, false);
  assert.match(errUnknown.reason, /알 수 없는 옵션/);

  const errDup = parseQueryCommand(tokenizeCommandLine("git log --type=app --type=call"), qctx.candidates, now);
  assert.strictEqual(errDup.ok, false);
  assert.match(errDup.reason, /중복된 옵션/);

  const errBothMetric = parseQueryCommand(tokenizeCommandLine("git log --type=app --count --duration"), qctx.candidates, now);
  assert.strictEqual(errBothMetric.ok, false);
  assert.match(errBothMetric.reason, /동시에 지정할 수 없습니다/);

  const errGrepStruct = parseQueryCommand(tokenizeCommandLine("git log --grep=test --type=app"), qctx.candidates, now);
  assert.strictEqual(errGrepStruct.ok, false);
  assert.match(errGrepStruct.reason, /다른 구조 옵션과 함께 쓸 수 없습니다/);

  const err93Days = parseQueryCommand(tokenizeCommandLine("git log --type=app --since=2026-06-01 --until=2026-10-18"), qctx.candidates, now);
  assert.strictEqual(err93Days.ok, false);
  assert.match(err93Days.reason, /최대 92일/);

  const errReplyTag = parseQueryCommand(tokenizeCommandLine("git log --type=reply --author=@friends"), qctx.candidates, now);
  assert.strictEqual(errReplyTag.ok, false);
  assert.match(errReplyTag.reason, /태그 묶음은 통화·문자 조회에만/);

  // 복구: 1) 모호한 앱 라벨 (후보 나열)
  const candidatesWithAmbiguousApp = {
    ...qctx.candidates,
    apps: [
      { pkg: "com.test.app1", label: "테스트앱", totalSec: 100 },
      { pkg: "com.test.app2", label: "테스트앱", totalSec: 50 },
    ],
  };
  const errAmbigApp = parseQueryCommand(tokenizeCommandLine("git log --type=app --app=테스트앱"), candidatesWithAmbiguousApp, now);
  assert.strictEqual(errAmbigApp.ok, false);
  assert.match(errAmbigApp.reason, /모호한 앱 이름/);
  assert.match(errAmbigApp.reason, /com\.test\.app1/);

  // 복구: 2) 동명이인 이름 (후보 나열)
  const candidatesWithDupPerson = {
    ...qctx.candidates,
    call: [
      { key: "tel:010-1111-1111", name: "김동명", label: "김동명 (1111)", saved: true, tag: null, tags: [], lastAt: 0 },
      { key: "tel:010-2222-2222", name: "김동명", label: "김동명 (2222)", saved: true, tag: null, tags: [], lastAt: 0 },
    ],
  };
  const errDupPerson = parseQueryCommand(tokenizeCommandLine("git log --type=call --author=김동명"), candidatesWithDupPerson, now);
  assert.strictEqual(errDupPerson.ok, false);
  assert.match(errDupPerson.reason, /동명이인/);
  assert.match(errDupPerson.reason, /1111/);

  // 복구: 3) 접두사 없는 동명 장소 (접두사 안내)
  const errDupPlace = parseQueryCommand(tokenizeCommandLine("git log --place=역삼1동"), qctx.candidates, now);
  assert.strictEqual(errDupPlace.ok, false);
  assert.match(errDupPlace.reason, /등록 장소와 행정동에 모두 존재합니다/);
  assert.match(errDupPlace.reason, /geofence:역삼1동/);

  const okGeoPrefix = parseQueryCommand(tokenizeCommandLine("git log --place=geofence:역삼1동"), qctx.candidates, now);
  assert.strictEqual(okGeoPrefix.ok, true);
  assert.strictEqual(okGeoPrefix.value.target?.type, "place");

  // 복구: 4) help 예시가 실제로 파싱됨
  const ex1 = parseQueryCommand(tokenizeCommandLine("git log --type=app --since=7.days.ago --duration"), qctx.candidates, now);
  assert.strictEqual(ex1.ok, true);
  assert.strictEqual(ex1.value.kind, "app");
  assert.strictEqual(ex1.value.metric, "duration");

  const ex2 = parseQueryCommand(tokenizeCommandLine("git log --type=call --author=@friends --count"), qctx.candidates, now);
  assert.strictEqual(ex2.ok, true);
  assert.strictEqual(ex2.value.kind, "call");
  assert.strictEqual(ex2.value.metric, "count");

  const ex3 = parseQueryCommand(tokenizeCommandLine('git log --place="회사"'), qctx.candidates, now);
  assert.strictEqual(ex3.ok, true);
  assert.strictEqual(ex3.value.kind, "location");

  console.log("  ✓ 모든 옵션 충돌 및 오류 검증 완료 (모호성·동명이인·동명장소·help 예시 복구)");

  console.log("=== 7. P2-4: 장소 반경·좌표 유효성 검증 (add/update) ===");
  // mock DB 주입
  const mockDb = {
    query: adapter.query,
    run: adapter.run,
    execute: adapter.execute,
    isTransactionActive: async () => ({ result: false }),
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
  };
  __setDBForTest(mockDb as any);

  // 1) 반경 검증 (음수, 0, NaN, 범위 밖)
  assert.throws(() => validateGeofenceParams("테스트", 37.5, 127.0, -1), /반경은 10m에서 5000m 사이의 정수/);
  assert.throws(() => validateGeofenceParams("테스트", 37.5, 127.0, 0), /반경은 10m에서 5000m 사이의 정수/);
  assert.throws(() => validateGeofenceParams("테스트", 37.5, 127.0, NaN), /반경은 10m에서 5000m 사이의 정수/);
  assert.throws(() => validateGeofenceParams("테스트", 37.5, 127.0, 10000), /반경은 10m에서 5000m 사이의 정수/);

  // 2) 좌표 검증 (위도/경도 범위 초과 및 NaN)
  assert.throws(() => validateGeofenceParams("테스트", 95, 127.0, 150), /위도는 -90도에서 90도 사이/);
  assert.throws(() => validateGeofenceParams("테스트", 37.5, 200, 150), /경도는 -180도에서 180도 사이/);
  assert.throws(() => validateGeofenceParams("테스트", NaN, 127.0, 150), /위도는 -90도에서 90도 사이/);

  // 3) addGeofence / updateGeofence 호출 시 검증 및 과거 geofence_name 불변 확인
  await assert.rejects(async () => {
    await updateGeofence(1, "회사", 37.5000, 127.0300, -1, "work");
  }, /반경은 10m에서 5000m 사이의 정수/);

  await assert.rejects(async () => {
    await addGeofence("새장소", 37.5, 127.0, 0, "main");
  }, /반경은 10m에서 5000m 사이의 정수/);

  // 과거 loc-1의 geofence_name이 여전히 '회사'로 안전하게 보존되어 있는지 확인
  const checkLoc = await adapter.query("SELECT geofence_name FROM commits WHERE id = 'loc-1'");
  assert.strictEqual(checkLoc.values?.[0]?.geofence_name, "회사", "잘못된 반경 수정 시 과거 기록의 geofence_name이 삭제되지 않고 보존되어야 함");

  // 정상 updateGeofence 실행
  await updateGeofence(1, "회사본사", 37.5000, 127.0300, 200, "work");
  const updatedGfs = await fetchGeofences();
  const ug = updatedGfs.find((g) => g.id === 1)!;
  assert.strictEqual(ug.name, "회사본사");
  assert.strictEqual(ug.radius_m, 200);
  assert.strictEqual(ug.branch_trigger, "work", "branch_trigger 보존");

  // 태그 수정 및 phone_number 보존
  await updateContactTag(1, "김동료", "#coworker", "010-1111-2222");
  const tagsAfter = await fetchContactTags();
  const ut = tagsAfter.find((t) => t.id === 1)!;
  assert.strictEqual(ut.tag, "#coworker");
  assert.strictEqual(ut.phone_number, "010-1111-2222", "phone_number 보존");

  console.log("  ✓ 장소 반경·좌표 유효성 및 설정 수정 검증 완료");

  console.log("=== 8. 터미널 명령 제약 및 git commit -m 메시지 저장 검증 ===");
  // geofence foo -> 오류
  const geoLines = await executeTerminalCommand("geofence foo", true);
  assert.ok(geoLines.some((l) => l.type === "error" && l.text.includes("geofence list")));

  // tag foo -> 오류
  const tagLines = await executeTerminalCommand("tag foo", true);
  assert.ok(tagLines.some((l) => l.type === "error" && l.text.includes("tag list")));

  // git commit -m "수동 커밋 \"인용\" 완료" 저장 검증
  const commitLines = await executeTerminalCommand('git commit -m "수동 커밋 \\"인용\\" 완료"', true);
  assert.ok(commitLines.some((l) => l.type === "success"));

  const recentCommit = await adapter.query("SELECT subject FROM commits WHERE event_type = 'manual' ORDER BY created_at DESC LIMIT 1");
  assert.strictEqual(recentCommit.values?.[0]?.subject, '수동 커밋 "인용" 완료', "토크나이저 통과 후 따옴표가 보존되어 저장되어야 함");

  console.log("  ✓ 터미널 명령어 제약 및 commit 따옴표 보존 저장 검증 완료");

  console.log("=== 9. QB-C-3: 실제 executeTerminalCommand 빠른 경로 및 공통 구문 오류 검증 ===");
  // 가짜 needle 커밋 60개 삽입
  for (let i = 1; i <= 60; i++) {
    const cid = `needle-${i}`;
    const cSub = `feat: needle 검색 대상 기록 ${i}`;
    const cTime = tsBase + i * 1000;
    await adapter.run(
      `INSERT INTO commits (id, branch_id, event_type, subject, started_at, ended_at, duration_sec, created_at)
       VALUES ('${cid}', 1, 'APP_USAGE', '${cSub}', ${cTime}, ${cTime + 100}, 100, ${cTime})`
    );
  }

  // 후보 조회 스파이 카운터 설정
  let candidateQueryCount = 0;
  const origQuery = adapter.query;
  const spyDb = {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("geofences") || sql.includes("contact_tags")) {
        candidateQueryCount++;
      }
      return origQuery.call(adapter, sql, params);
    },
    run: adapter.run,
    execute: adapter.execute,
    isTransactionActive: async () => ({ result: false }),
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
  };
  __setDBForTest(spyDb as any);

  // 1) 6개 무효 입력 검증 (모두 error이고 output 없음)
  const invalidTerminalInputs = [
    "git log --grep=needle --unknown=1",
    "git log --grep=wrong --grep=needle",
    "git log --grep=needle --count=false",
    "git log --grep=needle -n -1",
    "git log --grep=needle -n 51",
    "git log -n=5=garbage",
  ];

  for (const cmd of invalidTerminalInputs) {
    const res = await executeTerminalCommand(cmd, true);
    assert.strictEqual(
      res.some((l) => l.type === "error"),
      true,
      `오류여야 함: ${cmd}`
    );
    assert.strictEqual(
      res.some((l) => l.type === "output"),
      false,
      `결과 행이 출력되지 않아야 함: ${cmd}`
    );
  }
  console.log("  ✓ 실제 executeTerminalCommand 6개 무효 입력 모두 오류 및 결과 행 없음 확인");

  // 2) 정상 3개 검증 및 후보 조회 0회 유지
  candidateQueryCount = 0;

  // ① git log (기본 최근 5개)
  const resRawDefault = await executeTerminalCommand("git log", true);
  const outRawDefault = resRawDefault.filter((l) => l.type === "output");
  assert.strictEqual(outRawDefault.length, 5, "기본 git log는 최근 5개 커밋 출력");

  // ② git log -n 3 (최근 3개)
  const resRawN = await executeTerminalCommand("git log -n 3", true);
  const outRawN = resRawN.filter((l) => l.type === "output");
  assert.strictEqual(outRawN.length, 3, "git log -n 3은 최근 3개 커밋 출력");

  // ③ git log --grep=needle -n 5 (FTS 검색 결과 5개)
  const resGrepN = await executeTerminalCommand("git log --grep=needle -n 5", true);
  const outGrepN = resGrepN.filter((l) => l.type === "output");
  assert.strictEqual(outGrepN.length, 5, "git log --grep=needle -n 5는 5개 검색 결과 출력");

  // ④ 후보 조회 0회 확인
  assert.strictEqual(
    candidateQueryCount,
    0,
    "정상 raw log 및 grep 실행 중 geofences/contact_tags 후보 조회가 0회여야 함"
  );
  console.log("  ✓ 정상 raw log 및 grep 검색 결과 정확성 및 후보 조회 0회 확인");

  console.log("모든 QB-C-3 검증이 완벽하게 통과했습니다!");
}

runQueryCommandChecks().catch((e) => {
  console.error("QB-C-2 check failed:", e);
  process.exit(1);
});
