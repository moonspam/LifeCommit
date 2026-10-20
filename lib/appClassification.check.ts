import assert from "node:assert/strict";
import {
  groupAndSortAppClassifications,
  getAppClassifications,
  getBranchOrderIndex,
  getBranchDisplayName,
  AppClassificationItem,
} from "./queries";
import { BASE_TABLES_SCHEMA } from "./schema";
import { openRaw } from "./sqliteTestDb";
import { NOISE_PACKAGES } from "./constants";

console.log("=== [1] App Classification Pure Function Tests ===");

// 1. 희소 브랜치 ID (493, 494 등)에서도 브랜치 이름 순서대로 정렬되는지 검증
// 순서: main (미분류) -> web -> media -> sns -> work -> life -> etc -> system -> 기타 브랜치
const sparseBranches = [
  { id: 493, name: "feature/system", color: "#a0a8b8" },
  { id: 10, name: "feature/media", color: "#ff79c6" },
  { id: 1, name: "main", color: "#f1e05a" },
  { id: 494, name: "feature/custom-z", color: "#ffffff" },
  { id: 25, name: "feature/web", color: "#50fa7b" },
  { id: 30, name: "feature/custom-a", color: "#000000" },
];

const mockApps: AppClassificationItem[] = [
  {
    pkg: "com.custom.z",
    name: "Custom Z App",
    totalDurationSec: 100,
    branchId: 494,
    branchName: "feature/custom-z",
    branchColor: "#ffffff",
  },
  {
    pkg: "com.android.settings",
    name: "설정",
    totalDurationSec: 300,
    branchId: 493,
    branchName: "feature/system",
    branchColor: "#a0a8b8",
  },
  {
    pkg: "com.android.chrome",
    name: "Chrome",
    totalDurationSec: 1500,
    branchId: 25,
    branchName: "feature/web",
    branchColor: "#50fa7b",
  },
  {
    pkg: "com.sec.browser",
    name: "Samsung Internet",
    totalDurationSec: 500,
    branchId: 25,
    branchName: "feature/web",
    branchColor: "#50fa7b",
  },
  {
    pkg: "com.google.android.youtube",
    name: "YouTube",
    totalDurationSec: 2000,
    branchId: 10,
    branchName: "feature/media",
    branchColor: "#ff79c6",
  },
  {
    pkg: "com.unknown.app1",
    name: "Unclassified App 1",
    totalDurationSec: 200,
    branchId: 1,
    branchName: "main",
    branchColor: "#f1e05a",
  },
  {
    pkg: "com.unknown.app2",
    name: "Unclassified App 2",
    totalDurationSec: 800,
    branchId: 1,
    branchName: "main",
    branchColor: "#f1e05a",
  },
  {
    pkg: "com.custom.a",
    name: "Custom A App",
    totalDurationSec: 50,
    branchId: 30,
    branchName: "feature/custom-a",
    branchColor: "#000000",
  },
];

const groups = groupAndSortAppClassifications(mockApps, sparseBranches, "");

// 그룹 순서 검증: main -> web -> media -> system -> custom-a -> custom-z
const groupNames = groups.map((g) => g.branchName);
assert.deepEqual(
  groupNames,
  [
    "main",
    "feature/web",
    "feature/media",
    "feature/system",
    "feature/custom-a",
    "feature/custom-z",
  ],
  "그룹은 main -> web -> media ... 순서(브랜치 ID가 아닌 이름 순)로 정렬되어야 함"
);

// 그룹 내부 사용시간 내림차순 정렬 검증
const mainGroup = groups.find((g) => g.branchName === "main")!;
assert.equal(mainGroup.apps[0].pkg, "com.unknown.app2", "사용시간이 큰 앱이 앞에 와야 함 (800s > 200s)");
assert.equal(mainGroup.apps[1].pkg, "com.unknown.app1");

const webGroup = groups.find((g) => g.branchName === "feature/web")!;
assert.equal(webGroup.apps[0].pkg, "com.android.chrome", "1500s > 500s");
assert.equal(webGroup.apps[1].pkg, "com.sec.browser");

// 표시 이름 검증
assert.equal(getBranchDisplayName("main"), "미분류");
assert.equal(getBranchDisplayName("feature/web"), "web");
assert.equal(getBranchDisplayName("feature/custom-a"), "custom-a");

// 검색 필터 검증 (대소문자 무시, 앱 이름 / 패키지 부분 일치)
const searchByName = groupAndSortAppClassifications(mockApps, sparseBranches, "YOUTUBE");
assert.equal(searchByName.length, 1);
assert.equal(searchByName[0].apps.length, 1);
assert.equal(searchByName[0].apps[0].pkg, "com.google.android.youtube");

const searchByPkg = groupAndSortAppClassifications(mockApps, sparseBranches, "sec.browser");
assert.equal(searchByPkg.length, 1);
assert.equal(searchByPkg[0].apps[0].name, "Samsung Internet");

const searchNone = groupAndSortAppClassifications(mockApps, sparseBranches, "nonexistent_query_xyz");
assert.equal(searchNone.length, 0);

console.log("✓ Pure function groupAndSortAppClassifications tests passed");

