import { levelOf, GRASS_LEVELS, formatScreenTimeShort } from "./grassLevels";

export interface GrassCell3D {
  date: string;
  sec: number;
  col: number;
  row: number;
}

export interface GrassCell2D {
  date: string;
  sec: number;
  col: number; // 0 ~ 6 (월간: 요일, 연간: 주)
  row: number; // 0 ~ 5 (월간: 주, 연간: 요일)
  dayNum?: number;
}

export interface Grass3DOptions {
  width: number;
  height: number;
  tileWidth?: number;
  tileHeight?: number;
  maxBarHeight?: number;
  originX?: number;
  originY?: number;
  backgroundColor?: string;
  devicePixelRatio?: number;
}

export interface Grass2DOptions {
  width: number;
  height: number;
  year: number;
  month?: number;
  title: string;
  backgroundColor?: string;
  devicePixelRatio?: number;
}

export const MAX_SCREEN_SEC_3D = 10 * 3600; // 10시간 상한
const EXPORT_SCALE = 2;

/**
 * 사용시간(sec)에 비례한 3D 기둥 높이 계산 (순수 함수)
 * - 0초: 높이 0
 * - 5시간 (18000초): 절반 (maxBarHeight * 0.5)
 * - 10시간 (36000초) 이상: 상한 잘라서 최대 (maxBarHeight)
 */
export function calculateBarHeight(sec: number, maxBarHeight: number): number {
  if (sec <= 0 || maxBarHeight <= 0) return 0;
  const clamped = Math.min(sec, MAX_SCREEN_SEC_3D);
  return (clamped / MAX_SCREEN_SEC_3D) * maxBarHeight;
}

/**
 * 16진수 색상 코드를 주어진 비율(factor)만큼 어둡게 만든다. (순수 함수)
 * factor < 1이면 어두워진다. (예: 0.75, 0.55)
 */
export function darkenColor(hex: string, factor: number): string {
  const cleanHex = hex.replace("#", "");
  let r = 0, g = 0, b = 0;
  if (cleanHex.length === 6) {
    r = parseInt(cleanHex.slice(0, 2), 16);
    g = parseInt(cleanHex.slice(2, 4), 16);
    b = parseInt(cleanHex.slice(4, 6), 16);
  } else if (cleanHex.length === 3) {
    r = parseInt(cleanHex[0] + cleanHex[0], 16);
    g = parseInt(cleanHex[1] + cleanHex[1], 16);
    b = parseInt(cleanHex[2] + cleanHex[2], 16);
  }
  const nr = Math.max(0, Math.min(255, Math.round(r * factor)));
  const ng = Math.max(0, Math.min(255, Math.round(g * factor)));
  const nb = Math.max(0, Math.min(255, Math.round(b * factor)));

  const toHex = (n: number) => n.toString(16).padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

/**
 * 아이소메트릭 뒤→앞(Back-to-Front) 렌더링을 위해 셀들을 정렬한다. (순수 함수)
 * col + row가 작을수록 화면 뒤쪽(상단)에 위치하므로 먼저 그린다.
 */
export function sortCellsBackToFront(cells: readonly GrassCell3D[]): GrassCell3D[] {
  return [...cells].sort((a, b) => {
    const depthA = a.col + a.row;
    const depthB = b.col + b.row;
    if (depthA !== depthB) {
      return depthA - depthB;
    }
    return a.row - b.row;
  });
}

/**
 * 주어진 셀 목록과 타일 크기로부터 전체 바운딩 박스 및 최적 origin을 계산한다.
 */
export function calculateGrass3DBounds(
  cells: readonly GrassCell3D[],
  tileWidth: number,
  tileHeight: number,
  maxBarHeight: number,
  padding: number = 16
): { width: number; height: number; originX: number; originY: number } {
  if (cells.length === 0) {
    return { width: 100, height: 100, originX: padding, originY: padding };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const cell of cells) {
    const cx = (cell.col - cell.row) * (tileWidth / 2);
    const cy = (cell.col + cell.row) * (tileHeight / 2);

    const xLeft = cx - tileWidth / 2;
    const xRight = cx + tileWidth / 2;
    const yTop = cy - maxBarHeight - tileHeight / 2;
    const yBottom = cy + tileHeight / 2;

    if (xLeft < minX) minX = xLeft;
    if (xRight > maxX) maxX = xRight;
    if (yTop < minY) minY = yTop;
    if (yBottom > maxY) maxY = yBottom;
  }

  const width = Math.ceil(maxX - minX + padding * 2);
  const height = Math.ceil(maxY - minY + padding * 2);
  const originX = Math.round(padding - minX);
  const originY = Math.round(padding - minY);

  return { width, height, originX, originY };
}

/**
 * 월간 달력 그리드 칸 배치 계산 (순수 함수)
 * 첫째 주 앞의 빈칸 수(emptyPrefixCount)와 해당 월의 총 일수(daysInMonth) 반환
 */
export function buildMonthGridCells(
  year: number,
  month: number,
  data: Record<string, number> = {}
): { cells: GrassCell2D[]; emptyPrefixCount: number; daysInMonth: number } {
  const firstDay = new Date(year, month - 1, 1);
  const emptyPrefixCount = firstDay.getDay(); // 0(일) ~ 6(토)
  const lastDay = new Date(year, month, 0);
  const daysInMonth = lastDay.getDate();

  const cells: GrassCell2D[] = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const idx = emptyPrefixCount + d - 1;
    const col = idx % 7; // 요일 (0 ~ 6)
    const row = Math.floor(idx / 7); // 주 (0 ~ 5)
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const sec = data[dateStr] || 0;
    cells.push({
      date: dateStr,
      sec,
      col,
      row,
      dayNum: d,
    });
  }

  return { cells, emptyPrefixCount, daysInMonth };
}

