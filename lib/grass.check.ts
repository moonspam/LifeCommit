import assert from "node:assert/strict";
import {
  levelOf,
  formatScreenTimeShort,
  formatScreenTimeTitle,
  GRASS_LEVELS,
} from "./grassLevels";
import { getDailyScreenSeconds } from "./queries";
import { BASE_TABLES_SCHEMA } from "./schema";
import { openRaw } from "./sqliteTestDb";
import { NOISE_PACKAGES } from "./constants";

console.log("=== [1] Grass Level Pure Function Checks ===");

// 1. levelOf 경계값 검증
// 0, 1, 1799, 1800, 3599, 3600, 7200, 10799, 10800, 21599, 21600, 28799, 28800, 50000
assert.equal(levelOf(0), 0, "0s -> level 0");
assert.equal(levelOf(1), 1, "1s -> level 1");
assert.equal(levelOf(1799), 1, "1799s -> level 1");
assert.equal(levelOf(1800), 2, "1800s (30m) -> level 2");
assert.equal(levelOf(3599), 2, "3599s -> level 2");
assert.equal(levelOf(3600), 3, "3600s (1h) -> level 3");
assert.equal(levelOf(7200), 4, "7200s (2h) -> level 4");
assert.equal(levelOf(10799), 4, "10799s -> level 4");
assert.equal(levelOf(10800), 5, "10800s (3h) -> level 5");
assert.equal(levelOf(21599), 7, "21599s (< 6h) -> level 7");
assert.equal(levelOf(21600), 8, "21600s (6h) -> level 8");
assert.equal(levelOf(28799), 8, "28799s (< 8h) -> level 8");
assert.equal(levelOf(28800), 9, "28800s (8h) -> level 9");
assert.equal(levelOf(50000), 9, "50000s (> 8h) -> level 9");

// 2. formatScreenTimeShort 검증
assert.equal(formatScreenTimeShort(0), "", "0s -> empty string");
assert.equal(formatScreenTimeShort(2700), "45m", "2700s -> 45m");
assert.equal(formatScreenTimeShort(9000), "2.5h", "9000s -> 2.5h");
assert.equal(formatScreenTimeShort(3600), "1h", "3600s -> 1h");
assert.equal(formatScreenTimeShort(1800), "30m", "1800s -> 30m");
assert.equal(formatScreenTimeShort(17880), "4.9h", "17880s (4h 58m) -> 4.9h (내림)");
assert.equal(formatScreenTimeShort(18000), "5h", "18000s (5h) -> 5h");

// 3. formatScreenTimeTitle 검증
assert.equal(formatScreenTimeTitle(0), "0분");
assert.equal(formatScreenTimeTitle(1800), "30분");
assert.equal(formatScreenTimeTitle(11520), "3시간 12분"); // 3 * 3600 + 12 * 60 = 11520

// 4. 레벨 색상 및 글자색 무결성 검증
assert.equal(GRASS_LEVELS.length, 10);
assert.equal(GRASS_LEVELS[5].textColor, "#000000", "5단계는 밝은 배경이므로 검정 글자");
assert.equal(GRASS_LEVELS[6].textColor, "#000000", "6단계는 밝은 배경이므로 검정 글자");
assert.equal(GRASS_LEVELS[7].textColor, "#000000", "7단계는 밝은 배경이므로 검정 글자");
assert.equal(GRASS_LEVELS[8].textColor, "#ffffff", "8단계는 흰색 글자");

console.log("✓ Pure function checks passed");

// ─────────────────────────────────────────────────────────────
// [2] getDailyScreenSeconds SQLite DB 검증
// ─────────────────────────────────────────────────────────────
console.log("=== [2] getDailyScreenSeconds DB Query Checks ===");

