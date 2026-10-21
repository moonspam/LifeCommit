import assert from "node:assert/strict";
import {
  calculateBarHeight,
  darkenColor,
  sortCellsBackToFront,
  calculateGrass3DBounds,
  drawGrass3D,
  GrassCell3D,
} from "./grassCanvas";
import { GRASS_LEVELS } from "./grassLevels";

console.log("=== [1] calculateBarHeight checks ===");
const MAX_H = 40;

// 1. 0초 = 높이 0
assert.equal(calculateBarHeight(0, MAX_H), 0, "0s -> height 0");
assert.equal(calculateBarHeight(-100, MAX_H), 0, "negative sec -> height 0");

// 2. 5시간 (18000초) = 절반
const h5h = calculateBarHeight(5 * 3600, MAX_H);
assert.equal(h5h, MAX_H * 0.5, "5h (18000s) -> half height (20)");

// 3. 10시간 (36000초) = 최대
const h10h = calculateBarHeight(10 * 3600, MAX_H);
assert.equal(h10h, MAX_H, "10h (36000s) -> max height (40)");

// 4. 12시간 (43200초) = 최대 (상한 잘림)
const h12h = calculateBarHeight(12 * 3600, MAX_H);
assert.equal(h12h, MAX_H, "12h (43200s) -> max height (40)");

console.log("✓ calculateBarHeight checks passed");

console.log("=== [2] darkenColor checks ===");

// 16진수 색상 밝기(R+G+B 합) 계산 헬퍼
function brightness(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return r + g + b;
}

for (const levelInfo of GRASS_LEVELS) {
  if (levelInfo.level === 0) continue; // 0단계는 배경색
  const baseColor = levelInfo.color;
  const leftColor = darkenColor(baseColor, 0.75);
  const rightColor = darkenColor(baseColor, 0.55);

  const baseB = brightness(baseColor);
  const leftB = brightness(leftColor);
  const rightB = brightness(rightColor);

  assert.ok(
    leftB < baseB,
    `좌측면(${leftColor}, 밝기:${leftB})은 윗면(${baseColor}, 밝기:${baseB})보다 어두워야 함`
  );
  assert.ok(
    rightB < leftB,
    `우측면(${rightColor}, 밝기:${rightB})은 좌측면(${leftColor}, 밝기:${leftB})보다 더 어두워야 함`
  );
}

console.log("✓ darkenColor checks passed");

console.log("=== [3] sortCellsBackToFront checks ===");

const rawCells: GrassCell3D[] = [
  { date: "2026-01-05", sec: 3600, col: 5, row: 3 }, // depth = 8
  { date: "2026-01-01", sec: 1800, col: 0, row: 0 }, // depth = 0
  { date: "2026-01-04", sec: 7200, col: 2, row: 1 }, // depth = 3
  { date: "2026-01-02", sec: 0, col: 1, row: 0 },    // depth = 1
  { date: "2026-01-03", sec: 500, col: 0, row: 1 },  // depth = 1
];

const sorted = sortCellsBackToFront(rawCells);

// depth(col + row)가 단조 증가해야 함
for (let i = 0; i < sorted.length - 1; i++) {
  const depthCurrent = sorted[i].col + sorted[i].row;
  const depthNext = sorted[i + 1].col + sorted[i + 1].row;
  assert.ok(
    depthCurrent <= depthNext,
    `뒤에서 앞 순서 정렬 위반: idx ${i} depth=${depthCurrent} > idx ${i+1} depth=${depthNext}`
  );
}
assert.equal(sorted[0].date, "2026-01-01", "가장 뒤쪽(depth 0) 셀이 맨 앞에 와야 함");
assert.equal(sorted[sorted.length - 1].date, "2026-01-05", "가장 앞쪽(depth 8) 셀이 맨 뒤에 와야 함");

console.log("✓ sortCellsBackToFront checks passed");

console.log("=== [4] calculateGrass3DBounds & drawGrass3D mock canvas checks ===");

const bounds = calculateGrass3DBounds(rawCells, 20, 11, 36, 16);
assert.ok(bounds.width > 50, "bounds width must be positive");
assert.ok(bounds.height > 50, "bounds height must be positive");
assert.ok(bounds.originX > 0, "originX must be positive");
assert.ok(bounds.originY > 0, "originY must be positive");

// Mock CanvasRenderingContext2D
let fillRectCalls = 0;
let fillCalls = 0;
let strokeCalls = 0;

const mockCtx: any = {
  save: () => {},
  restore: () => {},
  fillRect: () => { fillRectCalls++; },
  beginPath: () => {},
  moveTo: () => {},
  lineTo: () => {},
  closePath: () => {},
  fill: () => { fillCalls++; },
  stroke: () => { strokeCalls++; },
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 1,
};

drawGrass3D(mockCtx, rawCells, {
  width: bounds.width,
  height: bounds.height,
  tileWidth: 20,
  tileHeight: 11,
  maxBarHeight: 36,
  originX: bounds.originX,
  originY: bounds.originY,
});

assert.ok(fillRectCalls >= 1, "배경 fillRect가 1회 이상 호출되어야 함");
assert.ok(fillCalls >= rawCells.length, "각 셀마다 면 fill이 호출되어야 함");
assert.ok(strokeCalls >= rawCells.length, "각 셀마다 테두리 stroke가 호출되어야 함");

console.log("✓ drawGrass3D mock canvas execution checks passed");
console.log("All grassCanvas checks passed!");