/**
 * 연간 잔디 그리드 칸 배치 계산 (순수 함수)
 * 1월 1일 요일 오프셋(startOffset)과 1년 총 일수(totalDays) 반환
 */
export function buildYearGridCells(
  year: number,
  data: Record<string, number> = {}
): { cells: GrassCell2D[]; startOffset: number; totalDays: number } {
  const startDate = new Date(year, 0, 1);
  const startOffset = startDate.getDay(); // 0(일) ~ 6(토)
  const endDate = new Date(year, 11, 31);

  const cells: GrassCell2D[] = [];
  let dayIdx = 0;

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const totalOffset = startOffset + dayIdx;
    const col = Math.floor(totalOffset / 7); // 주 (0 ~ 52)
    const row = totalOffset % 7; // 요일 (0 ~ 6)
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const sec = data[dateStr] || 0;
    cells.push({
      date: dateStr,
      sec,
      col,
      row,
      dayNum: d.getDate(),
    });
    dayIdx++;
  }

  return { cells, startOffset, totalDays: dayIdx };
}

/**
 * 캔버스 위에 10단계 잔디 범례를 그린다. (공용 함수)
 */
export function drawGrassLegend(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  totalWidth: number
): void {
  const colW = totalWidth / 10;
  const barH = 6;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';

  GRASS_LEVELS.forEach((info, i) => {
    const x = startX + i * colW;
    const barW = Math.max(2, colW - 2);

    ctx.fillStyle = info.color;
    ctx.fillRect(x + 1, startY, barW, barH);

    ctx.fillStyle = "#8b949e";
    ctx.fillText(info.legendLabel, x + colW / 2, startY + barH + 3);
  });

  ctx.restore();
}

/**
 * 2D Canvas 위에 잔디 2D 그리드를 그린다. (이미지 내보내기용 오프스크린 렌더링 지원)
 */
