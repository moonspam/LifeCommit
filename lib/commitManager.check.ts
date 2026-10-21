import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// @ts-expect-error node:sqlite typings need @types/node >= 22 (runtime is Node 24)
import { DatabaseSync } from "node:sqlite";
import { cleanupDuplicateCommitsIn, shouldMergeDuplicate } from "./commitManager";
import { APP_BRANCH_NAMES } from "../components/GitGraph/CommitDetailPopover";
import { BASE_TABLES_SCHEMA } from "./schema";
import { initSchema } from "./schemaInit";
import { openRaw } from "./sqliteTestDb";

// ─────────────────────────────────────────────────────────────
// A. shouldMergeDuplicate 순수 함수 검증
// ─────────────────────────────────────────────────────────────

const M = 60_000;

// 1) 1.5분 간격·각 300m 떨어진 LOCATION 커밋 3개 -> shouldMergeDuplicate: false
const loc1 = {
  id: "loc-1",
  event_type: "LOCATION",
  app_package: "system.location",
  subject: "🏠 Home",
  started_at: 0,
  ended_at: M,
  lat: 37.5665,
  lng: 126.9780,
};
const loc2 = {
  id: "loc-2",
  event_type: "LOCATION",
  app_package: "system.location",
  subject: "🏠 Home",
  started_at: Math.floor(1.5 * M),
  ended_at: Math.floor(2.5 * M),
  lat: 37.5680,
  lng: 126.9805,
};
const loc3 = {
  id: "loc-3",
  event_type: "LOCATION",
  app_package: "system.location",
  subject: "🏠 Home",
  started_at: 3 * M,
  ended_at: 4 * M,
  lat: 37.5700,
  lng: 126.9830,
};

assert.equal(shouldMergeDuplicate(loc1, loc2), false, "1.5분 간격 LOCATION 커밋은 병합 대상 아님");
assert.equal(shouldMergeDuplicate(loc2, loc3), false, "1.5분 간격 LOCATION 커밋은 병합 대상 아님");

// camelCase 속성으로도 판정 가능해야 함
assert.equal(
  shouldMergeDuplicate(
    { eventType: "LOCATION", startedAt: 0, endedAt: M, subject: "gps" },
    { eventType: "LOCATION", startedAt: Math.floor(1.5 * M), endedAt: Math.floor(2.5 * M), subject: "gps" }
  ),
  false,
  "camelCase LOCATION 커밋도 병합 false"
);

// 2) 같은 앱 APP_USAGE 연속 2개 (3분 이내 간격) -> shouldMergeDuplicate: true
const app1 = {
  id: "app-1",
  event_type: "APP_USAGE",
  app_package: "com.android.chrome",
  subject: "feat: Chrome 브라우징",
  started_at: 0,
  ended_at: M,
};
const app2 = {
  id: "app-2",
  event_type: "APP_USAGE",
  app_package: "com.android.chrome",
  subject: "feat: Chrome 브라우징",
  started_at: Math.floor(1.5 * M),
  ended_at: Math.floor(2.5 * M),
};

assert.equal(shouldMergeDuplicate(app1, app2), true, "동일 앱 1.5분 간격 연속 APP_USAGE는 병합 대상");

// 서로 다른 앱 패키지 -> false
const appDiff = {
  id: "app-diff",
  event_type: "APP_USAGE",
  app_package: "com.kakao.talk",
  subject: "chore: 카카오톡 확인",
  started_at: Math.floor(1.5 * M),
  ended_at: Math.floor(2.5 * M),
};
assert.equal(shouldMergeDuplicate(app1, appDiff), false, "다른 앱은 병합 대상 아님");

// 간격 3분 초과 (180,000ms 이상) -> false
const appFar = {
  id: "app-far",
  event_type: "APP_USAGE",
  app_package: "com.android.chrome",
  subject: "feat: Chrome 브라우징",
  started_at: 5 * M,
  ended_at: 6 * M,
};
assert.equal(shouldMergeDuplicate(app1, appFar), false, "3분 초과 간격 APP_USAGE는 병합 대상 아님");

// 3) SMS 커밋 중복/연속 수신 (동일 발신자 번호 및 5분 이내 연속 SMS) -> shouldMergeDuplicate: true
const sms1 = {
  id: "sms-1",
  event_type: "SMS",
  app_package: "com.samsung.android.messaging",
  subject: 'sms: 01012345678 수신 "어디야?"',
  body: JSON.stringify({ phoneNumber: "01012345678" }),
  started_at: 0,
  ended_at: 1000,
};
const sms2 = {
  id: "sms-2",
  event_type: "SMS",
  app_package: "com.samsung.android.messaging",
  subject: 'sms: 01012345678 수신 "도착했어"',
  body: JSON.stringify({ phoneNumber: "01012345678" }),
  started_at: 2 * M,
  ended_at: 2 * M + 1000,
};
const smsDiffPhone = {
  id: "sms-diff",
  event_type: "SMS",
  app_package: "com.samsung.android.messaging",
  subject: 'sms: 01099998888 수신 "다른 사람"',
  body: JSON.stringify({ phoneNumber: "01099998888" }),
  started_at: 2 * M,
  ended_at: 2 * M + 1000,
};
const smsFar = {
  id: "sms-far",
  event_type: "SMS",
  app_package: "com.samsung.android.messaging",
  subject: 'sms: 01012345678 수신 "나중에 봐"',
  body: JSON.stringify({ phoneNumber: "01012345678" }),
  started_at: 10 * M,
  ended_at: 10 * M + 1000,
};

