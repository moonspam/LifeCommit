import LifeCommitPlugin from "@/plugins/LifeCommitPlugin";

export const MAX_IMAGE_EXPORT_SIDE = 2048;

/**
 * 캔버스 크기를 최대 maxSide(기본 2048px) 이하로 비율을 유지하며 축소할 크기를 계산한다. (순수 함수)
 * width, height 중 큰 쪽이 maxSide를 초과하면 축소하고, 그렇지 않으면 원본 크기를 그대로 반환한다.
 */
export function calculateExportDimensions(
  width: number,
  height: number,
  maxSide: number = MAX_IMAGE_EXPORT_SIDE
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }
  const maxDim = Math.max(width, height);
  if (maxDim <= maxSide) {
    return { width, height };
  }
  const scale = maxSide / maxDim;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * HTMLCanvasElement를 PNG base64 문자열로 내보낸다.
 * - 긴 변 최대 2048px로 축소 (비율 유지)
 * - data:image/png;base64, 접두어를 제거한 순수 base64 반환
 */
export function exportCanvas(
  canvas: HTMLCanvasElement,
  maxSide: number = MAX_IMAGE_EXPORT_SIDE
): string {
  const { width: targetWidth, height: targetHeight } = calculateExportDimensions(
    canvas.width,
    canvas.height,
    maxSide
  );

  let sourceCanvas = canvas;
  if (targetWidth !== canvas.width || targetHeight !== canvas.height) {
    const scaled = document.createElement("canvas");
    scaled.width = targetWidth;
    scaled.height = targetHeight;
    const ctx = scaled.getContext("2d");
    if (ctx) {
      ctx.drawImage(canvas, 0, 0, targetWidth, targetHeight);
      sourceCanvas = scaled;
    }
  }

  const dataUrl = sourceCanvas.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/**
 * 잔디 이미지 파일명 생성 (순수 함수)
 * - 월간: lifecommit_grass_2026-10.png
 * - 연간: lifecommit_grass_2026.png
 */
export function getGrassExportFilename(year: number, month?: number): string {
  if (month !== undefined && month >= 1 && month <= 12) {
    const mStr = String(month).padStart(2, "0");
    return `lifecommit_grass_${year}-${mStr}.png`;
  }
  return `lifecommit_grass_${year}.png`;
}

/**
 * 리플레이 이미지 파일명 생성 (순수 함수)
 * - 단일 날짜: lifecommit_replay_2026-10-21.png
 * - 기간: lifecommit_replay_2026-10-15_2026-10-21.png
 */
export function getReplayExportFilename(
  dateOrRange: { start: string; end?: string } | string
): string {
  if (typeof dateOrRange === "string") {
    return `lifecommit_replay_${dateOrRange}.png`;
  }
  if (dateOrRange.end && dateOrRange.end !== dateOrRange.start) {
    return `lifecommit_replay_${dateOrRange.start}_${dateOrRange.end}.png`;
  }
  return `lifecommit_replay_${dateOrRange.start}.png`;
}

/**
 * 캔버스를 지정된 모드("share" | "save")로 내보내기/저장한다.
 */
export async function shareOrSaveCanvas(options: {
  canvas: HTMLCanvasElement;
  filename: string;
  mode: "share" | "save";
}): Promise<{ success: boolean; message: string }> {
  try {
    const base64 = exportCanvas(options.canvas);
    await LifeCommitPlugin.shareImage({
      filename: options.filename,
      base64,
      mode: options.mode,
    });
    return {
      success: true,
      message: options.mode === "save" ? "사진에 저장했습니다" : "공유 창을 열었습니다",
    };
  } catch (err: any) {
    const errMsg = err?.message || String(err);
    return {
      success: false,
      message: errMsg,
    };
  }
}