export function drawGrass2D(
  ctx: CanvasRenderingContext2D,
  cells: readonly GrassCell2D[],
  opts: Grass2DOptions
): void {
  const bg = opts.backgroundColor ?? "#0d1117";
  const padX = 20;
  const padTop = 20;

  ctx.save();

  // 1. 배경
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, opts.width, opts.height);

  // 2. 상단 헤더: 제목 + LifeCommit 표기
  ctx.textBaseline = "top";
  ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  ctx.fillStyle = "#c9d1d9";
  ctx.textAlign = "left";
  ctx.fillText(opts.title, padX, padTop);

  ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = "#58a6ff";
  ctx.textAlign = "right";
  ctx.fillText("LifeCommit", opts.width - padX, padTop + 2);

  // 3. 그리드 렌더링
  if (opts.month !== undefined) {
    // ── 월간 달력 2D ──
    const gridTop = padTop + 32;
    const dayLabels = ["일", "월", "화", "수", "목", "금", "토"];
    const availW = opts.width - padX * 2;
    const cellGap = 4;
    const cellW = (availW - cellGap * 6) / 7;
    const cellH = cellW; // 정사각형 타일

    // 요일 헤더
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = "#8b949e";
    ctx.textAlign = "center";
    for (let c = 0; c < 7; c++) {
      const cx = padX + c * (cellW + cellGap) + cellW / 2;
      ctx.fillText(dayLabels[c], cx, gridTop);
    }

    const cellsTop = gridTop + 20;

    for (const cell of cells) {
      const x = padX + cell.col * (cellW + cellGap);
      const y = cellsTop + cell.row * (cellH + cellGap);

      const level = levelOf(cell.sec);
      const info = GRASS_LEVELS[level];

      // 타일 배경
      ctx.fillStyle = info.color;
      ctx.fillRect(x, y, cellW, cellH);

      // 테두리
      ctx.strokeStyle = "#30363d";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, cellW, cellH);

      // 날짜 숫자
      ctx.fillStyle = level === 0 ? "#8b949e" : info.textColor;
      ctx.font = 'bold 10px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.textAlign = "center";
      ctx.fillText(String(cell.dayNum ?? ""), x + cellW / 2, y + 4);

      // 짧은 사용시간
      const shortTime = formatScreenTimeShort(cell.sec);
      if (shortTime) {
        ctx.fillStyle = info.textColor === "#000000" ? "rgba(0,0,0,0.85)" : "rgba(255,255,255,0.9)";
        ctx.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(shortTime, x + cellW / 2, y + cellH - 12);
      }
    }

    // 4. 하단 범례
    const maxRow = cells.reduce((max, c) => Math.max(max, c.row), 0);
    const legendY = cellsTop + (maxRow + 1) * (cellH + cellGap) + 16;
    drawGrassLegend(ctx, padX, legendY, availW);
  } else {
    // ── 연간 잔디 2D ──
    const gridTop = padTop + 34;
    const availW = opts.width - padX * 2;
    const cellGap = 3;
    const cellW = 12;
    const cellH = 12;

    for (const cell of cells) {
      const x = padX + cell.col * (cellW + cellGap);
      const y = gridTop + cell.row * (cellH + cellGap);

      const level = levelOf(cell.sec);
      const info = GRASS_LEVELS[level];

      ctx.fillStyle = info.color;
      ctx.fillRect(x, y, cellW, cellH);

      ctx.strokeStyle = "#21262d";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x, y, cellW, cellH);
    }

    // 4. 하단 범례
    const legendY = gridTop + 7 * (cellH + cellGap) + 16;
    drawGrassLegend(ctx, padX, legendY, Math.min(availW, 360));
  }

  ctx.restore();
}

/**
 * 2D Canvas 위에 아이소메트릭 3D 잔디를 그린다. (순수 캔버스 그리기 함수)
 * GRASS-C 이미지 내보내기에서도 재사용 가능.
 */
