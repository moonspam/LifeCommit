/**
 * askUi.check.ts
 * LifeCommit 기록 조회 UI 로직 및 데이터 파이프라인 검증
 */

import assert from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { executeNlQuery, getPeopleDisplayLabelMap } from "./nlsearch";
import { normalizePhone } from "./people";
import { openInitialised } from "./sqliteTestDb";
import { datePreset, validateRequest, toFilter, type QueryRequest, normalizeTag, summarizeRequest } from "./query";
import { loadQueryCandidates, formatPhoneNumber } from "./queryCandidates";
import {
  computeTargetSearchKeyAction,
  getTargetActiveOptionId,
  getActiveOptionId,
  dismissAutocompleteNav,
  isOptionHighlighted,
  clampHighlightIdx,
} from "./autocomplete";
import StatusBar from "../components/Terminal/StatusBar";
import { resolveQueryArgs } from "./queryCommand";
import {
  buildContactTagCandidates,
  addContactTag,
  updateContactTag,
  deleteContactTag,
  fetchContactTags,
  resolvePhoneNumberForName,
  resolveEditPhone,
  formatContactTagDisplayName,
  filterContactCandidates,
  createPhoneContactsLoader,
  createCandidateSession,
  type CandidateSession,
} from "./tagManager";
import { __setDBForTest } from "./db";