// ─────────────────────────────────────────────────────────────
// [2] getAppClassifications 비동기 조회 함수 (sqliteTestDb) 검증
// ─────────────────────────────────────────────────────────────
console.log("=== [2] getAppClassifications DB Query Tests ===");

async function testDatabaseQuery() {
  const { d, adapter } = openRaw();
  d.exec(BASE_TABLES_SCHEMA);

  const noisePkg = Array.from(NOISE_PACKAGES)[0] || "com.sec.android.app.launcher";
  const now = 1700000000000;

  // commits 데이터 준비:
  // 1. 노이즈 패키지 (APP_USAGE) -> 제외되어야 함
  // 2. 비-APP_USAGE 커밋 (LOCATION) -> 제외되어야 함
  // 3. 앱 1: com.google.android.youtube (2건: 100초 + 200초 = 300초, branch_id: 3 feature/media)
  // 4. 앱 2: com.kakao.talk (1건: 500초, branch_id: 1 main)
  //    -> 단, app_branch_overrides에 branch_id 4(feature/sns) 지정되어 있음 -> override 반영 확인
  // 5. 앱 3: com.unknown.game (1건: 50초, branch_id: 1 main) -> override 없음

  const insertCommit = d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, ?)
  `);

  // 노이즈 앱
  insertCommit.run("c-noise", 1, "noise app", now - 10000, now - 9000, 1000, noisePkg, "APP_USAGE", now);

  // 비-APP_USAGE 커밋
  insertCommit.run("c-loc", 1, "location", now - 8000, now - 7000, 1000, "com.google.android.youtube", "LOCATION", now);

  // YouTube APP_USAGE 2건
  insertCommit.run("c-yt-1", 3, "youtube 1", now - 6000, now - 5900, 100, "com.google.android.youtube", "APP_USAGE", now);
  insertCommit.run("c-yt-2", 3, "youtube 2", now - 5000, now - 4800, 200, "com.google.android.youtube", "APP_USAGE", now);

  // 카카오톡 APP_USAGE 1건 (branch_id 1로 커밋되었으나 override 테이블에 4로 등록)
  insertCommit.run("c-kt", 1, "kakaotalk", now - 4000, now - 3500, 500, "com.kakao.talk", "APP_USAGE", now);

  // app_branch_overrides에 카카오톡 추가 (branch_id 4: feature/sns)
  d.prepare("INSERT INTO app_branch_overrides (app_package, branch_id) VALUES (?, ?)").run("com.kakao.talk", 4);

  // 일반 미분류 게임 앱 1건
  insertCommit.run("c-game", 1, "unknown game", now - 3000, now - 2950, 50, "com.unknown.game", "APP_USAGE", now);

  // 혼합 분류 앱: override 없이 과거 main, 최신 web(2)
  insertCommit.run("c-mix-1", 1, "mixed old", now - 2900, now - 2895, 5, "com.mixed.app", "APP_USAGE", now);
  insertCommit.run("c-mix-2", 2, "mixed new", now - 2800, now - 2796, 4, "com.mixed.app", "APP_USAGE", now);

  // getAppClassifications 실행
  const classifications = await getAppClassifications(adapter as any);

  // 1. 노이즈 패키지가 결과에 없는지 검증
  assert.equal(
    classifications.some((a) => a.pkg === noisePkg),
    false,
    `노이즈 패키지(${noisePkg})는 결과에서 제외되어야 함`
  );

  // 2. 전체 앱 개수: youtube, kakaotalk, game, mixed 4개
  assert.equal(classifications.length, 4, "조회된 앱은 노이즈를 제외한 4개여야 함");

  // 3. 사용시간 합계 검증 (내림차순 정렬)
  // kakaotalk: 500s, youtube: 300s, game: 50s
  assert.equal(classifications[0].pkg, "com.kakao.talk");
  assert.equal(classifications[0].totalDurationSec, 500);
  assert.equal(classifications[0].branchId, 4, "override된 branch_id 4(feature/sns)가 반영되어야 함");
  assert.equal(classifications[0].branchName, "feature/sns");

  assert.equal(classifications[1].pkg, "com.google.android.youtube");
  assert.equal(classifications[1].totalDurationSec, 300, "100s + 200s = 300s 집계되어야 함");
  assert.equal(classifications[1].branchId, 3);
  assert.equal(classifications[1].branchName, "feature/media");

  assert.equal(classifications[2].pkg, "com.unknown.game");
  assert.equal(classifications[2].totalDurationSec, 50);
  assert.equal(classifications[2].branchId, 1);
  assert.equal(classifications[2].branchName, "main");

  // 4. 혼합 여부: 기록에 현재 분류와 다른 브랜치가 남았으면 mixed
  assert.equal(classifications[0].mixed, true, "override(sns)와 기록(main)이 다르면 mixed");
  assert.equal(classifications[1].mixed, false);
  assert.equal(classifications[2].mixed, false);
  assert.equal(classifications[3].pkg, "com.mixed.app");
  assert.equal(classifications[3].branchId, 2, "override 없으면 최신 기록 분류");
  assert.equal(classifications[3].totalDurationSec, 9);
  assert.equal(classifications[3].mixed, true, "과거 main 기록이 남았으면 mixed");

  console.log("✓ getAppClassifications DB Query tests passed");
}

testDatabaseQuery().then(() => {
  console.log("All appClassification checks passed!");
});
