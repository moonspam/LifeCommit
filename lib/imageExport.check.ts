import assert from "node:assert/strict";
import {
  calculateExportDimensions,
  getGrassExportFilename,
  getReplayExportFilename,
} from "./imageExport";
import {
  buildMonthGridCells,
  buildYearGridCells,
} from "./grassCanvas";

console.log("=== [1] exportCanvas Dimension Scaling Checks ===");

// 1. 작은 이미지는 크기 유지
const small = calculateExportDimensions(1000, 500, 2048);
assert.deepEqual(small, { width: 1000, height: 500 }, "2048 이하 이미지는 크기 유지");

const exact = calculateExportDimensions(2048, 2048, 2048);
assert.deepEqual(exact, { width: 2048, height: 2048 }, "정확히 2048x2048이면 크기 유지");

// 2. 가로가 긴 이미지 축소 (비율 유지, 긴 변 2048 상한)
const wide = calculateExportDimensions(4096, 2048, 2048);
assert.deepEqual(wide, { width: 2048, height: 1024 }, "가로 4096 -> 2048 축소 시 세로 1024로 비율 유지");

// 3. 세로가 긴 이미지 축소 (비율 유지, 긴 변 2048 상한)
const tall = calculateExportDimensions(1500, 3000, 2048);
assert.deepEqual(tall, { width: 1024, height: 2048 }, "세로 3000 -> 2048 축소 시 가로 1024로 비율 유지");

console.log("✓ calculateExportDimensions checks passed");

console.log("=== [2] Filename Generation Checks ===");

// 1. 잔디 파일명
assert.equal(getGrassExportFilename(2026, 10), "lifecommit_grass_2026-10.png");
assert.equal(getGrassExportFilename(2026, 5), "lifecommit_grass_2026-05.png");
assert.equal(getGrassExportFilename(2026), "lifecommit_grass_2026.png");

// 2. 리플레이 파일명 (단일 날짜 vs 기간)
assert.equal(getReplayExportFilename("2026-10-21"), "lifecommit_replay_2026-10-21.png");
assert.equal(
  getReplayExportFilename({ start: "2026-10-21" }),
  "lifecommit_replay_2026-10-21.png"
);
assert.equal(
  getReplayExportFilename({ start: "2026-10-21", end: "2026-10-21" }),
  "lifecommit_replay_2026-10-21.png"
);
assert.equal(
  getReplayExportFilename({ start: "2026-10-15", end: "2026-10-21" }),
  "lifecommit_replay_2026-10-15_2026-10-21.png"
);

console.log("✓ Filename generation checks passed");

console.log("=== [3] drawGrass2D Grid Cell Placement Checks ===");

// 1. 월간 달력 배치 (2026년 10월)
// 2026-10-01은 목요일 (getDay() = 4)
const monthGrid = buildMonthGridCells(2026, 10);
assert.equal(monthGrid.emptyPrefixCount, 4, "2026년 10월 1일은 목요일이므로 첫 주 앞 빈칸은 4개여야 함");
assert.equal(monthGrid.daysInMonth, 31, "10월 총 일수는 31일이어야 함");
assert.equal(monthGrid.cells.length, 31, "생성된 셀 개수는 31개여야 함");

// 10월 1일 첫 셀
const day1 = monthGrid.cells[0];
assert.equal(day1.dayNum, 1);
assert.equal(day1.col, 4, "10월 1일은 목요일(col 4)");
assert.equal(day1.row, 0, "10월 1일은 0주차(row 0)");

// 10월 31일 마지막 셀
const day31 = monthGrid.cells[30];
assert.equal(day31.dayNum, 31);
assert.equal(day31.col, 6, "10월 31일은 토요일(col 6)");
assert.equal(day31.row, 4, "10월 31일은 4주차(row 4)");

// 2. 연간 잔디 배치 (2026년)
// 2026-01-01은 목요일 (getDay() = 4)
const yearGrid = buildYearGridCells(2026);
assert.equal(yearGrid.startOffset, 4, "2026년 1월 1일은 목요일이므로 startOffset = 4");
assert.equal(yearGrid.totalDays, 365, "2026년은 평년이므로 365일");
assert.equal(yearGrid.cells.length, 365, "연간 셀 개수는 365개");

// 1월 1일 셀: col 0, row 4
const jan1 = yearGrid.cells[0];
assert.equal(jan1.col, 0, "1월 1일은 0주차");
assert.equal(jan1.row, 4, "1월 1일은 목요일(row 4)");
assert.equal(jan1.date, "2026-01-01");

// 12월 31일 셀: (startOffset + 364) = 368 -> col = 368 / 7 = 52, row = 368 % 7 = 4 (목요일)
const dec31 = yearGrid.cells[364];
assert.equal(dec31.col, 52, "12월 31일은 52주차");
assert.equal(dec31.row, 4, "12월 31일은 목요일(row 4)");
assert.equal(dec31.date, "2026-12-31");

console.log("✓ drawGrass2D cell placement checks passed");
console.log("All imageExport checks passed!");