export function drawGrass3D(
  ctx: CanvasRenderingContext2D,
  cells: readonly GrassCell3D[],
  opts: Grass3DOptions
): void {
  const tileWidth = opts.tileWidth ?? 20;
  const tileHeight = opts.tileHeight ?? Math.round(tileWidth * 0.55);
  const maxBarHeight = opts.maxBarHeight ?? 36;
  const backgroundColor = opts.backgroundColor ?? "#0d1117";

  let originX = opts.originX;
  let originY = opts.originY;

  if (originX === undefined || originY === undefined) {
    const bounds = calculateGrass3DBounds(cells, tileWidth, tileHeight, maxBarHeight, 16);
    originX = originX ?? bounds.originX;
    originY = originY ?? bounds.originY;
  }

  const sorted = sortCellsBackToFront(cells);

  ctx.save();

  // 1. 배경 채우기
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, opts.width, opts.height);

  // 2. 각 셀 아이소메트릭 기둥 그리기
  const halfW = tileWidth / 2;
  const halfH = tileHeight / 2;

  for (const cell of sorted) {
    const cx = originX + (cell.col - cell.row) * halfW;
    const cy = originY + (cell.col + cell.row) * halfH;

    const barHeight = calculateBarHeight(cell.sec, maxBarHeight);
    const level = levelOf(cell.sec);
    const topColor = cell.sec > 0 ? GRASS_LEVELS[level].color : "#161b22";

    if (barHeight <= 0) {
      // 바닥 납작한 마름모 타일만 렌더링
      ctx.beginPath();
      ctx.moveTo(cx, cy - halfH);
      ctx.lineTo(cx + halfW, cy);
      ctx.lineTo(cx, cy + halfH);
      ctx.lineTo(cx - halfW, cy);
      ctx.closePath();

      ctx.fillStyle = topColor;
      ctx.fill();
      ctx.strokeStyle = "#21262d";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    } else {
      const leftColor = darkenColor(topColor, 0.75);
      const rightColor = darkenColor(topColor, 0.55);

      const topCy = cy - barHeight;

      // ── 좌측면 (Left Face) ──
      ctx.beginPath();
      ctx.moveTo(cx - halfW, topCy);
      ctx.lineTo(cx, topCy + halfH);
      ctx.lineTo(cx, cy + halfH);
      ctx.lineTo(cx - halfW, cy);
      ctx.closePath();
      ctx.fillStyle = leftColor;
      ctx.fill();
      ctx.strokeStyle = darkenColor(leftColor, 0.8);
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // ── 우측면 (Right Face) ──
      ctx.beginPath();
      ctx.moveTo(cx, topCy + halfH);
      ctx.lineTo(cx + halfW, topCy);
      ctx.lineTo(cx + halfW, cy);
      ctx.lineTo(cx, cy + halfH);
      ctx.closePath();
      ctx.fillStyle = rightColor;
      ctx.fill();
      ctx.strokeStyle = darkenColor(rightColor, 0.8);
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // ── 윗면 (Top Face) ──
      ctx.beginPath();
      ctx.moveTo(cx, topCy - halfH);
      ctx.lineTo(cx + halfW, topCy);
      ctx.lineTo(cx, topCy + halfH);
      ctx.lineTo(cx - halfW, topCy);
      ctx.closePath();
      ctx.fillStyle = topColor;
      ctx.fill();
      ctx.strokeStyle = darkenColor(topColor, 0.85);
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  ctx.restore();
}

/**
 * 잔디를 2D 또는 3D 오프스크린 캔버스에 새로 렌더링하여 반환한다. (공유/저장용)
 * DOM 캡처 없이 순수하게 캔버스에 직접 그려서 생성한다.
 */
export function renderGrassToOffscreenCanvas(options: {
  type: "2D" | "3D";
  year: number;
  month?: number;
  data: Record<string, number>;
}): HTMLCanvasElement {
  const { type, year, month, data } = options;
  const isMonth = month !== undefined;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get 2d context for offscreen canvas");

  // 2x so the saved image stays sharp on phone screens; drawing code keeps working in 1x units
  const setSize = (w: number, h: number) => {
    canvas.width = w * EXPORT_SCALE;
    canvas.height = h * EXPORT_SCALE;
    ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, 0, 0);
  };

  const title = isMonth ? `${year}년 ${month}월 폰 사용시간` : `${year} 폰 사용시간`;

  if (type === "2D") {
    if (isMonth) {
      const { cells } = buildMonthGridCells(year, month, data);
      const width = 420;
      const height = 440;
      setSize(width, height);
      drawGrass2D(ctx, cells, { width, height, year, month, title });
    } else {
      const { cells } = buildYearGridCells(year, data);
      const width = 860;
      const height = 230;
      setSize(width, height);
      drawGrass2D(ctx, cells, { width, height, year, title });
    }
  } else {
    // ── 3D 오프스크린 렌더링 ──
    const padX = 20;
    const padTop = 20;
    let cells3D: GrassCell3D[] = [];
    let tileW = 20;
    let tileH = 11;
    let maxBarH = 36;

    if (isMonth) {
      const { cells } = buildMonthGridCells(year, month, data);
      cells3D = cells.map((c) => ({
        date: c.date,
        sec: c.sec,
        col: c.col,
        row: c.row,
      }));
      tileW = 40;
      tileH = 22;
      maxBarH = 80;
    } else {
      const { cells } = buildYearGridCells(year, data);
      cells3D = cells.map((c) => ({
        date: c.date,
        sec: c.sec,
        col: c.col,
        row: c.row,
      }));
      tileW = 14;
      tileH = 8;
      maxBarH = 36;
    }

    const bounds = calculateGrass3DBounds(cells3D, tileW, tileH, maxBarH, 20);
    const headerH = 40;
    const legendH = 40;
    const totalW = Math.max(bounds.width + 40, isMonth ? 400 : 880);
    const totalH = bounds.height + headerH + legendH;

    setSize(totalW, totalH);

    // 1. 배경
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, totalW, totalH);

    // 3. 중앙 3D 잔디
    const contentOriginX = Math.round((totalW - bounds.width) / 2) + bounds.originX;
    const contentOriginY = headerH + bounds.originY;

    drawGrass3D(ctx, cells3D, {
      width: totalW,
      height: totalH,
      tileWidth: tileW,
      tileHeight: tileH,
      maxBarHeight: maxBarH,
      originX: contentOriginX,
      originY: contentOriginY,
      backgroundColor: "#0d1117",
    });

    // 상단 헤더 (drawGrass3D가 배경을 전부 칠하므로 그 뒤에)
    ctx.textBaseline = "top";
    ctx.font = 'bold 15px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
    ctx.fillStyle = "#c9d1d9";
    ctx.textAlign = "left";
    ctx.fillText(title, padX, padTop);

    ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = "#58a6ff";
    ctx.textAlign = "right";
    ctx.fillText("LifeCommit", totalW - padX, padTop + 2);

    // 4. 하단 범례
    const legendY = totalH - legendH + 8;
    drawGrassLegend(ctx, padX, legendY, Math.min(totalW - padX * 2, 360));
  }

  return canvas;
}