async function runAskUiChecks() {
  console.log("=== 기록 조회 UI 로직 및 데이터 검증 ===");

  // 1. 날짜 프리셋 및 요청 모델 유효성 검증
  const baseDate = new Date("2026-10-14T12:00:00+09:00");
  const todayRange = datePreset("today", baseDate);
  assert.strictEqual(todayRange.from, "2026-10-14");
  assert.strictEqual(todayRange.to, "2026-10-14");

  const validReq: QueryRequest = {
    from: todayRange.from,
    to: todayRange.to,
    timeOfDay: "evening",
    kind: "app",
    target: { type: "app", pkg: "com.google.android.youtube" },
    metric: "duration",
  };
  const valRes = validateRequest(validReq);
  assert.strictEqual(valRes.ok, true, "정상적인 요청은 검증을 통과해야 함");

  // 2. 상호 배타적 토글 상태 로직 검증
  let terminalVisible = false;
  let askVisible = false;

  const toggleTerminal = () => {
    terminalVisible = !terminalVisible;
    if (terminalVisible) askVisible = false;
  };

  const toggleAsk = () => {
    askVisible = !askVisible;
    if (askVisible) terminalVisible = false;
  };

  toggleAsk();
  assert.strictEqual(askVisible, true);
  assert.strictEqual(terminalVisible, false);

  toggleTerminal();
  assert.strictEqual(askVisible, false);
  assert.strictEqual(terminalVisible, true);

  toggleAsk();
  assert.strictEqual(askVisible, true);
  assert.strictEqual(terminalVisible, false);

  toggleAsk();
  assert.strictEqual(askVisible, false);
  assert.strictEqual(terminalVisible, false);

  // 3. UI 질의 실행 파이프라인 검증 (실제 SQLite 메모리 DB)
  const { adapter } = await openInitialised();
  // 2026-10-13 저녁 (19:00~20:00 KST, UTC 10:00~11:00 = 1791885600000 ~ 1791889200000)
  const tStart = new Date("2026-10-13T19:00:00+09:00").getTime();
  const tEnd = new Date("2026-10-13T20:00:00+09:00").getTime();
  await adapter.run(
    "INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, app_package, event_type, geofence_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["c1", 1, "유튜브", "{}", tStart, tEnd, 3600, "com.google.android.youtube", "APP_USAGE", null, tEnd]
  );

  const req1: QueryRequest = {
    from: "2026-10-13",
    to: "2026-10-13",
    timeOfDay: "evening",
    kind: "app",
    target: { type: "app", pkg: "com.google.android.youtube" },
    metric: "duration",
  };
  const filter1 = toFilter(req1, { people: [] });
  assert.strictEqual(filter1.ok, true);
  if (filter1.ok) {
    const exec1 = await executeNlQuery(filter1.value, adapter);
    assert.strictEqual(exec1.understood, true);
    assert.strictEqual(exec1.value, "1시간");
    assert.strictEqual(exec1.rows.length, 1);
  }

  // 4. 모르는 기간 표현 또는 역전된 날짜 거절 검증
  const invalidDateReq: QueryRequest = {
    from: "2026-10-20",
    to: "2026-10-10",
    timeOfDay: "any",
    kind: "app",
    target: null,
    metric: "duration",
  };
  assert.strictEqual(validateRequest(invalidDateReq).ok, false, "from > to는 거절되어야 함");

  // 5. 다일 기간 근거 목록 행 날짜 표기 검증 (3일간의 LOCATION 커밋)
  const locStart1 = new Date("2026-10-11T14:00:00+09:00").getTime();
  const locEnd1 = new Date("2026-10-11T16:00:00+09:00").getTime();
  const locStart2 = new Date("2026-10-12T14:00:00+09:00").getTime();
  const locEnd2 = new Date("2026-10-12T16:00:00+09:00").getTime();
  await adapter.run(
    "INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, app_package, event_type, geofence_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["c2", 1, "연구소 체류", "{}", locStart1, locEnd1, 7200, null, "LOCATION", "연구소", locEnd1]
  );
  await adapter.run(
    "INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, app_package, event_type, geofence_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["c3", 1, "연구소 체류", "{}", locStart2, locEnd2, 7200, null, "LOCATION", "연구소", locEnd2]
  );

  const reqMulti: QueryRequest = {
    from: "2026-10-11",
    to: "2026-10-13",
    timeOfDay: "any",
    kind: "location",
    target: { type: "place", source: "geofence", name: "연구소" },
    metric: "duration",
  };
  const filterMulti = toFilter(reqMulti, { people: [] });
  assert.strictEqual(filterMulti.ok, true);
  if (filterMulti.ok) {
    const execMulti = await executeNlQuery(filterMulti.value, adapter);
    assert.strictEqual(execMulti.understood, true);
    assert.ok(execMulti.rows.length >= 2);
    assert.match(String(execMulti.rows[0].time), /\d{1,2}\/\d{1,2}/, "다일 기간 근거 행의 time에는 날짜가 표기되어야 함");
  }

  // 6. 후보 로딩 파이프라인 검증 (loadQueryCandidates)
  const candidates = await loadQueryCandidates(adapter, {
    geofences: [{ name: "연구소" }],
    tags: [{ contact_name: "김서연", tag: "#동료", phone_number: "010-1111-2222" }],
  });
  assert.strictEqual(candidates.counts.app, 1, "앱 커밋 카운트가 1이어야 함");
  assert.strictEqual(candidates.counts.location, 2, "장소 커밋 카운트가 2여야 함");
  assert.strictEqual(candidates.apps.length, 1);
  assert.strictEqual(candidates.apps[0].pkg, "com.google.android.youtube");
  assert.strictEqual(candidates.places.find((p) => p.name === "연구소")?.visited, true);

  // 7. 연락처 tel: 키 정규화 검증 (중립 이름 사용)
  const rawContacts = [
    { name: "박준호", phone: "+82 10-2222-3333" },
    { name: "김서연", phone: "010-1111-2222" },
  ];
  const normalizedPeople = rawContacts.map((c) => {
    const phone = normalizePhone(c.phone);
    return {
      key: `tel:${phone}`,
      name: c.name || `…${phone.slice(-4)}`,
      saved: !!c.name && c.name !== c.phone && c.name !== phone,
    };
  });
  assert.strictEqual(normalizedPeople[0].key, "tel:01022223333", "국제표기 번호는 정규화되어 tel:01022223333으로 저장되어야 함");
  assert.strictEqual(normalizedPeople[1].key, "tel:01011112222", "하이픈 번호는 정규화되어 tel:01011112222로 저장되어야 함");

  // 8. 검색창 접근성 및 키보드 탐색 로직 검증 (AskPanel 실함수 호출 검증)
  {
    // Esc 처리가 빈 목록 검사 전에 수행되는지 검증
    const escActionEmpty = computeTargetSearchKeyAction("Escape", 2, 0);
    assert.strictEqual(escActionEmpty.action, "reset", "결과가 0개여도 Esc 입력 시 action은 reset이어야 함");
    assert.strictEqual(escActionEmpty.nextIdx, 0, "결과가 0개여도 Esc 입력 시 nextIdx는 0이어야 함");

    const escActionNonEmpty = computeTargetSearchKeyAction("Escape", 3, 5);
    assert.strictEqual(escActionNonEmpty.action, "reset");
    assert.strictEqual(escActionNonEmpty.nextIdx, 0);

    // 화살표 탐색 순환 검증
    const downAction = computeTargetSearchKeyAction("ArrowDown", 1, 3);
    assert.strictEqual(downAction.action, "down");
    assert.strictEqual(downAction.nextIdx, 2);

    const upAction = computeTargetSearchKeyAction("ArrowUp", 0, 3);
    assert.strictEqual(upAction.action, "up");
    assert.strictEqual(upAction.nextIdx, 2);

    // Enter 선택
    const enterAction = computeTargetSearchKeyAction("Enter", 1, 3);
    assert.strictEqual(enterAction.action, "select");
    assert.strictEqual(enterAction.nextIdx, 1);

    // 활성 옵션 ID (aria-activedescendant) 순수 계산 함수 검증
    assert.strictEqual(getTargetActiveOptionId(1, 2), "target-opt-1", "aria-activedescendant는 target-opt-1과 일치해야 함");
    assert.strictEqual(getTargetActiveOptionId(0, 0), undefined, "목록이 비어 있으면 undefined여야 함");
    assert.strictEqual(getTargetActiveOptionId(5, 3), undefined, "인덱스가 범위를 벗어나면 undefined여야 함");

    // (A) 화면 실제 사용 함수 검증: 6개 탐색 -> idx 5 -> 검색어로 1개 축소 -> Enter가 그 1개 선택
    let navIdx = 0;
    for (let i = 0; i < 5; i++) {
      const act = computeTargetSearchKeyAction("ArrowDown", navIdx, 6);
      assert.strictEqual(act.action, "down");
      navIdx = act.nextIdx;
    }
    assert.strictEqual(navIdx, 5, "화살표 5회 탐색 후 인덱스 5");

    // 검색어로 1개 축소 시 화면 clamp 로직 동작
    const clampedIdx = clampHighlightIdx(navIdx, 1);
    assert.strictEqual(clampedIdx, 0, "후보 1개로 축소 시 clamp되어 인덱스 0");

    // Enter가 그 1개 선택
    const enterAct = computeTargetSearchKeyAction("Enter", clampedIdx, 1);
    assert.strictEqual(enterAct.action, "select");
    assert.strictEqual(enterAct.nextIdx, 0, "Enter 선택 시 0번째 항목 선택");

    // 축소 전 인덱스(5)가 직접 Enter로 전달되어도 유효 범위(0)로 clamp되어 선택
    const clampedEnter = computeTargetSearchKeyAction("Enter", 5, 1);
    assert.strictEqual(clampedEnter.action, "select");
    assert.strictEqual(clampedEnter.nextIdx, 0, "인덱스 5였어도 1개 축소 시 0번째 항목 clamp 선택");

    // (B) blur / 키보드 미탐색 -> activedescendant undefined
    let isNav = true;
    assert.strictEqual(getActiveOptionId(true, isNav, 2, 5, "target-opt"), "target-opt-2");
    // blur 시: 화면 onBlur에서 dismissAutocompleteNav 호출로 키보드 탐색 해제
    isNav = dismissAutocompleteNav(isNav);
    assert.strictEqual(isNav, false, "dismissAutocompleteNav 호출 후 isNavigating은 false여야 함");
    assert.strictEqual(getActiveOptionId(true, isNav, 2, 5, "target-opt"), undefined, "blur 후 activedescendant는 undefined여야 함");
    assert.strictEqual(getActiveOptionId(false, false, 2, 5, "target-opt"), undefined, "목록 닫힘 시 activedescendant는 undefined여야 함");

    // (C) 옵션 ID와 activedescendant 일치 검증 (new/edit/target 각각)
    const prefixes = ["new-contact-opt", "edit-contact-opt", "target-opt"] as const;
    for (const prefix of prefixes) {
      const activeDescendant = getActiveOptionId(true, true, 1, 3, prefix);
      const optionId = getTargetActiveOptionId(1, 3, prefix);
      assert.strictEqual(activeDescendant, `${prefix}-1`, `${prefix}의 activeDescendant`);
      assert.strictEqual(optionId, `${prefix}-1`, `${prefix}의 optionId`);
      assert.strictEqual(activeDescendant, optionId, `옵션 ID와 activedescendant가 완벽히 일치해야 함 (${prefix})`);
    }

    // 태그 중복 '#' 방지 검증: DB 저장값 '#NewTag' -> UI 표기 '#NewTag' (##NewTag 방지)
    const rawTag = "#NewTag";
    const displayTag = `#${normalizeTag(rawTag)}`;
    assert.strictEqual(displayTag, "#NewTag", "태그 표기는 단 하나의 '#'만 포함해야 함");
  }

  // 9. UX4 항목 1: 연락처 태그 자동완성 후보 생성 및 DB 저장 검증
  {
    // (a) 후보 생성: 저장된 이름만, tel: 키 중복 제거, 번호 끝 4자리, (#태그) 표시
    const mockPeople = {
      call: [
        { key: "tel:01011112222", name: "김서연", label: "김서연", saved: true, tag: "#동료", tags: ["#동료"], lastAt: 100 },
        { key: "tel:01099998888", name: "010-9999-8888", label: "010-9999-8888", saved: false, tag: null, tags: [], lastAt: 200 },
      ],
      sms: [
        { key: "tel:01011112222", name: "김서연", label: "김서연", saved: true, tag: "#동료", tags: ["#동료"], lastAt: 300 }, // call과 동일 번호 -> 중복 제거 대상
        { key: "tel:01033334444", name: "박준호", label: "박준호", saved: true, tag: null, tags: [], lastAt: 400 },
      ],
    };

    const tagCands = buildContactTagCandidates(mockPeople as any);
    assert.strictEqual(tagCands.length, 2, "저장된 연락처만 포함되고 중복 번호는 하나로 합쳐져야 함");

    const candKim = tagCands.find((c) => c.name === "김서연")!;
    assert.ok(candKim, "김서연 후보가 존재해야 함");
    assert.strictEqual(candKim.phoneEnding, "2222", "끝 4자리 확인");
    assert.strictEqual(candKim.label, "김서연 (…2222) (#동료)", "태그가 있는 연락처는 (#태그)가 표시되어야 함");

    const candPark = tagCands.find((c) => c.name === "박준호")!;
    assert.ok(candPark, "박준호 후보가 존재해야 함");
    assert.strictEqual(candPark.phoneEnding, "4444");
    assert.strictEqual(candPark.label, "박준호 (…4444)", "태그가 없는 연락처는 번호 끝자리만 표시");

    // (b) 선택 시 저장되는 이름/번호 (실제 SQLite DB)
    __setDBForTest(adapter);
    await addContactTag("박준호", "#친구", "010-3333-4444");
    let allTags = await fetchContactTags();
    const insertedTag = allTags.find((t) => t.contact_name === "박준호");
    assert.ok(insertedTag, "태그가 성공적으로 등록되어야 함");
    assert.strictEqual(insertedTag.phone_number, "010-3333-4444", "선택된 후보의 phone_number가 함께 저장되어야 함");
    assert.strictEqual(insertedTag.tag, "#친구");

    // 수정 시에도 phone_number 보존/수정
    await updateContactTag(insertedTag.id, "박준호", "#절친", "010-3333-4444");
    allTags = await fetchContactTags();
    const updatedTag = allTags.find((t) => t.id === insertedTag.id);
    assert.strictEqual(updatedTag?.tag, "#절친");
    assert.strictEqual(updatedTag?.phone_number, "010-3333-4444", "수정 시에도 phone_number가 올바르게 저장되어야 함");
    assert.strictEqual(updatedTag?.contact_key, "tel:01033334444");

    // 중복 키 등록 시 사람이 읽을 수 있는 오류 ("이미 태그가 있는 연락처") 발생 검증
    await assert.rejects(
      () => addContactTag("다른이름", "#중복", "010-3333-4444"),
      /이미 태그가 있는 연락처/,
      "동일한 전화번호(중복 키) 등록 시 사람이 읽을 오류 발생"
    );

    // 수정 시 번호 변경 -> 키 갱신 검증
    await updateContactTag(insertedTag.id, "박준호", "#절친", "010-7777-8888");
    allTags = await fetchContactTags();
    const phoneUpdated = allTags.find((t) => t.id === insertedTag.id);
    assert.strictEqual(phoneUpdated?.contact_key, "tel:01077778888", "전화번호 변경 시 contact_key 갱신");
    assert.strictEqual(phoneUpdated?.phone_number, "010-7777-8888");

    // phoneNumber 인자를 undefined로 넘겼을 때 기존 번호 보존
    await updateContactTag(insertedTag.id, "박준호", "#최고절친", undefined);
    allTags = await fetchContactTags();
    const preservedPhoneTag = allTags.find((t) => t.id === insertedTag.id);
    assert.strictEqual(preservedPhoneTag?.phone_number, "010-7777-8888", "undefined 전달 시 기존 phone_number 보존");
    assert.strictEqual(preservedPhoneTag?.contact_key, "tel:01077778888", "기존 번호 보존 시 contact_key도 유지");
    assert.strictEqual(preservedPhoneTag?.tag, "#최고절친");

    // (b') 과거 커밋 author_tag 동기화 및 FTS 검색 검증 (Section 5)
    // 1) 자동 CALL 커밋 2개 (동명이인 홍길동: 번호 A, 번호 B) 및 수동 커밋 1개 삽입
    const nowTs = Date.now();
    await adapter.run(
      `INSERT INTO commits (id, branch_id, subject, body, author_tag, started_at, ended_at, duration_sec, app_package, event_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rematch-call-hong-1", 4, "call: 홍길동 수신 통화", JSON.stringify({ phoneNumber: "010-1234-5678", contactName: "홍길동" }), null, nowTs - 10000, nowTs - 9000, 1000, "com.android.dialer", "CALL", nowTs]
    );
    await adapter.run(
      `INSERT INTO commits (id, branch_id, subject, body, author_tag, started_at, ended_at, duration_sec, app_package, event_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rematch-call-hong-2", 4, "call: 홍길동 발신 통화", JSON.stringify({ phoneNumber: "010-9876-5432", contactName: "홍길동" }), null, nowTs - 5000, nowTs - 4000, 1000, "com.android.dialer", "CALL", nowTs]
    );
    await adapter.run(
      `INSERT INTO commits (id, branch_id, subject, body, author_tag, started_at, ended_at, duration_sec, app_package, event_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["rematch-manual-1", 1, "memo: 중요한 메모", null, "#manual", nowTs - 2000, nowTs - 2000, 0, null, "manual", nowTs]
    );

    // 2) 홍길동 번호 A(010-1234-5678)에 대해 태그 등록 -> 같은 트랜잭션에서 과거 커밋 author_tag 동기화
    await addContactTag("홍길동", "#vip", "010-1234-5678");

    // 검증: 번호 A의 커밋만 #vip로 갱신되고, 동명이인 번호 B 및 수동 커밋은 변경 없음
    const c1 = (await adapter.query("SELECT author_tag FROM commits WHERE id = 'rematch-call-hong-1'")).values?.[0];
    const c2 = (await adapter.query("SELECT author_tag FROM commits WHERE id = 'rematch-call-hong-2'")).values?.[0];
    const cManual = (await adapter.query("SELECT author_tag FROM commits WHERE id = 'rematch-manual-1'")).values?.[0];
    assert.strictEqual(c1?.author_tag, "#vip", "해당 번호 커밋의 author_tag가 #vip로 갱신됨");
    assert.strictEqual(c2?.author_tag, null, "동명이인 다른 번호 커밋은 건드리지 않음");
    assert.strictEqual(cManual?.author_tag, "#manual", "수동 커밋의 author_tag는 불변");

    // FTS5 인덱스 검증: 트리거로 동기화되어 commits_fts에서 '#vip' 검색 가능
    const ftsRes = await adapter.query("SELECT id FROM commits_fts WHERE commits_fts MATCH 'vip'");
    assert.ok((ftsRes.values || []).some((r: any) => r.id === "rematch-call-hong-1"), "FTS 인덱스에서 #vip 커밋 검색 가능");

    // 3) 태그 삭제 시 -> author_tag 해제 검증
    allTags = await fetchContactTags();
    const hongTag = allTags.find((t) => t.contact_key === "tel:01012345678");
    assert.ok(hongTag);
    await deleteContactTag(hongTag.id);

    const c1AfterDelete = (await adapter.query("SELECT author_tag FROM commits WHERE id = 'rematch-call-hong-1'")).values?.[0];
    assert.strictEqual(c1AfterDelete?.author_tag, null, "태그 삭제 시 author_tag 해제(null)");

    const ftsAfterDelete = await adapter.query("SELECT id FROM commits_fts WHERE commits_fts MATCH 'vip'");
    assert.strictEqual((ftsAfterDelete.values || []).filter((r: any) => r.id === "rematch-call-hong-1").length, 0, "FTS 인덱스에서도 삭제 반영");

    // 격리를 위해 테스트 커밋 정리
    await adapter.run("DELETE FROM commits WHERE id IN ('rematch-call-hong-1', 'rematch-call-hong-2', 'rematch-manual-1')");

    // (c) 직접 입력 시 번호 자동 연결 순수 함수 검증 (동명이인 2명 -> null, 1명 -> 그 번호, 0명 -> null)
    const testCandidatePool = [
      { key: "tel:01011112222", name: "김서연", phone: "01011112222", phoneEnding: "2222", tag: null, label: "김서연 (…2222)" },
      { key: "tel:01033334444", name: "홍길동", phone: "01033334444", phoneEnding: "4444", tag: null, label: "홍길동 (…4444)" },
      { key: "tel:01055556666", name: "홍길동", phone: "01055556666", phoneEnding: "6666", tag: null, label: "홍길동 (…6666)" },
    ];
    assert.strictEqual(resolvePhoneNumberForName(testCandidatePool, "홍길동"), null, "동명이인 2명인 경우 null이어야 함");
    assert.strictEqual(resolvePhoneNumberForName(testCandidatePool, "김서연"), "01011112222", "1명만 일치할 때 해당 전화번호 반환");
    assert.strictEqual(resolvePhoneNumberForName(testCandidatePool, "이순신"), null, "0명 일치 시 null 반환");
    assert.strictEqual(resolvePhoneNumberForName(testCandidatePool, "  김서연  "), "01011112222", "공백 트림 후 일치 처리");
    assert.strictEqual(resolvePhoneNumberForName(testCandidatePool, ""), null, "빈 문자열은 null 반환");

    // (d) 설정 연락처 태그 목록 줄: 동명이인 끝자리 표시 순수 함수 검증 (formatContactTagDisplayName)
    const mockTags = [
      { contact_name: "홍길동", tag: "#친구", phone_number: "010-1234-5678" },
      { contact_name: "홍길동", tag: "#동료", phone_number: "010-9876-5432" },
      { contact_name: "김서연", tag: "#가족", phone_number: "010-1111-2222" },
      { contact_name: "이순신", tag: "#기타", phone_number: null },
      { contact_name: "이순신", tag: "#모임", phone_number: "010-5555-6666" },
    ];
    assert.strictEqual(
      formatContactTagDisplayName(mockTags[0], mockTags),
      "홍길동 (…5678)",
      "동명이인인 경우 번호 끝 4자리 표시"
    );
    assert.strictEqual(
      formatContactTagDisplayName(mockTags[1], mockTags),
      "홍길동 (…5432)",
      "동명이인 다른 한 명의 번호 끝 4자리 표시"
    );
    assert.strictEqual(
      formatContactTagDisplayName(mockTags[2], mockTags),
      "김서연",
      "유일한 이름인 경우 끝자리 없이 이름만 표시"
    );
    assert.strictEqual(
      formatContactTagDisplayName(mockTags[3], mockTags),
      "이순신",
      "동명이인이지만 phone_number가 없으면 끝자리 생략"
    );
    assert.strictEqual(
      formatContactTagDisplayName(mockTags[4], mockTags),
      "이순신 (…6666)",
      "동명이인 중 phone_number가 있는 쪽은 끝자리 표시"
    );
  }

  // 10. UX4 항목 3: 기록 조회 패널 개선 검증
  {
    // 3-1: StatusBar 아이콘 검증 (✦ 대신 돋보기 SVG, title 및 aria-label '기록 조회')
    const barHtml = renderToStaticMarkup(createElement(StatusBar, {
      dbStatus: "ready",
      onToggleTerminal: () => {},
      isTerminalVisible: false,
      onToggleAsk: () => {},
      isAskVisible: false,
      filterType: "today",
      onFilterChange: () => {},
      onOpenFilterSettings: () => {},
    }));
    assert.ok(barHtml.includes('aria-label="기록 조회"'), "기록 조회 토글에 aria-label='기록 조회'가 있어야 함");
    assert.ok(barHtml.includes('title="기록 조회"'), "기록 조회 토글에 title='기록 조회'가 있어야 함");
    assert.ok(!barHtml.includes("✦"), "AI 느낌의 ✦ 아이콘 대신 검색 아이콘이어야 함");

    // 3-2: 강조 상태 순수 함수 검증 (키보드 탐색 중일 때만 true)
    assert.strictEqual(isOptionHighlighted(false, 0, 0), false, "키보드 탐색 중이 아니면 첫 항목이어도 강조되지 않아야 함");
    assert.strictEqual(isOptionHighlighted(true, 0, 0), true, "키보드 탐색 중일 때 일치 인덱스만 강조되어야 함");
    assert.strictEqual(isOptionHighlighted(true, 1, 0), false, "인덱스가 다르면 강조되지 않아야 함");

    // 3-2: 앱 후보 정렬 검증 (가나다/알파벳 순)
    const tApp = Date.now();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-naver", 1, "APP_USAGE", "com.nhn.android.search", tApp, tApp + 60, 60, "naver", "{}", tApp]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-chrome", 1, "APP_USAGE", "com.android.chrome", tApp, tApp + 60, 60, "chrome", "{}", tApp]
    );

    const appCandidates = await loadQueryCandidates(adapter, {
      geofences: [],
      tags: [],
      appLabel: (pkg) => (pkg === "com.nhn.android.search" ? "네이버" : pkg === "com.android.chrome" ? "크롬" : "유튜브"),
    });
    const appLabels = appCandidates.apps.map((a) => a.label);
    const sortedAppLabels = [...appLabels].sort((a, b) => a.localeCompare(b, "ko"));
    assert.deepStrictEqual(appLabels, sortedAppLabels, "앱 후보는 라벨 기준 가나다순으로 정렬되어야 함");

    // 3-3: 통화·문자 후보 정렬 및 전체 번호 라벨 검증
    assert.strictEqual(formatPhoneNumber("01012345678"), "010-1234-5678");
    assert.strictEqual(formatPhoneNumber("0212345678"), "02-1234-5678");

    const tCall = Date.now();
    // 저장된 사람 2명 (홍길동, 강감찬) + 이름 없는 사람 1명 (010-9999-8888)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-hong", 1, "CALL", tCall, tCall + 30, 30, "call", JSON.stringify({ phoneNumber: "01022223333", contactName: "홍길동" }), tCall]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-kang", 1, "CALL", tCall, tCall + 30, 30, "call", JSON.stringify({ phoneNumber: "01044445555", contactName: "강감찬" }), tCall]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-unsaved", 1, "CALL", tCall, tCall + 30, 30, "call", JSON.stringify({ phoneNumber: "01099998888" }), tCall]
    );

    const callCands = await loadQueryCandidates(adapter, { geofences: [], tags: [] });
    // 저장된 사람(강감찬, 홍길동) 먼저 가나다순, 그 다음 번호만 있는 사람
    assert.strictEqual(callCands.call[0].name, "강감찬", "저장된 연락처 중 가나다순 첫 번째");
    assert.strictEqual(callCands.call[1].name, "홍길동", "저장된 연락처 중 가나다순 두 번째");
    const unsavedPerson = callCands.call.find((p) => p.key === "tel:01099998888")!;
    assert.ok(unsavedPerson, "이름 없는 사람 후보 존재");
    assert.strictEqual(unsavedPerson.saved, false);
    assert.strictEqual(unsavedPerson.label, "010-9999-8888", "이름 없는 사람의 라벨은 '…1234' 대신 전체 하이픈 번호여야 함");

    // 3-3-b: 동명이인 끝자리 표시 검증 (순수 함수 getPeopleDisplayLabelMap, 기록 조회 대상 목록, 터미널 오류 후보 나열)
    const pureDisambig = getPeopleDisplayLabelMap([
      { key: "tel:01022223333", name: "홍길동", saved: true },
      { key: "tel:01077778888", name: "홍길동", saved: true },
      { key: "tel:01011112222", name: "김서연", saved: true },
    ]);
    assert.strictEqual(pureDisambig.get("tel:01022223333")?.full, "홍길동 (…3333)", "순수 함수: 동명이인 첫 번째 끝자리 표시");
    assert.strictEqual(pureDisambig.get("tel:01077778888")?.full, "홍길동 (…8888)", "순수 함수: 동명이인 두 번째 끝자리 표시");
    assert.strictEqual(pureDisambig.get("tel:01011112222")?.full, "김서연", "순수 함수: 유일한 이름은 끝자리 없음");

    // DB 파이프라인 검증: 동명이인 홍길동 1명 추가
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-hong-2", 1, "CALL", tCall, tCall + 30, 30, "call", JSON.stringify({ phoneNumber: "01077778888", contactName: "홍길동" }), tCall]
    );
    const callCandsWithDup = await loadQueryCandidates(adapter, { geofences: [], tags: [] });
    const hongList = callCandsWithDup.call.filter((p) => p.name === "홍길동");
    assert.strictEqual(hongList.length, 2, "홍길동 동명이인 후보 2명");
    assert.ok(hongList.some((p) => p.label === "홍길동 (…3333)"), "기록 조회 대상 목록 라벨에 (…3333) 포함");
    assert.ok(hongList.some((p) => p.label === "홍길동 (…8888)"), "기록 조회 대상 목록 라벨에 (…8888) 포함");

    // 터미널 오류 후보 나열 검증 (resolveQueryArgs)
    const disambigRes = resolveQueryArgs(
      {
        kind: "structural",
        kindType: "call",
        authorSpec: "홍길동",
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        metric: "count",
      },
      callCandsWithDup
    );
    assert.strictEqual(disambigRes.ok, false, "동명이인 지정 시 오류 반환");
    if (!disambigRes.ok) {
      assert.ok(disambigRes.reason.includes("동명이인이 있습니다: '홍길동'"), "동명이인 오류 메시지 확인");
      assert.ok(disambigRes.reason.includes("홍길동 (…3333)"), "터미널 오류 후보 나열에 (…3333) 포함");
      assert.ok(disambigRes.reason.includes("홍길동 (…8888)"), "터미널 오류 후보 나열에 (…8888) 포함");
    }

    // 3-4: 장소 후보 표시 검증 (행정동에 '동 ' 접두어 없음)
    const tLoc = Date.now();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, lat, lng, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["loc-dong-1", 1, "LOCATION", 37.35, 127.10, tLoc, tLoc + 60, 60, "dong-loc", "{}", tLoc]
    );

    const dongCandidates = await loadQueryCandidates(adapter, {
      geofences: [{ name: "연구소" }],
      tags: [],
      dongAt: () => "성남시 분당구 금곡동",
    });
    const dongPlace = dongCandidates.places.find((p) => p.source === "dong");
    assert.ok(dongPlace, "행정동 후보가 존재해야 함");
    assert.ok(!dongPlace.name.startsWith("동 "), "행정동 이름 자체에 '동 ' 접두어가 없어야 함");

    // summarizeRequest 검증: 장소 이름 '동탄역'(geofence)과 행정동 '경기도 가상시 동문동'의 요약에 이름이 그대로, 이모지·'동 ' 접두어 없음
    const geofenceReq: QueryRequest = {
      from: "2026-10-14",
      to: "2026-10-14",
      timeOfDay: "any",
      kind: "location",
      target: { type: "place", source: "geofence", name: "동탄역" },
      metric: "duration",
    };
    // AskPanel에서 targetLabel로 넘기는 순수 이름("동탄역")
    const summaryGeofence = summarizeRequest(geofenceReq, "동탄역");
    assert.ok(summaryGeofence.includes("동탄역"), "'동탄역' 장소 이름이 '탄역'으로 잘리지 않고 그대로 보존되어야 함");
    assert.ok(!summaryGeofence.includes("📍"), "요약 문장에 📍 이모지가 포함되지 않아야 함");

    const dongReq: QueryRequest = {
      from: "2026-10-14",
      to: "2026-10-14",
      timeOfDay: "any",
      kind: "location",
      target: { type: "place", source: "dong", name: "경기도 가상시 동문동" },
      metric: "duration",
    };
    // AskPanel에서 targetLabel로 넘기는 순수 이름("경기도 가상시 동문동")
    const summaryDong = summarizeRequest(dongReq, "경기도 가상시 동문동");
    assert.ok(summaryDong.includes("경기도 가상시 동문동"), "행정동 이름이 '동 ' 접두어 처리로 잘리지 않고 그대로 보존되어야 함");
    assert.ok(!summaryDong.includes("🗺"), "요약 문장에 🗺 이모지가 포함되지 않아야 함");
    assert.ok(!summaryDong.includes("동 경기도"), "요약 문장에 '동 ' 접두어가 포함되지 않아야 함");

    // targetLabel 인자가 생략되었을 때도 target.name 그대로 사용
    const summaryDefault = summarizeRequest(geofenceReq);
    assert.ok(summaryDefault.includes("동탄역"), "targetLabel 미전달 시에도 target.name이 그대로 사용되어야 함");
  }

  // 11. TAG-KEY-3 P2: 태그 수정 시 전화번호 결정(resolveEditPhone) 및 updateContactTag 명시적 null 검증
  {
    // (a) resolveEditPhone 순수 함수 검증
    // 이름 입력을 건드리지 않은 수정(!nameTouched): 시작 시 읽은 기존 번호(originalPhone) 유지
    assert.strictEqual(resolveEditPhone("01011110001", false, null), "01011110001", "이름 미수정 시 기존 번호 유지");
    assert.strictEqual(resolveEditPhone(null, false, null), null, "기존 번호가 없던 경우 미수정 시 null 유지");
    // 후보 미일치 직접 입력(nameTouched && matchedPhone === null): 번호 해제 -> name: 키
    assert.strictEqual(resolveEditPhone("01011110001", true, null), null, "후보 미일치 직접 입력 시 null로 번호 해제");
    // 후보 선택 또는 일치(nameTouched && matchedPhone 존재): 해당 번호 전달
    assert.strictEqual(resolveEditPhone("01011110001", true, "01022220002"), "01022220002", "후보 선택 시 해당 번호 반환");

    // (b) 실제 SQLite DB + updateContactTag 호출 동작 검증
    await addContactTag("홍길동P2", "#hongP2", "01011110001");
    const tagsInitial = await fetchContactTags();
    const targetTag = tagsInitial.find((t) => t.contact_name === "홍길동P2");
    assert.ok(targetTag, "홍길동P2 태그 존재");
    assert.strictEqual(targetTag.contact_key, "tel:01011110001");
    assert.strictEqual(targetTag.phone_number, "01011110001");

    // 번호 태그 -> 미일치 이름 입력 저장 (명시적 null 전달) -> name: 키 및 phone null
    await updateContactTag(targetTag.id, "TestNewName", "#hongP2", null);
    const tagsAfterName = await fetchContactTags();
    const updatedNameTag = tagsAfterName.find((t) => t.id === targetTag.id);
    assert.ok(updatedNameTag);
    assert.strictEqual(updatedNameTag.contact_name, "TestNewName");
    assert.strictEqual(updatedNameTag.contact_key, "name:TestNewName", "미일치 직접 입력 시 name: 키로 변경되어야 함");
    assert.strictEqual(updatedNameTag.phone_number, null, "전화번호가 null로 해제되어야 함");

    // 태그 값만 수정 (이름 미수정, undefined 전달) -> 번호 및 키 유지
    await updateContactTag(targetTag.id, "TestNewName", "#hongModified", undefined);
    const tagsAfterTagOnly = await fetchContactTags();
    const tagOnly = tagsAfterTagOnly.find((t) => t.id === targetTag.id);
    assert.ok(tagOnly);
    assert.strictEqual(tagOnly.tag, "#hongModified");
    assert.strictEqual(tagOnly.contact_key, "name:TestNewName", "태그만 수정 시 키 유지");
    assert.strictEqual(tagOnly.phone_number, null, "태그만 수정 시 전화번호 유지");

    // 후보 선택 -> 그 번호 키
    await updateContactTag(targetTag.id, "김후보", "#hongCandidate", "01099998888");
    const tagsAfterCandidate = await fetchContactTags();
    const candidateTag = tagsAfterCandidate.find((t) => t.id === targetTag.id);
    assert.ok(candidateTag);
    assert.strictEqual(candidateTag.contact_key, "tel:01099998888", "후보 선택 시 tel: 키로 변경되어야 함");
    assert.strictEqual(candidateTag.phone_number, "01099998888", "후보 선택 시 번호 갱신");
  }

  // 13. CONTACTS: 주소록 검색 및 자동완성 후보 병합 검증
  {
    // (1) 기록만 (history only)
    const mockHistoryOnly = {
      call: [
        { key: "tel:01011112222", name: "김철수", label: "김철수", saved: true, tag: "#동료", tags: ["#동료"], lastAt: 100 },
      ],
      sms: [
        { key: "tel:01033334444", name: "이영희", label: "이영희", saved: true, tag: null, tags: [], lastAt: 200 },
      ],
    };
    const candsHistoryOnly = buildContactTagCandidates(mockHistoryOnly as any);
    assert.strictEqual(candsHistoryOnly.length, 2, "기록 후보만 있을 때 정상 반환");
    assert.strictEqual(candsHistoryOnly[0].name, "김철수");
    assert.strictEqual(candsHistoryOnly[0].label, "김철수 (…2222) (#동료)");
    assert.strictEqual(candsHistoryOnly[1].name, "이영희");
    assert.strictEqual(candsHistoryOnly[1].label, "이영희 (…4444)");

    // (2) 주소록만 (address book only)
    const mockEmptyHistory = { call: [], sms: [] };
    const phoneContactsOnly = [
      { name: "박지성", phone: "010-5555-6666" },
    ];
    const candsAddressOnly = buildContactTagCandidates(mockEmptyHistory as any, phoneContactsOnly);
    assert.strictEqual(candsAddressOnly.length, 1, "주소록 후보만 있을 때 정상 반환");
    assert.strictEqual(candsAddressOnly[0].name, "박지성");
    assert.strictEqual(candsAddressOnly[0].phoneEnding, "6666");
    assert.strictEqual(candsAddressOnly[0].label, "박지성 (…6666)");

    // (3) 같은 번호 다른 표기 겹침 → 하나·주소록 이름 및 번호 검색 누락 방지 (P2)
    const mockHistoryOverlap = {
      call: [
        { key: "tel:01012345678", name: "홍대리", label: "홍대리", saved: true, tag: null, tags: [], lastAt: 100 },
      ],
      sms: [],
    };
    const phoneContactsOverlap1 = [
      { name: "홍길동", phone: "010-1234-5678" },
    ];
    const candsOverlap1 = buildContactTagCandidates(mockHistoryOverlap as any, phoneContactsOverlap1);
    assert.strictEqual(candsOverlap1.length, 1, "같은 번호면 하나로 합쳐져야 함");
    assert.strictEqual(candsOverlap1[0].name, "홍길동", "주소록 이름이 기록의 latestName보다 우선해야 함");
    assert.strictEqual(candsOverlap1[0].phone, "01012345678", "후보 phone은 정규화 번호로 유지되어야 함");
    assert.strictEqual(candsOverlap1[0].key, "tel:01012345678");
    assert.strictEqual(candsOverlap1[0].phoneEnding, "5678");

    // 01012345678 · 010-1234-5678 · 123456 · 5678 검색 모두 1개, 이름 검색 1개
    assert.strictEqual(filterContactCandidates(candsOverlap1, "01012345678").length, 1, "01012345678 검색 1개");
    assert.strictEqual(filterContactCandidates(candsOverlap1, "010-1234-5678").length, 1, "010-1234-5678 검색 1개");
    assert.strictEqual(filterContactCandidates(candsOverlap1, "123456").length, 1, "123456 검색 1개");
    assert.strictEqual(filterContactCandidates(candsOverlap1, "5678").length, 1, "5678 검색 1개");
    assert.strictEqual(filterContactCandidates(candsOverlap1, "홍길동").length, 1, "이름 검색 1개");

    // +82 10 1234 5678 표기인 경우에도 동일하게 검색되어야 함
    const phoneContactsOverlap2 = [
      { name: "홍길동", phone: "+82 10 1234 5678" },
    ];
    const candsOverlap2 = buildContactTagCandidates(mockHistoryOverlap as any, phoneContactsOverlap2);
    assert.strictEqual(candsOverlap2.length, 1);
    assert.strictEqual(candsOverlap2[0].name, "홍길동");
    assert.strictEqual(candsOverlap2[0].phone, "01012345678", "+82 번호도 정규화 번호로 유지되어야 함");
    assert.strictEqual(filterContactCandidates(candsOverlap2, "01012345678").length, 1);
    assert.strictEqual(filterContactCandidates(candsOverlap2, "010-1234-5678").length, 1);
    assert.strictEqual(filterContactCandidates(candsOverlap2, "123456").length, 1);
    assert.strictEqual(filterContactCandidates(candsOverlap2, "5678").length, 1);
    assert.strictEqual(filterContactCandidates(candsOverlap2, "홍길동").length, 1);

    // (4) 한 사람 번호 2개 → 후보 2개(끝자리로 구분)
    const phoneContactsTwoNumbers = [
      { name: "손흥민", phone: "010-1111-2222" },
      { name: "손흥민", phone: "010-3333-4444" },
    ];
    const candsTwoNumbers = buildContactTagCandidates({ call: [], sms: [] } as any, phoneContactsTwoNumbers);
    assert.strictEqual(candsTwoNumbers.length, 2, "한 사람 번호 2개면 후보 2개여야 함");
    assert.strictEqual(candsTwoNumbers[0].name, "손흥민");
    assert.strictEqual(candsTwoNumbers[1].name, "손흥민");
    assert.strictEqual(candsTwoNumbers[0].phoneEnding, "2222");
    assert.strictEqual(candsTwoNumbers[1].phoneEnding, "4444");
    assert.strictEqual(candsTwoNumbers[0].label, "손흥민 (…2222)");
    assert.strictEqual(candsTwoNumbers[1].label, "손흥민 (…4444)");

    // (5) 정규화 불가 번호 제외
    const phoneContactsInvalid = [
      { name: "유효한사람", phone: "010-7777-8888" },
      { name: "전화번호없음", phone: "" },
      { name: "문자만있음", phone: "invalid-phone" },
      { name: "공백만있음", phone: "   " },
    ];
    const candsInvalidFiltered = buildContactTagCandidates({ call: [], sms: [] } as any, phoneContactsInvalid);
    assert.strictEqual(candsInvalidFiltered.length, 1, "정규화 불가 번호는 제외되어야 함");
    assert.strictEqual(candsInvalidFiltered[0].name, "유효한사람");
    assert.strictEqual(candsInvalidFiltered[0].phoneEnding, "8888");

    // (6) createPhoneContactsLoader 검증 (flavor 분기 및 Promise 공유, 재조회 제어)
    // 6-a. oss 환경: listContacts 호출 0회, 빈 배열 반환
    let ossListCalls = 0;
    const ossLoader = createPhoneContactsLoader(
      async () => "oss",
      async () => {
        ossListCalls++;
        return { contacts: [{ name: "최민수", phone: "010-9999-0000" }] };
      }
    );
    const ossContacts = await ossLoader.load();
    assert.strictEqual(ossListCalls, 0, "oss 환경에서는 listContacts가 호출되지 않아야 함 (0회)");
    assert.deepStrictEqual(ossContacts, [], "oss 환경에서는 빈 배열 반환");

    // oss 환경에서 주소록 빈 배열 전달 시 기록 후보만 정상 반환 및 태그 판정 확인
    const mockOssHistory = {
      call: [
        { key: "tel:01099990000", name: "최민수", label: "최민수", saved: true, tag: null, tags: [], lastAt: 100 },
      ],
      sms: [],
    };
    const mockTags = [
      { contact_name: "최민수", tag: "#멘토", phone_number: "010-9999-0000", contact_key: "tel:01099990000" },
    ];
    const candsOss = buildContactTagCandidates(mockOssHistory as any, ossContacts, mockTags);
    assert.strictEqual(candsOss.length, 1, "oss 환경에서 기록 후보만 정상 반환");
    assert.strictEqual(candsOss[0].name, "최민수");
    assert.strictEqual(candsOss[0].tag, "#멘토");
    assert.strictEqual(candsOss[0].label, "최민수 (…0000) (#멘토)");

    // 6-b. full 환경 동시 load() 2번 -> 호출 1회 (진행 중 Promise 공유)
    let fullCalls = 0;
    let resolveList!: (val: { contacts: { name: string; phone: string }[] }) => void;
    const listPromise = new Promise<{ contacts: { name: string; phone: string }[] }>((resolve) => {
      resolveList = resolve;
    });
    const fullLoader = createPhoneContactsLoader(
      async () => "full",
      async () => {
        fullCalls++;
        return listPromise;
      }
    );
    const p1 = fullLoader.load();
    const p2 = fullLoader.load();
    resolveList({ contacts: [{ name: "김철수", phone: "010-1234-5678" }] });
    const [res1, res2] = await Promise.all([p1, p2]);
    assert.strictEqual(fullCalls, 1, "full 판 동시 load() 2회 호출 시 listContacts는 1회만 호출되어야 함");
    assert.strictEqual(res1.length, 1);
    assert.strictEqual(res2.length, 1);
    assert.strictEqual(res1[0].name, "김철수");

    // 6-c. 실패 -> 빈 배열 반환 (기록 후보 유지 가능)
    let failCalls = 0;
    const failLoader = createPhoneContactsLoader(
      async () => "full",
      async () => {
        failCalls++;
        throw new Error("Permission denied or native error");
      }
    );
    const failContacts = await failLoader.load();
    assert.strictEqual(failCalls, 1, "실패 시 1회 시도");
    assert.deepStrictEqual(failContacts, [], "실패 시 오류 전파 없이 빈 배열 반환");

    // 6-d. reset() 후 재조회 1회
    let recheckCalls = 0;
    const recheckLoader = createPhoneContactsLoader(
      async () => "full",
      async () => {
        recheckCalls++;
        return { contacts: [{ name: "이영희", phone: "010-9876-5432" }] };
      }
    );
    await recheckLoader.load();
    assert.strictEqual(recheckCalls, 1, "첫 load 시 1회 호출");
    await recheckLoader.load();
    assert.strictEqual(recheckCalls, 1, "캐시된 경우 재호출 없이 1회 유지");
    recheckLoader.reset();
    await recheckLoader.load();
    assert.strictEqual(recheckCalls, 2, "reset() 후 재조회 시 다시 1회 호출되어 총 2회");

    // 6-e. 경합 검증 ①: load(A) 시작 -> reset -> A 완료 -> load() -> 플러그인 2회, 새 결과 반환
    let pluginCalls1 = 0;
    let resolveA1!: (val: { contacts: { name: string; phone: string }[] }) => void;
    const promiseA1 = new Promise<{ contacts: { name: string; phone: string }[] }>((res) => {
      resolveA1 = res;
    });
    let resolveB1!: (val: { contacts: { name: string; phone: string }[] }) => void;
    const promiseB1 = new Promise<{ contacts: { name: string; phone: string }[] }>((res) => {
      resolveB1 = res;
    });
    const loaderRace1 = createPhoneContactsLoader(
      async () => "full",
      async () => {
        pluginCalls1++;
        return pluginCalls1 === 1 ? promiseA1 : promiseB1;
      }
    );
    const pA1 = loaderRace1.load();
    loaderRace1.reset();
    resolveA1({ contacts: [{ name: "옛사람", phone: "010-1111-1111" }] });
    await pA1;
    const pAfter1 = loaderRace1.load();
    resolveB1({ contacts: [{ name: "새사람", phone: "010-2222-2222" }] });
    const resAfter1 = await pAfter1;
    assert.strictEqual(pluginCalls1, 2, "load(A) -> reset -> A완료 -> load() 시 플러그인이 총 2회 호출되어야 함");
    assert.strictEqual(resAfter1.length, 1);
    assert.strictEqual(resAfter1[0].name, "새사람", "구 요청의 결과가 아닌 새 결과가 반환되어야 함");

    // 6-f. 경합 검증 ②: load(A) -> reset -> load(B) -> B 완료(New) -> A 완료(Old) -> load() -> New, 추가 호출 없음
    let pluginCalls2 = 0;
    let resolveA2!: (val: { contacts: { name: string; phone: string }[] }) => void;
    const promiseA2 = new Promise<{ contacts: { name: string; phone: string }[] }>((res) => {
      resolveA2 = res;
    });
    let resolveB2!: (val: { contacts: { name: string; phone: string }[] }) => void;
    const promiseB2 = new Promise<{ contacts: { name: string; phone: string }[] }>((res) => {
      resolveB2 = res;
    });
    const loaderRace2 = createPhoneContactsLoader(
      async () => "full",
      async () => {
        pluginCalls2++;
        return pluginCalls2 === 1 ? promiseA2 : promiseB2;
      }
    );
    const pA2 = loaderRace2.load();
    loaderRace2.reset();
    const pB2 = loaderRace2.load();
    resolveB2({ contacts: [{ name: "New", phone: "010-3333-3333" }] });
    const resB2 = await pB2;
    assert.strictEqual(resB2[0].name, "New");
    resolveA2({ contacts: [{ name: "Old", phone: "010-4444-4444" }] });
    await pA2;
    const resFinal2 = await loaderRace2.load();
    assert.strictEqual(pluginCalls2, 2, "load() 추가 호출 없이 총 2회 유지");
    assert.strictEqual(resFinal2[0].name, "New", "A 완료(Old)가 뒤늦게 끝나도 B의 New 캐시를 덮어쓰지 않아야 함");

    // 6-g. CandidateSession 순수 객체 동작 검증
    const testSession = createCandidateSession();
    assert.strictEqual(testSession.isActive(), false, "초기 세션은 비활성 상태");
    testSession.open();
    assert.strictEqual(testSession.isActive(), true, "open() 후 세션 활성 상태");
    const tok1 = testSession.begin();
    assert.strictEqual(testSession.isCurrent(tok1), true, "발급받은 최신 토큰은 유효");
    const tok2 = testSession.begin();
    assert.strictEqual(testSession.isCurrent(tok1), false, "새 토큰 발급 시 구 토큰은 무효");
    assert.strictEqual(testSession.isCurrent(tok2), true, "새 토큰은 유효");
    testSession.close();
    assert.strictEqual(testSession.isActive(), false, "close() 후 비활성 상태");
    assert.strictEqual(testSession.isCurrent(tok2), false, "close() 후에는 진행 중 토큰 무효");
    testSession.open();
    assert.strictEqual(testSession.isCurrent(tok2), false, "재개방 후에도 이전 세션의 토큰은 무효");

    // 6-h. 화면 세션 검증 ①: 태그 조회 대기 중 close → 완료 → 후보 쓰기 0, 로더 호출 0, 재개방 load 시 플러그인 호출 발생·새 결과
    let pluginCalls3 = 0;
    const loader3 = createPhoneContactsLoader(
      async () => "full",
      async () => {
        pluginCalls3++;
        return { contacts: [{ name: `새사람${pluginCalls3}`, phone: "010-9999-9999" }] };
      }
    );
    const session3 = createCandidateSession();
    session3.open();

    let resolveFetchTags3!: (tags: { id: number; contact_name: string; tag: string }[]) => void;
    const promiseFetchTags3 = new Promise<{ id: number; contact_name: string; tag: string }[]>((res) => {
      resolveFetchTags3 = res;
    });

    let candidateWritesAfterClose3 = 0;
    let isClosed3 = false;

    const loadContactCandidates3 = async (tagsOverride?: any[]) => {
      if (!session3.isActive()) return;
      const token = session3.begin();
      if (!session3.isCurrent(token)) return;
      const contacts = await loader3.load();
      if (!session3.isCurrent(token)) return;
      const tags = tagsOverride ?? (await promiseFetchTags3);
      if (!session3.isCurrent(token)) return;
      if (isClosed3) {
        candidateWritesAfterClose3++;
      }
    };

    const loadTags3 = async (refreshCandidates = false) => {
      const list = await promiseFetchTags3;
      if (refreshCandidates) {
        if (!session3.isActive()) return;
        await loadContactCandidates3(list);
      }
    };

    // 1) loadTags(true) 시작 (태그 조회 대기 상태)
    const pLoad3 = loadTags3(true);

    // 2) 태그 조회 대기 중 닫힘(close) 및 로더 reset
    isClosed3 = true;
    session3.close();
    loader3.reset();

    // 3) 태그 조회 완료
    resolveFetchTags3([{ id: 1, contact_name: "가상인물", tag: "동료" }]);
    await pLoad3;

    // 4) 닫힌 상태에서 후보 쓰기 0, 로더 호출 0 확인
    assert.strictEqual(candidateWritesAfterClose3, 0, "닫힌 뒤 후보 쓰기 0");
    assert.strictEqual(pluginCalls3, 0, "닫힌 동안 주소록 로더 플러그인 호출 0");

    // 5) 재개방 후 load 시 플러그인 호출 1회 발생 및 새 결과 반환
    session3.open();
    const resReopen3 = await loader3.load();
    assert.strictEqual(pluginCalls3, 1, "재개방 후 load() 시 플러그인 호출 1회 발생");
    assert.strictEqual(resReopen3[0].name, "새사람1", "새 결과 반환");

    // 6-i. 화면 세션 검증 ②: 태그 쓰기 대기 중 close → 완료 → 후보 쓰기 0, 로더 호출 0, 재개방 load 시 플러그인 호출 발생·새 결과
    let pluginCalls4 = 0;
    const loader4 = createPhoneContactsLoader(
      async () => "full",
      async () => {
        pluginCalls4++;
        return { contacts: [{ name: `새사람${pluginCalls4}`, phone: "010-8888-8888" }] };
      }
    );
    const session4 = createCandidateSession();
    session4.open();

    let resolveAddTag4!: () => void;
    const promiseAddTag4 = new Promise<void>((res) => {
      resolveAddTag4 = res;
    });

    let candidateWritesAfterClose4 = 0;
    let isClosed4 = false;

    const loadContactCandidates4 = async (tagsOverride?: any[]) => {
      if (!session4.isActive()) return;
      const token = session4.begin();
      if (!session4.isCurrent(token)) return;
      const contacts = await loader4.load();
      if (!session4.isCurrent(token)) return;
      if (isClosed4) {
        candidateWritesAfterClose4++;
      }
    };

    const loadTags4 = async (refreshCandidates = false) => {
      const list = [{ id: 1, contact_name: "가상인물", tag: "동료" }];
      if (refreshCandidates) {
        if (!session4.isActive()) return;
        await loadContactCandidates4(list);
      }
    };

    const handleAddTag4 = async () => {
      await promiseAddTag4;
      if (!session4.isActive()) return;
      await loadTags4(true);
    };

    // 1) 태그 쓰기 시작 (대기 상태)
    const pAdd4 = handleAddTag4();

    // 2) 태그 쓰기 대기 중 닫힘(close) 및 로더 reset
    isClosed4 = true;
    session4.close();
    loader4.reset();

    // 3) 태그 쓰기 완료
    resolveAddTag4();
    await pAdd4;

    // 4) 닫힌 상태에서 후보 쓰기 0, 로더 호출 0 확인
    assert.strictEqual(candidateWritesAfterClose4, 0, "닫힌 뒤 후보 쓰기 0");
    assert.strictEqual(pluginCalls4, 0, "닫힌 동안 주소록 로더 플러그인 호출 0");

    // 5) 재개방 후 load 시 플러그인 호출 1회 발생 및 새 결과 반환
    session4.open();
    const resReopen4 = await loader4.load();
    assert.strictEqual(pluginCalls4, 1, "재개방 후 load() 시 플러그인 호출 1회 발생");
    assert.strictEqual(resReopen4[0].name, "새사람1", "새 결과 반환");
  }

  console.log("askUi checks passed");
}

runAskUiChecks().catch((err) => {
  console.error("askUi checks failed:", err);
  process.exit(1);
});
