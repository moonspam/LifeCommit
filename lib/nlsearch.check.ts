/**
 * nlsearch.check.ts
 * LifeCommit 실행기(executeNlQuery), 조회 요청 모델(query.ts), 후보 로더(queryCandidates.ts) 동작 검증
 */

import assert from "node:assert/strict";
import {
  executeNlQuery,
  getTimeWindow,
  isNumberLikeSender,
  type NlFilter,
  type NlPlace,
  TIME_OF_DAY_BOUNDS,
  TIME_OF_DAY_UI_LABELS,
  type NlTimeOfDay,
} from "./nlsearch";
import { datePreset, validateRequest, toFilter, type QueryRequest } from "./query";
import { loadQueryCandidates } from "./queryCandidates";
import { shiftDate } from "./today";
import { openInitialised } from "./sqliteTestDb";
import { __setDBForTest } from "./db";
import { addContactTag, updateContactTag, deleteContactTag } from "./tagManager";
import { subscribe, EVENT_COMMITS_UPDATED } from "./events";

const MOCK_BASE_DATE = "2026-10-14"; // 수요일

async function runAllChecks() {
  console.log("=== 실행기, 요청 모델 및 후보 로더 검증 시작 ===");

  // 1. 날짜 프리셋(datePreset) 검증 (2026-10-14 수요일 기준)
  {
    const now = new Date("2026-10-14T12:00:00+09:00");
    const lastWeek = datePreset("lastWeek", now);
    assert.strictEqual(lastWeek.from, "2026-10-05", "지난주는 2026-10-05(월)부터여야 함");
    assert.strictEqual(lastWeek.to, "2026-10-11", "지난주는 2026-10-11(일)까지여야 함");

    const thisWeek = datePreset("thisWeek", now);
    assert.strictEqual(thisWeek.from, "2026-10-12", "이번 주는 2026-10-12(월)부터여야 함");
    assert.strictEqual(thisWeek.to, "2026-10-14", "이번 주는 오늘(2026-10-14)까지여야 함");

    const last7 = datePreset("last7", now);
    assert.strictEqual(last7.from, "2026-10-08", "최근 7일은 오늘 포함 7일(10-08 ~ 10-14)");
    assert.strictEqual(last7.to, "2026-10-14");
  }

  // 2. 실행기 규칙 SQLite 검증
  // 2.1) 날마다 시간대 창, 밤 창 자정 넘김, dayRange 기반
  {
    const { adapter } = await openInitialised();
    // 어제 밤: 2026-10-13 22:00 ~ 2026-10-14 06:00
    // 10-13 23:00 ~ 10-14 01:00 (2시간=7200초) 유튜브 세션 삽입
    const start = new Date("2026-10-13T23:00:00").getTime();
    const end = new Date("2026-10-14T01:00:00").getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "APP_USAGE", "com.google.android.youtube", start, end, 7200, "feat: YouTube", start]
    );

    // 10-14 07:00 (아침) 유튜브 세션 (밤 창에 포함 안 됨)
    const morningStart = new Date("2026-10-14T07:00:00").getTime();
    const morningEnd = new Date("2026-10-14T08:00:00").getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c2", 1, "APP_USAGE", "com.google.android.youtube", morningStart, morningEnd, 3600, "feat: YouTube", morningStart]
    );

    const res = await executeNlQuery(
      {
        from: "2026-10-13",
        to: "2026-10-13",
        timeOfDay: "night",
        apps: ["com.google.android.youtube"],
        places: [],
        people: [],
        kinds: ["app"],
        metric: "duration",
      },
      adapter
    );

    assert.equal(res.value, "2시간", "밤 시간대 자정 넘김 세션 전체(7200초)가 계산되어야 함");
    assert.strictEqual(res.understood, true);
    assert.ok(res.rows.length >= 1);
  }

  // 2.2) 세는 단위: 몇 번 열었어 = 앱 사용 세션 수, 문자 = 문자 대화 수
  {
    const { adapter } = await openInitialised();
    const t1 = new Date("2026-10-14T10:00:00").getTime();
    const t2 = new Date("2026-10-14T11:00:00").getTime();
    // 2개의 인스타그램 세션
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "APP_USAGE", "com.instagram.android", t1, t1 + 60000, 60, "feat: Instagram", t1]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c2", 1, "APP_USAGE", "com.instagram.android", t2, t2 + 60000, 60, "feat: Instagram", t2]
    );

    const appRes = await executeNlQuery(
      {
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: ["com.instagram.android"],
        places: [],
        people: [],
        kinds: ["app"],
        metric: "count",
      },
      adapter
    );

    assert.equal(appRes.value, "2", "앱 세션 수");
    assert.equal(appRes.unit, "회", "앱 단위는 회");
    assert.strictEqual(appRes.understood, true);

    // 문자 대화 1건
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c3", 1, "SMS", t1, t1, 0, "feat: SMS", JSON.stringify({ phoneNumber: "01011112222" }), t1]
    );
    const smsRes = await executeNlQuery(
      {
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["sms"],
        metric: "count",
      },
      adapter
    );
    assert.equal(smsRes.value, "1");
    assert.equal(smsRes.unit, "번 대화", "문자는 문자 대화 수로 표기");
    assert.strictEqual(smsRes.understood, true);
  }

  // 2.3) 장소 정확 비교 및 note 알림
  {
    const { adapter } = await openInitialised();
    const t = new Date("2026-10-14T14:00:00").getTime();
    // 역삼1동과 역삼2동 커밋
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "LOCATION", "역삼1동", t, t + 1800000, 1800, "feat: 역삼1동", t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c2", 1, "LOCATION", "역삼2동", t + 1800000, t + 3600000, 1800, "feat: 역삼2동", t + 1800000]
    );

    const res = await executeNlQuery(
      {
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [
          { source: "geofence", name: "역삼1동" },
          { source: "geofence", name: "역삼2동" },
        ],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter
    );

    assert.equal(res.value, "1시간", "역삼1동(30분) + 역삼2동(30분) = 1시간");
    assert.strictEqual(res.understood, true);
  }

  // 2.4) 목록 답의 사람 마스킹을 관계도와 동일하게 적용 (중립 이름: 박준호)
  {
    const { adapter } = await openInitialised();
    const t = new Date("2026-10-14T15:00:00").getTime();
    // 미저장 번호 (끝 4자리 마스킹 …5432)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "CALL", t, t + 60000, 60, "feat: Call", JSON.stringify({ phoneNumber: "01098765432" }), t]
    );
    // 저장된 연락처
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c2", 1, "CALL", t + 100000, t + 160000, 60, "feat: Call", JSON.stringify({ phoneNumber: "01011112222", contactName: "박준호" }), t + 100000]
    );

    const res = await executeNlQuery(
      {
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["call"],
        metric: "list",
      },
      adapter,
      {
        people: [
          { key: "tel:01011112222", name: "박준호", tag: "친구", saved: true },
          { key: "tel:01098765432", name: "…5432", tag: null, saved: false },
        ],
      }
    );

    const texts = res.rows.map((r) => r.text).join(" ");
    const titles = res.rows.map((r) => r.title).join(" ");
    assert.ok(texts.includes("박준호"), "저장된 사람은 이름 표시");
    assert.ok(titles.includes("저장 안 된 번호"), "미저장 번호는 저장 안 된 번호로 묶음 표시");
    assert.ok(!texts.includes("01098765432"), "전체 번호 노출 금지");
  }

  // 2.5) 사람 필터 빈 번호 무시 & +82 표기 정규화 일치
  {
    const { adapter } = await openInitialised();
    const t = new Date("2026-10-14T12:00:00").getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "CALL", t, t + 60000, 60, "feat: Empty phone call", JSON.stringify({ phoneNumber: "", contactName: "" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c2", 1, "CALL", t + 1000, t + 61000, 60, "feat: +82 call", JSON.stringify({ phoneNumber: "+821011112222", contactName: "박준호" }), t + 1000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c3", 1, "CALL", t + 2000, t + 62000, 60, "feat: Other call", JSON.stringify({ phoneNumber: "01099998888", contactName: "김서연" }), t + 2000]
    );

    const res = await executeNlQuery(
      {
        from: "2026-10-14",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["tel:01011112222"],
        kinds: ["call"],
        metric: "count",
      },
      adapter
    );

    assert.strictEqual(res.value, "1", "빈 번호 기록은 잡히지 않고 +82 표기는 정규화되어 정확히 1건이어야 함");
  }

  // 2.6) 하루 초과 기간의 근거 목록 날짜 표시
  {
    const { adapter } = await openInitialised();
    const t1 = new Date("2026-10-13T14:00:00").getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c1", 1, "APP_USAGE", "com.google.android.youtube", t1, t1 + 3600000, 3600, "feat: YouTube", t1]
    );

    const res = await executeNlQuery(
      {
        from: "2026-10-13",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: ["com.google.android.youtube"],
        places: [],
        people: [],
        kinds: ["app"],
        metric: "duration",
      },
      adapter
    );

    assert.ok(res.rows.length > 0, "행이 1건 이상이어야 함");
    assert.match(String(res.rows[0].time), /10[/. -]13/, "하루 초과 기간에서는 근거 목록 행의 time에 날짜가 표기되어야 함");
  }

  // 2.8) DST 전환일(2026-03-08, 2026-11-01) 시간대 경계 검증
  {
    const { execSync } = await import("child_process");
    execSync(
      `TZ=America/New_York npx tsx -e "
        import assert from 'assert';
        import { getTimeWindow } from './lib/nlsearch';
        const m = getTimeWindow('2026-03-08', 'morning');
        const ds = new Date(m.start);
        const de = new Date(m.end);
        assert.strictEqual(ds.getHours(), 6, 'morning start must be 06:00 in America/New_York');
        assert.strictEqual(de.getHours(), 11, 'morning end must be 11:59 in America/New_York');

        const n = getTimeWindow('2026-11-01', 'night');
        const ns = new Date(n.start);
        const ne = new Date(n.end);
        assert.strictEqual(ns.getHours(), 22, 'night start must be 22:00 in America/New_York');
        assert.strictEqual(ne.getHours(), 5, 'night end must be 05:59 in America/New_York');
      "`,
      { cwd: process.cwd(), stdio: "pipe" }
    );
  }

  // 3.1) REPLY 사람/앱 필터 적용 검증
  {
    const people = [
      { key: "msg:com.kakao.talk:지수", name: "지수", saved: true },
      { key: "msg:com.kakao.talk:민수", name: "민수", saved: true },
    ];
    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T14:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r1", 1, "REPLY", "com.kakao.talk", baseTs, baseTs, 0, "reply", JSON.stringify({ sender: "지수", packageName: "com.kakao.talk" }), baseTs]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r2", 1, "REPLY", "com.kakao.talk", baseTs + 1000, baseTs + 1000, 0, "reply", JSON.stringify({ sender: "민수", packageName: "com.kakao.talk" }), baseTs + 1000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r3", 1, "REPLY", "org.telegram.messenger", baseTs + 2000, baseTs + 2000, 0, "reply", JSON.stringify({ sender: "영희", packageName: "org.telegram.messenger" }), baseTs + 2000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r4", 1, "REPLY", "org.telegram.messenger", baseTs + 2500, baseTs + 2500, 0, "reply", JSON.stringify({ sender: "지수", packageName: "org.telegram.messenger" }), baseTs + 2500]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["u1", 1, "APP_USAGE", "com.kakao.talk", baseTs + 3000, baseTs + 4000, 1, "app", baseTs + 3000]
    );

    // 1) 카톡 앱 전체 답장 필터: 카톡 REPLY 2건
    const execKatalkReply = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: ["com.kakao.talk"],
        places: [],
        people: [],
        kinds: ["reply"],
        metric: "count",
      },
      adapter,
      { people }
    );
    assert.strictEqual(execKatalkReply.value, "2", "카톡 답장은 카톡 REPLY 2건만 세어야 함");

    // 2) msg:com.kakao.talk:지수 답장 필터: 1건만
    const execJisu = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["msg:com.kakao.talk:지수"],
        kinds: ["reply"],
        metric: "count",
      },
      adapter,
      { people }
    );
    assert.strictEqual(execJisu.value, "1", "지수 답장은 사람 키의 앱+이름(카톡) 1건만 세어야 함");
  }

  // 3.1.1) 번호형 sender 개인정보 숨김 및 메신저 동명이인 키 집합 실행
  {
    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T15:00:00`).getTime();

    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["nr1", 1, "REPLY", "com.kakao.talk", baseTs, baseTs, 0, "reply", JSON.stringify({ sender: "010-1234-5678", packageName: "com.kakao.talk" }), baseTs]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["nr2", 1, "REPLY", "com.kakao.talk", baseTs + 1000, baseTs + 1000, 0, "reply", JSON.stringify({ sender: "０１０‐９８７６‐５４３２", packageName: "com.kakao.talk" }), baseTs + 1000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["nr3", 1, "REPLY", "com.kakao.talk", baseTs + 2000, baseTs + 2000, 0, "reply", JSON.stringify({ sender: "박준호", packageName: "com.kakao.talk" }), baseTs + 2000]
    );

    const execTotalReply = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["reply"],
        metric: "count",
      },
      adapter,
      { people: [{ key: "msg:com.kakao.talk:박준호", name: "박준호", saved: true }] }
    );

    assert.strictEqual(execTotalReply.value, "3", "답장 수는 번호형 포함 총 3건이어야 함");
    const unsavedRow = execTotalReply.rows.find((r) => r.text.includes("저장 안 된 번호"));
    assert.ok(unsavedRow, "저장 안 된 번호 묶음 행이 존재해야 함");
    assert.strictEqual(unsavedRow?.text, "저장 안 된 번호 2건", "번호형 sender 2건이 하나로 묶여야 함");
    assert.ok(!execTotalReply.rows.some((r) => r.text.includes("010-1234-5678") || r.text.includes("9876")), "원문 전화번호가 rows에 노출되면 안 됨");

    // 동명 메신저 두 키 전달 시 정상 실행 검증
    const execBothJisu = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["msg:com.kakao.talk:지수", "msg:org.telegram.messenger:지수"],
        kinds: ["reply"],
        metric: "count",
      },
      adapter,
      {
        people: [
          { key: "msg:com.kakao.talk:지수", name: "지수", saved: true },
          { key: "msg:org.telegram.messenger:지수", name: "지수", saved: true },
        ],
      }
    );
    assert.strictEqual(execBothJisu.understood, true);
  }

  // 3.2) 행정동 체류 연결 (locationRuns + dongAt 주입) 및 창 교집합, 등록 장소 혼합, run 수 count, 전체 목록 묶음, 창 경계, 자정 넘김 검증
  {
    const { adapter } = await openInitialised();
    const fakeDongAt = (lat: number, lng: number) => {
      if (Math.abs(lat - 36.35) < 0.01 && Math.abs(lng - 127.38) < 0.01) return "둔산동";
      if (Math.abs(lat - 36.36) < 0.01 && Math.abs(lng - 127.34) < 0.01) return "온천동";
      return null;
    };

    // 케이스 1: 등록 안 된 장소 20분 체류 (14:00~14:20, 1200초), 5분 간격 커밋 4개로 쪼개져 1개 run 형성
    const t1400 = new Date(`${MOCK_BASE_DATE}T14:00:00`).getTime();
    for (let i = 0; i < 4; i++) {
      const cStart = t1400 + i * 5 * 60000;
      const cEnd = cStart + 5 * 60000;
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`loc-split-${i}`, 1, "LOCATION", null, 36.3501, 127.3801, cStart, cEnd, 300, "loc", cStart]
      );
    }

    // 케이스 2: 창 경계에 걸친 run (저녁 18:00~22:00 창에 걸치는 17:00~19:00 체류 2시간, 온천동)
    const t1700 = new Date(`${MOCK_BASE_DATE}T17:00:00`).getTime();
    const t1900 = new Date(`${MOCK_BASE_DATE}T19:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["loc-oncheon", 1, "LOCATION", null, 36.3601, 127.3401, t1700, t1900, 7200, "loc", t1700]
    );

    // 케이스 3: 등록 장소 ("회사", geofence_name 설정됨, 둔산동 위치, 21:00~22:00 1시간)
    const t2100 = new Date(`${MOCK_BASE_DATE}T21:00:00`).getTime();
    const t2200 = new Date(`${MOCK_BASE_DATE}T22:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["loc-work", 1, "LOCATION", "회사", 36.3502, 127.3802, t2100, t2200, 3600, "loc", t2100]
    );

    // 1) 둔산동(행정동) 오후 20분 체류 질의
    const execDayDunsan = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "afternoon",
        apps: [],
        places: [{ source: "dong", name: "둔산동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execDayDunsan.value, "20분", "미등록 장소의 20분 체류가 dongAt을 통해 20분으로 계산되어야 함");

    // 2) 창 경계 걸친 run 교집합: 17~19시 체류의 저녁(18~22) 교집합은 1시간
    const execEveningOncheon = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "evening",
        apps: [],
        places: [{ source: "dong", name: "온천동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execEveningOncheon.value, "1시간", "17~19시 체류의 저녁(18~22) 교집합은 1시간이어야 함");

    // 3) 등록 장소 회사 체류: 21~22시 1시간
    const execEveningWork = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "evening",
        apps: [],
        places: [{ source: "geofence", name: "회사" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execEveningWork.value, "1시간", "등록 장소 회사 체류 1시간이 정상 반영되어야 함");

    // 4) 장소 방문 횟수는 run 수여야 함: 4개 커밋으로 쪼개진 둔산동 체류는 1회!
    const execDunsanCount = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "afternoon",
        apps: [],
        places: [{ source: "dong", name: "둔산동" }],
        people: [],
        kinds: ["location"],
        metric: "count",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execDunsanCount.value, "1", "4개 커밋으로 쪼개진 20분 체류의 방문 횟수는 1회(run 수)여야 함");

    // 5) 전체 목록 질의에서 위치 기록이 커밋 개별 행이 아니라 run 단위 1줄로 묶여야 함 (NL1-5 #4)
    const execWhatList = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "afternoon",
        apps: [],
        places: [],
        people: [],
        kinds: [],
        metric: "list",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    const locRows = execWhatList.rows.filter((r) => r.title === "장소 방문");
    assert.strictEqual(locRows.length, 2, "오후 창에 걸친 두 체류(둔산동, 온천동)가 run 단위 1줄씩 총 2행이어야 함");
    const dunsanRow = locRows.find((r) => r.text.includes("둔산동"));
    assert.ok(dunsanRow, "둔산동 행이 있어야 함");
    assert.strictEqual(dunsanRow.text, "둔산동 · 20분", "4개 커밋이 1개의 '둔산동 · 20분'으로 묶여야 함");
    const oncheonRow = locRows.find((r) => r.text.includes("온천동"));
    assert.ok(oncheonRow, "온천동 행이 있어야 함");
    assert.strictEqual(oncheonRow.text, "온천동 · 1시간", "17~19시 체류 중 오후(12~18) 교집합인 1시간이어야 함");

    // 6) 창 끝을 넘는 run이 창 안 커밋만 읽어 잘리는 문제 검증 (대흥동 21:40~22:20 체류의 저녁 18~22 교집합)
    const t2140 = new Date(`${MOCK_BASE_DATE}T21:40:00`).getTime();
    for (let i = 0; i <= 8; i++) {
      const cStart = t2140 + i * 5 * 60000;
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`loc-daeheung-${i}`, 1, "LOCATION", null, 36.3201, 127.4201, cStart, cStart, 0, "loc", cStart]
      );
    }
    const daeheungDongAt = (lat: number, lng: number) => {
      if (Math.abs(lat - 36.32) < 0.01 && Math.abs(lng - 127.42) < 0.01) return "대흥동";
      return fakeDongAt(lat, lng);
    };

    const execDaeheung = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "evening",
        apps: [],
        places: [{ source: "dong", name: "대흥동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: daeheungDongAt }
    );
    assert.strictEqual(execDaeheung.value, "20분", "창 끝(22:00)을 넘는 21:40~22:20 체류의 저녁 교집합은 20분이어야 함");

    // 7) 날짜 경계에 걸친 방문 수 중복 제거 검증 (NL1-6 #6): 10/13 23:30 ~ 10/14 00:30 단일 run
    const tYesterday2330 = new Date("2026-10-13T23:30:00").getTime();
    const tToday0030 = new Date("2026-10-14T00:30:00").getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["loc-overnight", 1, "LOCATION", null, 36.3501, 127.3801, tYesterday2330, tToday0030, 3600, "overnight", tYesterday2330]
    );

    const execOvernight = await executeNlQuery(
      {
        from: "2026-10-13",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [{ source: "dong", name: "둔산동" }],
        people: [],
        kinds: ["location"],
        metric: "count",
      },
      adapter,
      { dongAt: daeheungDongAt }
    );
    // 오후 둔산 1회 + 저녁 회사(둔산동) 1회 + overnight 1회 = 총 3회
    assert.strictEqual(execOvernight.value, "3", "자정에 걸친 단일 run은 2일 기간 질의 시 날짜별로 중복 카운트되지 않아야 함");
  }

  // 3.3) LIMIT 선적용 검증: 최신 51개 무관 이벤트가 있어도 특정 필터 목록이 조회되어야 함
  {
    const { adapter } = await openInitialised();
    const targetPhone = "01011112222";
    const earlyMorning = new Date(`${MOCK_BASE_DATE}T08:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-target", 1, "CALL", earlyMorning, earlyMorning + 120000, 120, "call", JSON.stringify({ phoneNumber: targetPhone, contactName: "박준호" }), earlyMorning]
    );

    for (let i = 1; i <= 51; i++) {
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`app-${i}`, 1, "APP_USAGE", "com.google.android.youtube", earlyMorning + i * 60000, earlyMorning + i * 60000 + 30000, 30, "app", earlyMorning + i * 60000]
      );
    }

    const execList = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [`tel:${targetPhone}`],
        kinds: ["call"],
        metric: "list",
      },
      adapter,
      { people: [{ key: `tel:${targetPhone}`, name: "박준호", saved: true }] }
    );
    assert.strictEqual(execList.rows.length, 1, "최신 51개 앱 이벤트가 있어도 08시 통화가 누락되지 않아야 함");
  }

  // 4.2) 동명이인 다중 키 전달 시 실행기에서 둘 다 정상 집계 (더 이상 거절하지 않음)
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-seoyeon1", 1, "CALL", t, t + 60000, 60, "call", JSON.stringify({ contactName: "김서연", phoneNumber: "01033334444" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-seoyeon2", 1, "CALL", t + 100000, t + 160000, 60, "call", JSON.stringify({ contactName: "김서연", phoneNumber: "01055556666" }), t + 100000]
    );

    const execRes = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["tel:01033334444", "tel:01055556666"],
        kinds: ["call"],
        metric: "count",
      },
      adapter,
      {
        people: [
          { key: "tel:01033334444", name: "김서연", saved: true },
          { key: "tel:01055556666", name: "김서연", saved: true },
        ],
      }
    );
    assert.strictEqual(execRes.understood, true, "명시된 사람 키 집합은 거절되지 않고 실행되어야 함");
    assert.strictEqual(execRes.value, "2", "두 번호 통화가 모두 합산되어 2회여야 함");
  }

  // 4.2-b) 번호 끝 8자리까지 동일한 동명이인('01011111234' vs '01111111234' 두 '민수') 목록 표시 구분 및 다중 실행
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-minsu1", 1, "CALL", t, t + 60000, 60, "call", JSON.stringify({ contactName: "민수", phoneNumber: "01011111234" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-minsu2", 1, "CALL", t + 100000, t + 160000, 60, "call", JSON.stringify({ contactName: "민수", phoneNumber: "01111111234" }), t + 100000]
    );

    const execList = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["call"],
        metric: "list",
      },
      adapter,
      {
        people: [
          { key: "tel:01011111234", name: "민수", saved: true },
          { key: "tel:01111111234", name: "민수", saved: true },
        ],
      }
    );
    const minsuRows = execList.rows.filter((r) => r.text.includes("민수"));
    assert.strictEqual(minsuRows.length, 2, "두 민수 통화 2건이 모두 표시되어야 함");
    assert.notStrictEqual(minsuRows[0].text, minsuRows[1].text, "두 민수의 표시 라벨이 구분되어야 함");
    assert.ok(minsuRows.some((r) => r.text.includes("01011111234")), "첫 번째 민수의 고유 접미사가 포함되어야 함");
    assert.ok(minsuRows.some((r) => r.text.includes("01111111234")), "두 번째 민수의 고유 접미사가 포함되어야 함");

    // 두 민수 키를 명시해 count 실행
    const execBothMinsu = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["tel:01011111234", "tel:01111111234"],
        kinds: ["call"],
        metric: "count",
      },
      adapter,
      {
        people: [
          { key: "tel:01011111234", name: "민수", saved: true },
          { key: "tel:01111111234", name: "민수", saved: true },
        ],
      }
    );
    assert.strictEqual(execBothMinsu.understood, true);
    assert.strictEqual(execBothMinsu.value, "2");
  }

  // 4.3) 미저장 번호형 기본 숨김 및 묶음 표시 검증
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T12:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-junho", 1, "CALL", t, t + 60000, 60, "call", JSON.stringify({ contactName: "박준호", phoneNumber: "01011112222" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-unsaved1", 1, "CALL", t + 100000, t + 160000, 60, "call", JSON.stringify({ phoneNumber: "01099995432" }), t + 100000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-unsaved2", 1, "CALL", t + 200000, t + 260000, 60, "call", JSON.stringify({ phoneNumber: "01088888888" }), t + 200000]
    );

    const execList = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["call"],
        metric: "list",
      },
      adapter,
      { people: [{ key: "tel:01011112222", name: "박준호", saved: true }] }
    );

    assert.strictEqual(execList.rows.length, 2, "미저장 번호들은 개별 노출되지 않고 묶여서 1행으로 표시되어야 함");
    const unsavedRow = execList.rows.find((r) => r.title.includes("저장 안 된 번호"));
    assert.ok(unsavedRow, "저장 안 된 번호 묶음 행이 존재해야 함");
    assert.strictEqual(unsavedRow.text, "2건", "미저장 통화 2건이 묶여 있어야 함");
  }

  // 4.4) 종류 생략 시 사람/장소 필터 무시 방지 검증 (NL1-7 #1)
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T12:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-yt", 1, "APP_USAGE", "com.google.android.youtube", t, t + 600000, 600, "youtube", t]
    );

    const people = [{ key: "tel:01011112222", name: "박준호", saved: true }];

    // 1-1) duration: 통화로 실행되어야 하며, 유튜브 10분으로 대체 금지 (통화 없으므로 0초)
    const execPersonDuration = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: [], metric: "duration" },
      adapter,
      { people }
    );
    assert.notStrictEqual(execPersonDuration.value, "10분", "사람 질의에 유튜브 10분이 답으로 나와서는 안 됨");
    assert.strictEqual(execPersonDuration.value, "0초", "통화 기록이 없으므로 0초여야 함");
    assert.strictEqual(execPersonDuration.rows.length, 0);

    // 1-2) count: 통화·문자·답장으로 실행되어야 하며, 유튜브 1회 대체 금지 (0회)
    const execPersonCount = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: [], metric: "count" },
      adapter,
      { people }
    );
    assert.notStrictEqual(execPersonCount.value, "1", "사람 질의에 유튜브 1회가 답으로 나와서는 안 됨");
    assert.strictEqual(execPersonCount.value, "0");
    assert.strictEqual(execPersonCount.rows.length, 0);

    // 1-3) list: 통화·문자로 실행되어야 하며, 유튜브 기록 대체 금지 (0건)
    const execPersonList = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: [], metric: "list" },
      adapter,
      { people }
    );
    assert.strictEqual(execPersonList.rows.length, 0);

    // 2) 장소 조건이 있고 종류가 생략된 경우: 위치(체류)로 실행되어야 하며 유튜브 대체 금지 (0초)
    const execPlaceDuration = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "역삼" }], people: [], kinds: [], metric: "duration" },
      adapter,
      { people }
    );
    assert.strictEqual(execPlaceDuration.value, "0초");
    assert.strictEqual(execPlaceDuration.rows.length, 0);

    // 3) 통화 5분이 실제로 추가되면 사람 질의에 정상 반영됨 확인
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-junho-5m", 1, "CALL", t + 700000, t + 1000000, 300, "call", JSON.stringify({ phoneNumber: "01011112222" }), t + 700000]
    );
    const execWithCall = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: [], metric: "duration" },
      adapter,
      { people }
    );
    assert.strictEqual(execWithCall.value, "5분", "실제 통화 300초(5분)가 정상 계산되어야 함");
    assert.strictEqual(execWithCall.rows.length, 1);
  }

  // 4.5) 긴 연속 체류 방문 중복 방지 (48시간 연속 체류 run 수 1회, 48시간 합산)
  {
    const { adapter } = await openInitialised();
    const startTs = new Date("2026-10-13T00:00:00").getTime();
    for (let i = 0; i < 48; i++) {
      const cStart = startTs + i * 3600 * 1000;
      const cEnd = cStart + 3600 * 1000;
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`loc-48h-${i}`, 1, "LOCATION", null, 36.3501, 127.3801, cStart, cEnd, 3600, "loc", cStart]
      );
    }

    const fakeDongAt = () => "둔산동";

    // 1) 방문 횟수(count): 48시간 전체가 단 1개의 연속 체류 run이므로 방문 수는 1회
    const execCount = await executeNlQuery(
      {
        from: "2026-10-13",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [{ source: "dong", name: "둔산동" }],
        people: [],
        kinds: ["location"],
        metric: "count",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execCount.value, "1", "48시간 연속 체류의 방문 수는 1회여야 함");

    // 2) 시간 합산(duration): 24시간 + 24시간 = 48시간
    const execDuration = await executeNlQuery(
      {
        from: "2026-10-13",
        to: "2026-10-14",
        timeOfDay: "any",
        apps: [],
        places: [{ source: "dong", name: "둔산동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execDuration.value, "48시간", "각 날짜 몫 합산 = 48시간이어야 함");
  }

  // 4.6) 숫자 섞인 일반 이름 보존 및 번호형 발신자 판정 검증
  {
    assert.strictEqual(isNumberLikeSender("친구1234567"), false, "친구1234567은 일반 이름이므로 false여야 함");
    assert.strictEqual(isNumberLikeSender("010.5555.6666"), true, "010.5555.6666은 번호형이므로 true");
    assert.strictEqual(isNumberLikeSender("(010) 7777 8888"), true, "(010) 7777 8888은 번호형이므로 true");
    assert.strictEqual(isNumberLikeSender("０１０‐９８７６‐５４３２"), true, "전각 번호는 번호형이므로 true");

    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T12:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r-friend", 1, "REPLY", "com.kakao.talk", baseTs, baseTs, 0, "reply", JSON.stringify({ sender: "친구1234567", packageName: "com.kakao.talk" }), baseTs]
    );

    const people = [{ key: "msg:com.kakao.talk:친구1234567", name: "친구1234567", saved: true }];

    // 특정 사람 답장 질의
    const exec = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["msg:com.kakao.talk:친구1234567"], kinds: ["reply"], metric: "count" },
      adapter,
      { people }
    );
    assert.strictEqual(exec.value, "1", "친구1234567 답장 1회가 나와야 함");

    // 전체 답장 질의 시 일반 행으로 노출
    const execAll = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: [], kinds: ["reply"], metric: "count" },
      adapter,
      { people }
    );
    assert.strictEqual(execAll.value, "1");
    assert.strictEqual(execAll.rows.some((r) => r.text.includes("친구1234567")), true, "친구1234567 행이 결과에 포함되어야 함");
    assert.strictEqual(execAll.rows.some((r) => r.text.includes("저장 안 된 번호")), false, "친구1234567은 저장 안 된 번호로 숨겨지면 안 됨");
  }

  // 4.7) 메신저 혼합 이름 키와 전화 연락처 키 분리 검증
  {
    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T12:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["r-msg-friend", 1, "REPLY", "com.kakao.talk", baseTs, baseTs, 0, "reply", JSON.stringify({ sender: "친구01055556666", packageName: "com.kakao.talk" }), baseTs]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-other-person", 1, "CALL", baseTs + 1000, baseTs + 121000, 120, "call", JSON.stringify({ phoneNumber: "01055556666", contactName: "다른사람" }), baseTs + 1000]
    );

    const execCount = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["msg:com.kakao.talk:친구01055556666"],
        kinds: ["reply"],
        metric: "count",
      },
      adapter,
      {
        people: [
          { key: "msg:com.kakao.talk:친구01055556666", name: "친구01055556666", saved: true },
          { key: "tel:01055556666", name: "다른사람", saved: true },
        ],
      }
    );
    assert.strictEqual(execCount.value, "1", "다른 사람의 통화가 포함되지 않고 오직 답장 1회여야 함");
    assert.strictEqual(execCount.rows.length, 1);
  }

  // 4.8) 통화·문자 횟수 측정 시 단위 및 종류별 근거 행 검증
  {
    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-junho-1", 1, "CALL", baseTs, baseTs + 60000, 60, "call", JSON.stringify({ phoneNumber: "01011112222" }), baseTs]
    );

    const people = [{ key: "tel:01011112222", name: "박준호", saved: true }];
    const execCall = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["tel:01011112222"],
        kinds: ["call"],
        metric: "count",
      },
      adapter,
      { people }
    );
    assert.strictEqual(execCall.value, "1");
    assert.strictEqual(execCall.unit, "회", "통화 단위는 '회'");

    // 문자 2건 추가
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["s-junho-1", 1, "SMS", baseTs + 100000, baseTs + 100000, 0, "sms", JSON.stringify({ phoneNumber: "01011112222" }), baseTs + 100000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["s-junho-2", 1, "SMS", baseTs + 200000, baseTs + 200000, 0, "sms", JSON.stringify({ phoneNumber: "01011112222" }), baseTs + 200000]
    );

    const execMulti = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: ["tel:01011112222"],
        kinds: ["call", "sms"],
        metric: "count",
      },
      adapter,
      { people }
    );
    assert.strictEqual(execMulti.value, "3");
    assert.strictEqual(execMulti.unit, "회", "통화와 문자가 합쳐졌을 때도 합계 단위는 '회'");
    assert.strictEqual(execMulti.rows.length, 3);
  }

  // 4.10) 전화 연락처와 메신저 동명이인 시 각각 명시적 실행 및 단독 집계 검증
  {
    const { adapter } = await openInitialised();
    const baseTs = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-seoyeon-tel", 1, "CALL", baseTs, baseTs + 60000, 60, "call", JSON.stringify({ phoneNumber: "01011112222" }), baseTs]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-seoyeon-kakao", 1, "REPLY", baseTs + 1000, baseTs + 1000, 0, "reply", JSON.stringify({ sender: "김서연", packageName: "com.kakao.talk" }), baseTs + 1000]
    );

    const people = [
      { key: "tel:01011112222", name: "김서연", saved: true },
      { key: "msg:com.kakao.talk:김서연", name: "김서연", saved: true },
    ];

    // 전화 키로 통화 count 실행 -> 1회
    const execCall = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: ["call"], metric: "count" },
      adapter,
      { people }
    );
    assert.strictEqual(execCall.understood, true);
    assert.strictEqual(execCall.value, "1");

    // 카톡 키로 답장 count 실행 -> 1회
    const execReply = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["msg:com.kakao.talk:김서연"], kinds: ["reply"], metric: "count" },
      adapter,
      { people }
    );
    assert.strictEqual(execReply.understood, true);
    assert.strictEqual(execReply.value, "1");

    // 저장된 번호 키(tel:01011112222)로 통화 실행
    const execExact = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01011112222"], kinds: ["call"], metric: "count" },
      adapter,
      { people }
    );
    assert.strictEqual(execExact.understood, true);
    assert.strictEqual(execExact.value, "1");

    // 별도 저장된 번호(tel:01022223333 박준호) 통화 데이터 및 실행
    const junhoTs = new Date(`${MOCK_BASE_DATE}T11:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-junho-call", 1, "CALL", junhoTs, junhoTs + 60000, 60, "call", JSON.stringify({ phoneNumber: "01022223333", contactName: "박준호" }), junhoTs]
    );
    const execJunho = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [], people: ["tel:01022223333"], kinds: ["call"], metric: "count" },
      adapter,
      { people: [{ key: "tel:01022223333", name: "박준호", saved: true }] }
    );
    assert.strictEqual(execJunho.understood, true);
    assert.strictEqual(execJunho.value, "1");
  }

  // 10. 실제 LOCATION 레코드 목록 질의 실행 검증
  {
    const yesterdayDate = shiftDate(MOCK_BASE_DATE, -1);
    const { adapter } = await openInitialised();
    const locTs = new Date(`${yesterdayDate}T15:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, geofence_name, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-loc-visit", 1, "LOCATION", locTs, locTs + 1800000, 1800, "서면역", "서면역 체류", JSON.stringify({ geofenceName: "서면역" }), locTs]
    );
    const execLocList = await executeNlQuery(
      { from: yesterdayDate, to: yesterdayDate, timeOfDay: "any", apps: [], places: [{ source: "geofence", name: "서면역" }], people: [], kinds: ["location"], metric: "list" },
      adapter
    );
    assert.strictEqual(execLocList.understood, true, "위치 목록 질의 실행 성공");
    assert.ok(execLocList.rows.length > 0, "방문한 장소 행이 포함되어야 함");
    assert.ok(execLocList.rows.some((r) => r.text.includes("서면역")), "서면역 텍스트 포함");
  }

  // 12.1 통화 시간 duration 실행 검증 (60초+120초 = 3분)
  {
    const yesterdayDate = shiftDate(MOCK_BASE_DATE, -1);
    const { adapter } = await openInitialised();
    const callStart1 = new Date(`${yesterdayDate}T10:00:00`).getTime();
    const callStart2 = new Date(`${yesterdayDate}T11:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-call-dur-1", 1, "CALL", callStart1, callStart1 + 60000, 60, "통화 60초", JSON.stringify({ personKey: "tel:01011112222" }), callStart1]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-call-dur-2", 1, "CALL", callStart2, callStart2 + 120000, 120, "통화 120초", JSON.stringify({ personKey: "tel:01011112222" }), callStart2]
    );

    const execCallDuration = await executeNlQuery(
      { from: yesterdayDate, to: yesterdayDate, timeOfDay: "any", apps: [], places: [], people: [], kinds: ["call"], metric: "duration" },
      adapter
    );
    assert.strictEqual(execCallDuration.understood, true, "통화 시간 실행 성공");
    assert.strictEqual(execCallDuration.value, "3분", "통화 60초+120초 합계는 3분이어야 함");
  }

  // 12.2 집 체류 시간 duration 실행 검증 (1800초 = 30분)
  {
    const yesterdayDate = shiftDate(MOCK_BASE_DATE, -1);
    const { adapter } = await openInitialised();
    const homeLocTs = new Date(`${yesterdayDate}T19:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, geofence_name, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-home-stay", 1, "LOCATION", homeLocTs, homeLocTs + 1800000, 1800, "집", "집 체류", JSON.stringify({ geofenceName: "집" }), homeLocTs]
    );
    const execHomeDuration = await executeNlQuery(
      { from: yesterdayDate, to: yesterdayDate, timeOfDay: "any", apps: [], places: [{ source: "geofence", name: "집" }], people: [], kinds: ["location"], metric: "duration" },
      adapter
    );
    assert.strictEqual(execHomeDuration.understood, true, "집 체류 시간 실행 성공");
    assert.strictEqual(execHomeDuration.value, "30분", "집 체류 1800초 합계는 30분이어야 함");
  }

  // 14.2) 상대별 합계 및 마스킹 검증 (중립 이름: 박준호, 김서연)
  {
    const yesterdayDate = shiftDate(MOCK_BASE_DATE, -1);
    const { adapter } = await openInitialised();
    const whoStart1 = new Date(`${yesterdayDate}T14:00:00`).getTime();
    const whoStart2 = new Date(`${yesterdayDate}T14:30:00`).getTime();
    const whoStart3 = new Date(`${yesterdayDate}T15:00:00`).getTime();
    const whoStartUnsaved = new Date(`${yesterdayDate}T16:00:00`).getTime();

    // 박준호 통화 2건 (30초 + 30초 = 60초 = 1분)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-who-1", 1, "CALL", whoStart1, whoStart1 + 30000, 30, "통화 박준호 1", JSON.stringify({ phoneNumber: "01011112222" }), whoStart1]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-who-2", 1, "CALL", whoStart2, whoStart2 + 30000, 30, "통화 박준호 2", JSON.stringify({ phoneNumber: "01011112222" }), whoStart2]
    );
    // 김서연 통화 1건 (120초 = 2분)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-who-3", 1, "CALL", whoStart3, whoStart3 + 120000, 120, "통화 김서연", JSON.stringify({ phoneNumber: "01099998888" }), whoStart3]
    );
    // 미저장 번호 통화 1건 (60초 = 1분, 개인정보 마스킹 확인)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-who-unsaved", 1, "CALL", whoStartUnsaved, whoStartUnsaved + 60000, 60, "통화 미저장", JSON.stringify({ phoneNumber: "01055557777" }), whoStartUnsaved]
    );

    const execWhoCall = await executeNlQuery(
      {
        from: yesterdayDate,
        to: yesterdayDate,
        timeOfDay: "any",
        apps: [],
        places: [],
        people: [],
        kinds: ["call"],
        metric: "duration",
      },
      adapter,
      {
        people: [
          { key: "tel:01011112222", name: "박준호", saved: true },
          { key: "tel:01099998888", name: "김서연", saved: true },
        ],
      }
    );

    assert.strictEqual(execWhoCall.understood, true);
    assert.strictEqual(execWhoCall.value, "4분", "총 통화 시간 합계는 4분(30+30+120+60초)이어야 함");

    const titles = execWhoCall.rows.map((r) => r.title);
    assert.ok(titles.includes("박준호"), "근거 행 제목에 관계도 라벨 '박준호'가 나타나야 함");
    assert.ok(titles.includes("김서연"), "근거 행 제목에 관계도 라벨 '김서연'이 나타나야 함");

    const junhoRow = execWhoCall.rows.find((r) => r.title === "박준호");
    assert.ok(junhoRow, "박준호 합산 행 존재");
    assert.strictEqual(junhoRow?.text, "1분", "박준호 30초+30초 통화는 '1분'으로 합산되어야 함");

    const seoyeonRow = execWhoCall.rows.find((r) => r.title === "김서연");
    assert.ok(seoyeonRow, "김서연 합산 행 존재");
    assert.strictEqual(seoyeonRow?.text, "2분", "김서연 120초 통화는 '2분'이어야 함");

    const unsavedRow = execWhoCall.rows.find((r) => r.title === "저장 안 된 번호");
    assert.ok(unsavedRow, "저장 안 된 번호 묶음 행 존재");
    assert.ok(unsavedRow?.text.includes("1분"), "저장 안 된 번호 통화 시간(1분)이 표기되어야 함");
    assert.ok(!execWhoCall.rows.some((r) => r.text.includes("01055557777") || r.title.includes("01055557777")), "원문 전화번호가 rows에 노출되면 안 됨");
  }

  // ── 신규 검증 ──
  // 신규 1: lib/query.ts validateRequest 검증
  {
    const validBase: QueryRequest = {
      from: "2026-10-10",
      to: "2026-10-12",
      timeOfDay: "any",
      kind: "app",
      target: null,
      metric: "duration",
    };

    // 1-1) 잘못된 날짜 (2026-02-30)
    assert.strictEqual(validateRequest({ ...validBase, from: "2026-02-30" }).ok, false, "2026-02-30은 거절되어야 함");
    assert.strictEqual(validateRequest({ ...validBase, to: "2026-13-01" }).ok, false, "2026-13-01은 거절되어야 함");

    // 1-2) 날짜 역전 (from > to)
    assert.strictEqual(validateRequest({ ...validBase, from: "2026-10-15", to: "2026-10-10" }).ok, false, "from > to는 거절되어야 함");

    // 1-3) 93일 초과 거절, 92일 통과
    assert.strictEqual(validateRequest({ ...validBase, from: "2026-01-01", to: "2026-04-02" }).ok, true, "92일은 허용");
    assert.strictEqual(validateRequest({ ...validBase, from: "2026-01-01", to: "2026-04-03" }).ok, false, "93일은 초과 거절");

    // 1-4) tag + reply 거절
    assert.strictEqual(
      validateRequest({ ...validBase, kind: "reply", target: { type: "tag", tag: "친구" }, metric: "count" }).ok,
      false,
      "tag + reply는 거절되어야 함"
    );

    // 1-5) 빈 태그 문자열 거절
    assert.strictEqual(
      validateRequest({ ...validBase, kind: "call", target: { type: "tag", tag: "   " }, metric: "count" }).ok,
      false,
      "공백 태그는 거절되어야 함"
    );
    assert.strictEqual(
      validateRequest({ ...validBase, kind: "call", target: { type: "tag", tag: "#@" }, metric: "count" }).ok,
      false,
      "#@만 있는 빈 태그는 거절되어야 함"
    );

    // 1-6) app 대상 + call 거절
    assert.strictEqual(
      validateRequest({ ...validBase, kind: "call", target: { type: "app", pkg: "com.google.android.youtube" }, metric: "count" }).ok,
      false,
      "app 대상 + call은 거절되어야 함"
    );
  }

  // 신규 2: toFilter 태그 전개 및 빈 태그 차단 검증
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    // 두 사람의 통화 데이터 (동명이인 김서연, 서로 다른 번호 01011112222, 01033334444)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-tag-1", 1, "CALL", t, t + 60000, 60, "call 1", JSON.stringify({ phoneNumber: "01011112222", contactName: "김서연" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-tag-2", 1, "CALL", t + 100000, t + 160000, 60, "call 2", JSON.stringify({ phoneNumber: "01033334444", contactName: "김서연" }), t + 100000]
    );

    const ctx = {
      people: [
        { key: "tel:01011112222", name: "김서연", tag: "#동료", saved: true },
        { key: "tel:01033334444", name: "김서연", tag: "#동료", saved: true },
      ],
    };

    const reqTag: QueryRequest = {
      from: MOCK_BASE_DATE,
      to: MOCK_BASE_DATE,
      timeOfDay: "any",
      kind: "call",
      target: { type: "tag", tag: "동료" },
      metric: "count",
    };

    const filterRes = toFilter(reqTag, ctx);
    assert.strictEqual(filterRes.ok, true, "toFilter 성공해야 함");
    if (filterRes.ok) {
      assert.deepStrictEqual(filterRes.value.people.sort(), ["tel:01011112222", "tel:01033334444"].sort(), "두 번호 키가 모두 포함되어야 함");
      const exec = await executeNlQuery(filterRes.value, adapter, { people: ctx.people });
      assert.strictEqual(exec.understood, true);
      assert.strictEqual(exec.value, "2", "두 사람 통화 2건이 모두 합산되어야 함");
    }

    // 빈 태그 차단: 아무도 없는 태그는 ok: false로 차단되어 전체 사람 조회로 새지 않아야 함
    const emptyTagReq: QueryRequest = {
      from: MOCK_BASE_DATE,
      to: MOCK_BASE_DATE,
      timeOfDay: "any",
      kind: "call",
      target: { type: "tag", tag: "없는태그" },
      metric: "count",
    };
    const emptyFilterRes = toFilter(emptyTagReq, ctx);
    assert.strictEqual(emptyFilterRes.ok, false, "멤버 없는 태그는 toFilter에서 차단되어야 함");
  }

  // 신규 3: 장소 정확 일치 비교 ("집" vs "본집", geofence/dong 동명 구분, 인접 두 등록장소 A/B 체류 분리)
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();

    // 1) "집" vs "본집":
    // "집" 30분(1800초), "본집" 60분(3600초)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-home", 1, "LOCATION", "집", t, t + 1800000, 1800, "집 체류", t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-bon-home", 1, "LOCATION", "본집", t + 2000000, t + 5600000, 3600, "본집 체류", t + 2000000]
    );

    const execHomeExact = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [{ source: "geofence", name: "집" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter
    );
    assert.strictEqual(execHomeExact.value, "30분", "'집' 조회 시 '본집'이 부분일치로 포함되지 않고 오직 30분이어야 함");

    // 2) geofence와 dong이 같은 이름일 때 source로 구분
    const t2 = new Date(`${MOCK_BASE_DATE}T15:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-geo-yeoksam", 1, "LOCATION", "역삼동", t2, t2 + 1200000, 1200, "geofence 역삼동", t2]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-dong-yeoksam", 1, "LOCATION", null, 37.5, 127.0, t2 + 1500000, t2 + 3900000, 2400, "dong 역삼동", t2 + 1500000]
    );

    const dongAtYeoksam = (lat: number, lng: number) => (lat === 37.5 ? "역삼동" : null);

    const execGeoYeoksam = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [{ source: "geofence", name: "역삼동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: dongAtYeoksam }
    );
    assert.strictEqual(execGeoYeoksam.value, "20분", "source: geofence는 등록 장소만 20분 집계");

    const execDongYeoksam = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [{ source: "dong", name: "역삼동" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter,
      { dongAt: dongAtYeoksam }
    );
    assert.strictEqual(execDongYeoksam.value, "40분", "source: dong은 행정동만 40분 집계");

    // 3) 인접 두 등록 장소 A(연구소) -> B(도서관) 체류 분리: B 선택 시 B만 나옴
    const t3 = new Date(`${MOCK_BASE_DATE}T18:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-place-a", 1, "LOCATION", "연구소", t3, t3 + 1800000, 1800, "연구소", t3]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-place-b", 1, "LOCATION", "도서관", t3 + 1800000, t3 + 3600000, 1800, "도서관", t3 + 1800000]
    );

    const execPlaceB = await executeNlQuery(
      {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        apps: [],
        places: [{ source: "geofence", name: "도서관" }],
        people: [],
        kinds: ["location"],
        metric: "duration",
      },
      adapter
    );
    assert.strictEqual(execPlaceB.value, "30분", "인접 장소 B는 A로 합쳐지지 않고 도서관 30분이 정확히 조회되어야 함");
  }

  // 신규 3-B: geofence 없는 인접 두 행정동 A동→B동 기록 시 placeRuns 분리 검증 (QB-B-2 #1)
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    const fakeDongAt = (lat: number, _lng: number) => {
      if (lat === 37.1) return "A동";
      if (lat === 37.2) return "B동";
      return null;
    };

    // geofence_name = null인 인접 두 동:
    // A동: 10:00 ~ 10:30 (1800초) 커밋 3개 (10분 간격)
    for (let i = 0; i < 3; i++) {
      const s = t + i * 10 * 60000;
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`c-dong-a-${i}`, 1, "LOCATION", null, 37.1, 127.0, s, s + 10 * 60000, 600, "A동", s]
      );
    }
    // B동: 10:30 ~ 11:10 (2400초) 커밋 4개 (10분 간격)
    for (let i = 0; i < 4; i++) {
      const s = t + 1800000 + i * 10 * 60000;
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [`c-dong-b-${i}`, 1, "LOCATION", null, 37.2, 127.0, s, s + 10 * 60000, 600, "B동", s]
      );
    }

    // 1) dong B 선택 시 -> B 체류만 (duration: 40분, count: 1회, list: B동 1행 40분)
    const execBDur = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "B동" }], people: [], kinds: ["location"], metric: "duration" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execBDur.value, "40분", "B동 duration은 40분이어야 함 (A동 30분이 섞이지 않음)");

    const execBCount = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "B동" }], people: [], kinds: ["location"], metric: "count" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execBCount.value, "1", "B동 방문 횟수는 1회여야 함");

    const execBList = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "B동" }], people: [], kinds: ["location"], metric: "list" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execBList.rows.length, 1, "B동 목록 행은 1개여야 함");
    assert.ok(execBList.rows[0].text.includes("B동") && execBList.rows[0].text.includes("40분"), "B동 목록 행 내용 확인");

    // 2) dong A 선택 시 -> A 체류만 (duration: 30분, count: 1회, list: A동 1행 30분)
    const execADur = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "A동" }], people: [], kinds: ["location"], metric: "duration" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execADur.value, "30분", "A동 duration은 30분이어야 함 (B동 40분이 섞이지 않음)");

    const execACount = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "A동" }], people: [], kinds: ["location"], metric: "count" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execACount.value, "1", "A동 방문 횟수는 1회여야 함");

    const execAList = await executeNlQuery(
      { from: MOCK_BASE_DATE, to: MOCK_BASE_DATE, timeOfDay: "any", apps: [], places: [{ source: "dong", name: "A동" }], people: [], kinds: ["location"], metric: "list" },
      adapter,
      { dongAt: fakeDongAt }
    );
    assert.strictEqual(execAList.rows.length, 1, "A동 목록 행은 1개여야 함");
    assert.ok(execAList.rows[0].text.includes("A동") && execAList.rows[0].text.includes("30분"), "A동 목록 행 내용 확인");
  }

  // 신규 4: lib/queryCandidates.ts loadQueryCandidates 검증
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();

    // 4-1) 앱: APP_USAGE만(system.location 제외), 사용 시간 합계 많은 순
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-yt-1", 1, "APP_USAGE", "com.google.android.youtube", t, t + 3600000, 3600, "yt", t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-chrome", 1, "APP_USAGE", "com.android.chrome", t + 1000, t + 1801000, 1800, "chrome", t + 1000]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["app-loc-sys", 1, "LOCATION", "system.location", t + 2000, t + 7202000, 7200, "loc", t + 2000]
    );

    // 4-2) 같은 번호로 이름이 바뀐 사람은 가장 최근 이름 하나
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-old-name", 1, "CALL", t, t + 60000, 60, "call old", JSON.stringify({ phoneNumber: "01011112222", contactName: "과거이름" }), t]
    );
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["call-new-name", 1, "CALL", t + 500000, t + 560000, 60, "call new", JSON.stringify({ phoneNumber: "01011112222", contactName: "현재이름" }), t + 500000]
    );

    // 4-3) 답장 후보: msg: 키만
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["reply-msg", 1, "REPLY", "com.kakao.talk", t, t, 0, "reply", JSON.stringify({ sender: "민수", packageName: "com.kakao.talk" }), t]
    );

    // 4-4) 장소 커밋
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, geofence_name, lat, lng, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["loc-visited", 1, "LOCATION", "연구소", 36.35, 127.38, t, t + 3600000, 3600, "visited", t]
    );

    const candidates = await loadQueryCandidates(adapter, {
      geofences: [{ name: "연구소" }, { name: "미방문장소" }],
      tags: [
        { contact_name: "현재이름", tag: "#동료" },
        { contact_name: "기록없는사람", tag: "#가족" },
      ],
      dongAt: (lat, _lng) => (lat === 36.35 ? "둔산동" : null),
      appLabel: (pkg) => (pkg === "com.google.android.youtube" ? "유튜브" : pkg === "com.android.chrome" ? "크롬" : pkg),
    });

    // 앱: system.location 제외, 유튜브(3600s) -> 크롬(1800s) 순서
    assert.strictEqual(candidates.apps.length, 2, "앱 후보에 system.location이 포함되면 안 됨");
    assert.strictEqual(candidates.apps[0].pkg, "com.google.android.youtube");
    assert.strictEqual(candidates.apps[0].label, "유튜브");
    assert.strictEqual(candidates.apps[1].pkg, "com.android.chrome");

    // 사람: 같은 번호(01011112222)의 이름은 최근 이름인 '현재이름' 하나만
    const callPeople = candidates.call.filter((p) => p.key === "tel:01011112222");
    assert.strictEqual(callPeople.length, 1, "같은 번호는 하나로 합쳐져야 함");
    assert.strictEqual(callPeople[0].name, "현재이름", "최근 저장 이름이 반영되어야 함");

    // 답장 사람: msg: 키만
    assert.ok(candidates.reply.every((p) => p.key.startsWith("msg:")));
    assert.strictEqual(candidates.reply[0].key, "msg:com.kakao.talk:민수");

    // 태그: 기록이 있는 사람의 태그 '#동료'만 포함되고 '기록없는사람'의 '#가족'은 미포함
    assert.ok(candidates.callTags.some((t) => t.tag === "#동료" || t.tag === "동료"), "동료 태그 포함");
    assert.ok(!candidates.callTags.some((t) => t.tag === "#가족" || t.tag === "가족"), "기록 없는 사람만 속한 태그는 제외");

    // 장소: 방문 기록 있는 '연구소'가 visited=true로 먼저, 미방문장소는 visited=false
    const visitedPlace = candidates.places.find((p) => p.name === "연구소");
    const unvisitedPlace = candidates.places.find((p) => p.name === "미방문장소");
    assert.strictEqual(visitedPlace?.visited, true);
    assert.strictEqual(unvisitedPlace?.visited, false);
    assert.ok(candidates.places.indexOf(visitedPlace!) < candidates.places.indexOf(unvisitedPlace!));
    // dongAt 행정동 포함
    assert.ok(candidates.places.some((p) => p.source === "dong" && p.name === "둔산동"));
  }

  // -------------------------------------------------------------
  // QB-B-3 추가 검증 (74차 반려 대응)
  // -------------------------------------------------------------

  // 15.1) CALL/SMS 사람 정보 결합:
  // 같은 번호에 오늘 CALL(NewName/#NewTag)+어제 SMS(OldName/#OldTag), 그리고 반대 순서
  // 통화 후보 태그 선택이 실제로 실행되고(거절 없음) 라벨이 최신 이름
  {
    // 케이스 A: 오늘 CALL(NewName/#NewTag) + 어제 SMS(OldName/#OldTag)
    {
      const { adapter } = await openInitialised();
      const yesterday = shiftDate(MOCK_BASE_DATE, -1);
      const tYesterday = new Date(`${yesterday}T15:00:00`).getTime();
      const tToday = new Date(`${MOCK_BASE_DATE}T15:00:00`).getTime();

      // 어제 SMS (OldName)
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["c-sms-old", 1, "SMS", tYesterday, tYesterday, 0, "sms", JSON.stringify({ phoneNumber: "01011112222", contactName: "OldName" }), tYesterday]
      );
      // 오늘 CALL (NewName)
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["c-call-new", 1, "CALL", tToday, tToday + 60000, 60, "call", JSON.stringify({ phoneNumber: "01011112222", contactName: "NewName" }), tToday]
      );

      const tags = [
        { contact_name: "NewName", tag: "#NewTag" },
        { contact_name: "OldName", tag: "#OldTag" },
      ];

      const candidates = await loadQueryCandidates(adapter, { geofences: [], tags });
      const callPerson = candidates.call.find((p) => p.key === "tel:01011112222");
      assert.ok(callPerson, "통화 후보에 포함되어야 함");
      assert.strictEqual(callPerson.name, "NewName", "오늘 CALL 이름인 NewName이어야 함");
      assert.strictEqual(callPerson.label, "NewName", "라벨도 최신 이름이어야 함");
      assert.strictEqual(callPerson.tag, "#NewTag", "최신 이름의 태그인 #NewTag여야 함");
      assert.ok(candidates.callTags.some((t) => t.tag === "#NewTag"), "통화 태그 후보에 #NewTag가 있어야 함");

      // 통화 후보 태그(#NewTag) 선택 시 실제로 실행되고(거절 없음)
      const filterRes = toFilter(
        {
          from: MOCK_BASE_DATE,
          to: MOCK_BASE_DATE,
          timeOfDay: "any",
          kind: "call",
          target: { type: "tag", tag: "#NewTag" },
          metric: "count",
        },
        { people: candidates.people }
      );
      assert.strictEqual(filterRes.ok, true, "toFilter 성공해야 함");
      if (filterRes.ok) {
        const exec = await executeNlQuery(filterRes.value, adapter, { people: candidates.people });
        assert.strictEqual(exec.understood, true, "거절 없이 실행되어야 함");
        assert.strictEqual(exec.value, "1", "오늘 CALL 1건이 정상 조회되어야 함");
      }
    }

    // 케이스 B: 반대 순서 - 어제 CALL(OldName/#OldTag) + 오늘 SMS(NewName/#NewTag)
    {
      const { adapter } = await openInitialised();
      const yesterday = shiftDate(MOCK_BASE_DATE, -1);
      const tYesterday = new Date(`${yesterday}T15:00:00`).getTime();
      const tToday = new Date(`${MOCK_BASE_DATE}T15:00:00`).getTime();

      // 어제 CALL (OldName)
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["c-call-old", 1, "CALL", tYesterday, tYesterday + 60000, 60, "call", JSON.stringify({ phoneNumber: "01011112222", contactName: "OldName" }), tYesterday]
      );
      // 오늘 SMS (NewName)
      await adapter.run(
        "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ["c-sms-new", 1, "SMS", tToday, tToday, 0, "sms", JSON.stringify({ phoneNumber: "01011112222", contactName: "NewName" }), tToday]
      );

      const tags = [
        { contact_name: "NewName", tag: "#NewTag" },
        { contact_name: "OldName", tag: "#OldTag" },
      ];

      const candidates = await loadQueryCandidates(adapter, { geofences: [], tags });
      const callPerson = candidates.call.find((p) => p.key === "tel:01011112222");
      assert.ok(callPerson, "통화 후보에 포함되어야 함");
      assert.strictEqual(callPerson.name, "NewName", "오늘 SMS 최신 이름인 NewName으로 결합되어야 함");
      assert.strictEqual(callPerson.label, "NewName", "라벨도 최신 이름이어야 함");
      assert.strictEqual(callPerson.tag, "#NewTag", "최신 이름 기준 #NewTag여야 함");
      assert.strictEqual(callPerson.lastAt, tYesterday, "CALL의 최신 활동 시각은 어제 시각이어야 함 (최신 이름 시각과 구분)");
      assert.ok(candidates.callTags.some((t) => t.tag === "#NewTag"), "통화 태그 후보에 #NewTag가 있어야 함");

      // 어제 통화 기록을 #NewTag로 조회 시 거절 없이 실행
      const filterRes = toFilter(
        {
          from: yesterday,
          to: yesterday,
          timeOfDay: "any",
          kind: "call",
          target: { type: "tag", tag: "#NewTag" },
          metric: "count",
        },
        { people: candidates.people }
      );
      assert.strictEqual(filterRes.ok, true, "toFilter 성공해야 함");
      if (filterRes.ok) {
        const exec = await executeNlQuery(filterRes.value, adapter, { people: candidates.people });
        assert.strictEqual(exec.understood, true, "거절 없이 실행되어야 함");
        assert.strictEqual(exec.value, "1", "어제 통화 1건 정상 집계");
      }
    }
  }

  // 15.2) 태그 규칙을 buildPeople과 같게: 번호 일치 먼저, 번호 미매칭 때만 번호 없는 행(name: 키) 태그 fallback
  // NewName→#NameTag(번호 없음), OtherName/같은 번호→#PhoneTag일 때 PhoneTag가 우선 매칭됨
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T12:00:00`).getTime();
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-call-tag-rule", 1, "CALL", t, t + 60000, 60, "call", JSON.stringify({ phoneNumber: "01033334444", contactName: "NewName" }), t]
    );

    const tags = [
      { contact_name: "NewName", tag: "#NameTag" },
      { contact_name: "OtherName", phone_number: "01033334444", tag: "#PhoneTag" },
    ];

    const candidates = await loadQueryCandidates(adapter, { geofences: [], tags });
    const p = candidates.call.find((x) => x.key === "tel:01033334444");
    assert.ok(p, "통화 후보에 존재");
    assert.strictEqual(p.tag, "#PhoneTag", "번호로 찾은 태그가 우선하므로 #PhoneTag여야 함");
    assert.deepStrictEqual(p.tags, ["#PhoneTag"], "PhoneTag가 부여되어야 함");

    // PhoneTag 후보에 해당 통화가 매칭되어 callTags에 존재해야 함
    const phoneTagCandidate = candidates.callTags.find((t) => t.tag === "#PhoneTag");
    assert.ok(phoneTagCandidate, "PhoneTag에는 01033334444가 속하므로 callTags에 있어야 함");

    // NameTag는 번호 일치로 인해 매칭되지 않으므로 callTags에 없어야 함
    const nameTagCandidate = candidates.callTags.find((t) => t.tag === "#NameTag");
    assert.strictEqual(nameTagCandidate, undefined, "NameTag에는 번호 일치 우선으로 인해 속하지 않아야 함");

    // NameTag로 toFilter 실행 시 빈 집합 차단
    const req: QueryRequest = {
      from: MOCK_BASE_DATE,
      to: MOCK_BASE_DATE,
      timeOfDay: "any",
      kind: "call",
      target: { type: "tag", tag: "#NameTag" },
      metric: "count",
    };
    const filterRes = toFilter(req, { people: candidates.people });
    assert.strictEqual(filterRes.ok, false, "NameTag에 사람이 없으므로 toFilter 차단되어야 함");
  }

  // 15.3) 태그 변경 알림: add/update/delete 쓰기 성공 뒤 emit(EVENT_COMMITS_UPDATED), 실패 시 0회, 삭제된 태그 toFilter 차단
  {
    let eventCount = 0;
    const unsub = subscribe(EVENT_COMMITS_UPDATED, () => {
      eventCount++;
    });

    // node:sqlite mock 연결 생성
    let failMode = false;
    const mockDb = {
      isTransactionActive: async () => ({ result: false }),
      beginTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      run: async (_sql: string, _params: any[]) => {
        if (failMode) throw new Error("Mock DB Write Error");
        return { changes: { changes: 1, lastId: 1 } };
      },
      query: async () => ({ values: [] }),
    };

    __setDBForTest(mockDb);

    try {
      // 1) addContactTag 성공 -> 이벤트 1회
      eventCount = 0;
      await addContactTag("홍길동", "#친구", "01011112222");
      assert.strictEqual(eventCount, 1, "addContactTag 성공 시 EVENT_COMMITS_UPDATED 1회 발행");

      // 2) updateContactTag 성공 -> 이벤트 1회
      eventCount = 0;
      await updateContactTag(1, "홍길동", "#단짝", "01011112222");
      assert.strictEqual(eventCount, 1, "updateContactTag 성공 시 EVENT_COMMITS_UPDATED 1회 발행");

      // 3) deleteContactTag 성공 -> 이벤트 1회
      eventCount = 0;
      await deleteContactTag(1);
      assert.strictEqual(eventCount, 1, "deleteContactTag 성공 시 EVENT_COMMITS_UPDATED 1회 발행");

      // 4) 실패 시 -> 이벤트 0회 발행
      failMode = true;
      eventCount = 0;
      await assert.rejects(
        async () => {
          await deleteContactTag(99);
        },
        /Mock DB Write Error/,
        "실패 시 에러 throw"
      );
      assert.strictEqual(eventCount, 0, "실패 시에는 EVENT_COMMITS_UPDATED가 발행되지 않아야 함");

      // 5) 삭제된 태그로 toFilter -> 차단 검증
      const req: QueryRequest = {
        from: MOCK_BASE_DATE,
        to: MOCK_BASE_DATE,
        timeOfDay: "any",
        kind: "call",
        target: { type: "tag", tag: "#단짝" },
        metric: "count",
      };
      // people에 단짝 태그가 없음
      const filterRes = toFilter(req, { people: [{ key: "tel:01011112222", name: "홍길동", tag: null, tags: [], saved: true }] });
      assert.strictEqual(filterRes.ok, false, "삭제된 태그로 toFilter 호출 시 차단되어야 함");
      if (!filterRes.ok) {
        assert.ok(filterRes.reason.includes("태그가 붙은 사람이 없어"), "사유에 태그 사람 없음 포함");
      }
    } finally {
      __setDBForTest(null);
      unsub();
    }
  }

  // 15.4) 시간대 표기 = 실행 범위 검증: 표기 문자열이 getTimeWindow 경계와 같음
  {
    const tods: Exclude<NlTimeOfDay, "any">[] = ["morning", "lunch", "afternoon", "evening", "night"];
    for (const tod of tods) {
      const bound = TIME_OF_DAY_BOUNDS[tod];
      const w = getTimeWindow("2026-10-14", tod);
      const dStart = new Date(w.start);
      const dEnd = new Date(w.end + 1); // end는 millisecond 기준 -1이므로 +1이 정각

      assert.strictEqual(dStart.getHours(), bound.startHour, `${tod} 시작 시간 일치`);
      assert.strictEqual(dEnd.getHours(), bound.endHour, `${tod} 종료 시간 일치`);

      const label = TIME_OF_DAY_UI_LABELS[tod];
      const match = label.match(/\((\d{2})~(\d{2})\)/);
      assert.ok(match, `${tod} 라벨에 (시작~종료) 포맷이 있어야 함`);
      const startH = parseInt(match[1], 10);
      const endH = parseInt(match[2], 10);
      assert.strictEqual(startH, bound.startHour, `${tod} 표기 시작 시간과 경계 일치`);
      assert.strictEqual(endH, bound.endHour, `${tod} 표기 종료 시간과 경계 일치`);
    }

    // 12:30이 afternoon(12~18)에 포함되고 morning(06~12)에 미포함됨을 검증
    const t1230 = new Date("2026-10-14T12:30:00").getTime();
    const afternoonW = getTimeWindow("2026-10-14", "afternoon");
    const morningW = getTimeWindow("2026-10-14", "morning");
    assert.ok(t1230 >= afternoonW.start && t1230 <= afternoonW.end, "12:30은 afternoon 창에 포함되어야 함");
    assert.ok(t1230 > morningW.end, "12:30은 morning 창 밖이어야 함");
  }

  // 15.5) 잘못된 JSON 본문: CALL body plain text 한 행이 있어도 앱·통화 후보 정상 로딩
  {
    const { adapter } = await openInitialised();
    const t = new Date(`${MOCK_BASE_DATE}T10:00:00`).getTime();
    // 정상 APP
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, app_package, started_at, ended_at, duration_sec, subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-good-app", 1, "APP_USAGE", "com.android.chrome", t, t + 300, 300, "chrome", t]
    );
    // 잘못된 JSON 본문을 가진 CALL (plain text)
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-bad-json-call", 1, "CALL", t + 1000, t + 1060, 60, "call bad", "plain text body not valid json", t + 1000]
    );
    // 정상 CALL
    await adapter.run(
      "INSERT INTO commits (id, branch_id, event_type, started_at, ended_at, duration_sec, subject, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ["c-good-call", 1, "CALL", t + 2000, t + 2060, 60, "call good", JSON.stringify({ phoneNumber: "01099998888", contactName: "정상통화" }), t + 2000]
    );

    // loadQueryCandidates가 json_extract 오류로 터지지 않고 정상 로딩되는지 확인
    const candidates = await loadQueryCandidates(adapter, { geofences: [], tags: [] });
    assert.strictEqual(candidates.apps.length, 1, "정상 앱 후보가 1개 로드되어야 함");
    assert.strictEqual(candidates.apps[0].pkg, "com.android.chrome");
    assert.strictEqual(candidates.call.length, 1, "정상 통화 후보가 1개 로드되어야 함 (손상된 행은 제외)");
    assert.strictEqual(candidates.call[0].name, "정상통화");
  }

  console.log("=== 모든 검증(nlsearch.check.ts) 통과! ===");
}

runAllChecks().catch((err) => {
  console.error("nlsearch.check.ts 실행 실패:", err);
  process.exit(1);
});