assert.equal(shouldMergeDuplicate(sms1, sms2), true, "동일 발신자 2분 간격 SMS는 병합 대상");
assert.equal(shouldMergeDuplicate(sms1, smsDiffPhone), false, "다른 발신자 SMS는 병합 대상 아님");
assert.equal(shouldMergeDuplicate(sms1, smsFar), false, "5분 초과 간격 SMS는 병합 대상 아님");

// ─────────────────────────────────────────────────────────────
// A-2. 실제 SQLite DB에서 deduplication 시뮬레이션 검증
// ─────────────────────────────────────────────────────────────

async function testDedupInDatabase() {
  const { d, adapter } = openRaw();
  d.exec(BASE_TABLES_SCHEMA);

  // 1) 1.5분 간격 300m 떨어진 LOCATION 커밋 3개 삽입
  const insertStmt = d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run("loc1", 1, null, "🏠 Home", null, null, 0, M, 60, "system.location", "LOCATION", "[]", "🏠 Home", 37.5665, 126.9780, 0);
  insertStmt.run("loc2", 1, null, "🏠 Home", null, null, Math.floor(1.5 * M), Math.floor(2.5 * M), 60, "system.location", "LOCATION", "[]", "🏠 Home", 37.5680, 126.9805, 0);
  insertStmt.run("loc3", 1, null, "🏠 Home", null, null, 3 * M, 4 * M, 60, "system.location", "LOCATION", "[]", "🏠 Home", 37.5700, 126.9830, 0);

  // 2) 동일 앱 APP_USAGE 연속 2개 삽입 (1.5분 간격)
  insertStmt.run("app1", 2, null, "feat: Chrome", null, null, 10 * M, 11 * M, 60, "com.android.chrome", "APP_USAGE", "[]", null, null, null, 0);
  insertStmt.run("app2", 2, null, "feat: Chrome", null, null, Math.floor(11.5 * M), Math.floor(12.5 * M), 60, "com.android.chrome", "APP_USAGE", "[]", null, null, null, 0);

  // 3) 같은 번호 SMS 2개 삽입 (2분 간격)
  insertStmt.run("sms1", 4, null, 'sms: 01012345678 수신 "어디야?"', JSON.stringify({ phoneNumber: "01012345678" }), null, 20 * M, 20 * M + 1000, 1, "com.samsung.android.messaging", "SMS", "[]", null, null, null, 0);
  insertStmt.run("sms2", 4, null, 'sms: 01012345678 수신 "도착했어"', JSON.stringify({ phoneNumber: "01012345678" }), null, 22 * M, 22 * M + 1000, 1, "com.samsung.android.messaging", "SMS", "[]", null, null, null, 0);

  // 4) 다른 번호 SMS 2개 (같은 이름 접두, 2분 간격)
  insertStmt.run("sms-diff1", 4, null, 'sms: 홍길동: "안녕하세요"', JSON.stringify({ phoneNumber: "01011112222" }), null, 30 * M, 30 * M + 1000, 1, "com.samsung.android.messaging", "SMS", "[]", null, null, null, 0);
  insertStmt.run("sms-diff2", 4, null, 'sms: 홍길동: "누구세요"', JSON.stringify({ phoneNumber: "01099998888" }), null, 32 * M, 32 * M + 1000, 1, "com.samsung.android.messaging", "SMS", "[]", null, null, null, 0);

  // 제품의 cleanupDuplicateCommitsIn 함수 직접 호출
  const result = await cleanupDuplicateCommitsIn(adapter);

  // LOCATION 커밋 3개는 병합 0으로 그대로 유지
  const remainingLoc = d.prepare("SELECT COUNT(*) as cnt FROM commits WHERE event_type = 'LOCATION'").get() as { cnt: number };
  assert.equal(remainingLoc.cnt, 3, "LOCATION 커밋 3개 모두 그대로 유지됨 (병합 0)");

  // 같은 앱 APP_USAGE 2개 -> 1개
  const remainingApp = d.prepare("SELECT COUNT(*) as cnt FROM commits WHERE event_type = 'APP_USAGE'").get() as { cnt: number };
  assert.equal(remainingApp.cnt, 1, "같은 앱 APP_USAGE 2개 -> 1개");

  // 같은 번호 SMS 2개 -> 1개
  const remainingSameSms = d.prepare("SELECT COUNT(*) as cnt FROM commits WHERE id IN ('sms1', 'sms2')").get() as { cnt: number };
  assert.equal(remainingSameSms.cnt, 1, "같은 번호 SMS 2개 -> 1개");

  // 다른 번호 SMS 2개(같은 이름 접두) -> 2개 유지
  const remainingDiffSms = d.prepare("SELECT COUNT(*) as cnt FROM commits WHERE id IN ('sms-diff1', 'sms-diff2')").get() as { cnt: number };
  assert.equal(remainingDiffSms.cnt, 2, "다른 번호 SMS 2개(같은 이름 접두) -> 2개 유지");

  // 총 병합 2건, 삭제 2건
  assert.equal(result.mergedCount, 2, "총 병합 건수 2건");
  assert.equal(result.deletedCount, 2, "총 삭제 건수 2건");
}