async function testDatabase() {
  const { d, adapter } = openRaw();
  d.exec(BASE_TABLES_SCHEMA);

  const insertCommit = d.prepare(`
    INSERT INTO commits (
      id, branch_id, parent_id, subject, body, author_tag,
      started_at, ended_at, duration_sec, app_package,
      event_type, squashed_events, geofence_name, lat, lng, created_at
    ) VALUES (?, 1, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, '[]', NULL, NULL, NULL, ?)
  `);

  const noisePkg = Array.from(NOISE_PACKAGES)[0] || "com.sec.android.app.launcher";

  // 1) 비-APP_USAGE 커밋들 (무시되어야 함)
  const locStart = new Date(2026, 9, 15, 10, 0, 0).getTime();
  insertCommit.run("c-loc", "Location fix", locStart, locStart + 1800000, 1800, null, "LOCATION", locStart);

  const callStart = new Date(2026, 9, 15, 12, 0, 0).getTime();
  insertCommit.run("c-call", "Call event", callStart, callStart + 300000, 300, "com.samsung.android.dialer", "CALL", callStart);

  // 2) 노이즈 패키지 APP_USAGE (무시되어야 함)
  const noiseStart = new Date(2026, 9, 15, 14, 0, 0).getTime();
  insertCommit.run("c-noise", "Noise app", noiseStart, noiseStart + 1200000, 1200, noisePkg, "APP_USAGE", noiseStart);

  // 3) 당일 APP_USAGE 세션 (2026-05-10 10:00 ~ 11:00, 3600초)
  const chromeStart = new Date(2026, 4, 10, 10, 0, 0).getTime();
  const chromeEnd = new Date(2026, 4, 10, 11, 0, 0).getTime();
  insertCommit.run("c-chrome", "Chrome session", chromeStart, chromeEnd, 3600, "com.android.chrome", "APP_USAGE", chromeStart);

  // 4) 23:30 ~ 00:30 자정 걸친 세션 (2026-10-20 23:30 ~ 2026-10-21 00:30, 3600초)
  const ytCrossStart = new Date(2026, 9, 20, 23, 30, 0).getTime();
  const ytCrossEnd = new Date(2026, 9, 21, 0, 30, 0).getTime();
  insertCommit.run("c-yt-cross", "YouTube midnight cross", ytCrossStart, ytCrossEnd, 3600, "com.google.android.youtube", "APP_USAGE", ytCrossStart);

  // 5) 연도 경계 세션 (2026-12-31 23:30 ~ 2027-01-01 00:30, 3600초)
  const yearCrossStart = new Date(2026, 11, 31, 23, 30, 0).getTime();
  const yearCrossEnd = new Date(2027, 0, 1, 0, 30, 0).getTime();
  insertCommit.run("c-year-cross", "KakaoTalk year cross", yearCrossStart, yearCrossEnd, 3600, "com.kakao.talk", "APP_USAGE", yearCrossStart);

  // ── 2026년 데이터 조회 ──
  const res2026 = await getDailyScreenSeconds(2026, adapter as any);
  const map2026 = new Map(res2026.map((r) => [r.date, r.sec]));

  // 검증: 비-APP_USAGE 및 노이즈 패키지만 있었던 2026-10-15는 결과에 없어야 함
  assert.equal(map2026.has("2026-10-15"), false, "LOCATION, CALL, 노이즈 앱은 집계되지 않아야 함");

  // 검증: 당일 세션 2026-05-10에 3600초
  assert.equal(map2026.get("2026-05-10"), 3600, "2026-05-10 Chrome 사용시간은 3600초여야 함");

  // 검증: 자정 걸친 세션 (23:30 ~ 00:30) 각 30분(1800초)씩 배분
  assert.equal(map2026.get("2026-10-20"), 1800, "2026-10-20 몫은 1800초여야 함");
  assert.equal(map2026.get("2026-10-21"), 1800, "2026-10-21 몫은 1800초여야 함");

  // 검증: 연도 경계 세션 (12-31 -> 01-01)에서 2026년에는 12-31 몫만 포함
  assert.equal(map2026.get("2026-12-31"), 1800, "2026-12-31 몫은 1800초여야 함");
  assert.equal(map2026.has("2027-01-01"), false, "2026년 조회 시 2027-01-01은 포함되지 않아야 함");

  // ── 2027년 데이터 조회 ──
  const res2027 = await getDailyScreenSeconds(2027, adapter as any);
  const map2027 = new Map(res2027.map((r) => [r.date, r.sec]));

  // 검증: 2027년 조회 시 01-01 몫(1800초)만 포함
  assert.equal(map2027.get("2027-01-01"), 1800, "2027-01-01 몫은 1800초여야 함");
  assert.equal(map2027.has("2026-12-31"), false, "2027년 조회 시 2026-12-31은 포함되지 않아야 함");

  console.log("✓ getDailyScreenSeconds DB checks passed");
}

testDatabase().then(() => {
  console.log("All grass checks passed!");
});