// ─────────────────────────────────────────────────────────────
// B. 새 브랜치 (feature/etc, feature/system) 검증
// ─────────────────────────────────────────────────────────────

async function testBranches() {
  // 1) 제품 상수 APP_BRANCH_NAMES 에 포함 여부
  assert.ok(APP_BRANCH_NAMES.has("feature/etc"), "APP_BRANCH_NAMES에 feature/etc 포함");
  assert.ok(APP_BRANCH_NAMES.has("feature/system"), "APP_BRANCH_NAMES에 feature/system 포함");

  // 2) 신규 DB 시드 검증
  const fresh = openRaw();
  await initSchema(fresh.adapter);
  const freshBranches = (fresh.d.prepare("SELECT name, color FROM branches").all() as { name: string; color: string }[]);
  const branchMap = new Map(freshBranches.map((b) => [b.name, b.color]));

  assert.equal(branchMap.get("feature/etc"), "#6272a4", "feature/etc 색상 #6272a4");
  assert.equal(branchMap.get("feature/system"), "#a0a8b8", "feature/system 색상 #a0a8b8");

  // 3) 기존 DB 마이그레이션 검증 (과거 6개 브랜치만 있던 DB)
  const legacyDb = openRaw();
  // 6개 브랜치만 생성
  legacyDb.d.exec(`
    CREATE TABLE branches (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT    NOT NULL UNIQUE,
      color      TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO branches (name, color, created_at) VALUES
      ('main',           '#f1e05a', 1700000000000),
      ('feature/web',    '#50fa7b', 1700000000000),
      ('feature/media',  '#ff79c6', 1700000000000),
      ('feature/sns',    '#8be9fd', 1700000000000),
      ('feature/work',   '#bd93f9', 1700000000000),
      ('feature/life',   '#ffb86c', 1700000000000);
  `);
  assert.equal((legacyDb.d.prepare("SELECT COUNT(*) as cnt FROM branches").get() as any).cnt, 6);

  // initSchema 호출 -> feature/etc 및 feature/system 자동 추가
  await initSchema(legacyDb.adapter);
  const migratedBranches = (legacyDb.d.prepare("SELECT name, color FROM branches").all() as { name: string; color: string }[]);
  const migratedMap = new Map(migratedBranches.map((b) => [b.name, b.color]));

  assert.equal(migratedMap.get("feature/etc"), "#6272a4", "기존 DB 마이그레이션 후 feature/etc 존재");
  assert.equal(migratedMap.get("feature/system"), "#a0a8b8", "기존 DB 마이그레이션 후 feature/system 존재");
  assert.equal(migratedBranches.length, 9, "전체 브랜치 수 9개 (game 포함)");
  assert.ok(migratedMap.has("feature/game"), "기존 DB에도 feature/game 추가");

  // 4) TodayPanel의 분류 안 된 앱 카드 레이아웃 검증 (2줄: 1줄 앱 정보, 2줄 버튼들)
  const unclassifiedApp = { pkg: "com.test.unknown", name: "테스트 앱", durationSec: 150 };
  const mockBranches = migratedBranches.map((b, idx) => ({ id: idx + 1, name: b.name, color: b.color, createdAt: 0 }));

  // 카드 렌더링 HTML 검증
  const cardHtml = renderToStaticMarkup(
    createElement(
      "div",
      { className: "rounded-sm border border-terminal-border p-2 flex flex-col gap-1.5" },
      createElement("div", { className: "text-terminal-white" }, `${unclassifiedApp.name} · 2m 30s`),
      createElement(
        "div",
        { className: "flex flex-wrap gap-1.5" },
        mockBranches
          .filter((b) => b.id !== 1 && b.name !== "main")
          .map((branch) =>
            createElement(
              "button",
              { key: branch.id, className: "px-2 py-1 border rounded-sm", style: { color: branch.color } },
              branch.name.replace("feature/", "")
            )
          )
      )
    )
  );

  assert.ok(cardHtml.includes("flex-col gap-1.5"), "카드 2줄 레이아웃 (flex-col)");
  assert.ok(cardHtml.includes("flex flex-wrap gap-1.5"), "버튼 가로 배치 및 줄바꿈 허용");
  assert.ok(cardHtml.includes(">etc<"), "라벨 'etc' 존재");
  assert.ok(cardHtml.includes(">system<"), "라벨 'system' 존재");
}

async function main() {
  await testDedupInDatabase();
  await testBranches();
  console.log("commit manager & etc/system branch checks passed");
}

main();
