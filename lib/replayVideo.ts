/**
 * 리플레이 비디오(MP4) 녹화 및 공유/저장 헬퍼 모듈
 */

export const SHARE_CHUNK_SIZE = 512 * 1024; // 바이너리 기준 512KB

export const SHARE_MEDIA_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 네이티브 share_media ID 유효성 검사 (순수 함수)
 * [A-Za-z0-9_-]{1,64} 규칙 준수 여부 확인
 */
export function isValidShareMediaId(id: string): boolean {
  return SHARE_MEDIA_ID_REGEX.test(id);
}

/**
 * 고유한 share_media ID 생성
 */
export function generateShareMediaId(): string {
  const rand = Math.random().toString(36).substring(2, 10);
  return `rec_${Date.now()}_${rand}`;
}

/**
 * 리플레이 비디오 파일명 생성 (순수 함수)
 * - 단일 날짜: lifecommit_replay_2026-10-21.mp4
 * - 기간: lifecommit_replay_2026-10-01_2026-10-21.mp4
 */
export function makeReplayVideoFilename(
  dateOrRange: { start: string; end?: string } | string
): string {
  if (typeof dateOrRange === "string") {
    return `lifecommit_replay_${dateOrRange}.mp4`;
  }
  if (dateOrRange.end && dateOrRange.end !== dateOrRange.start) {
    return `lifecommit_replay_${dateOrRange.start}_${dateOrRange.end}.mp4`;
  }
  return `lifecommit_replay_${dateOrRange.start}.mp4`;
}

/**
 * 지원되는 비디오 녹화 mimeType 선택 (순수 함수)
 * 우선순위:
 * 1. video/mp4;codecs=avc1
 * 2. video/mp4
 * 3. 전부 지원 불가 -> null (webm은 저장하지 않음)
 */
export function selectSupportedVideoMimeType(
  isTypeSupported?: (mime: string) => boolean
): string | null {
  const check =
    isTypeSupported ??
    (typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function"
      ? (mime: string) => MediaRecorder.isTypeSupported(mime)
      : undefined);
  if (!check) return null;

  if (check("video/mp4;codecs=avc1")) {
    return "video/mp4;codecs=avc1";
  }
  if (check("video/mp4")) {
    return "video/mp4";
  }
  return null;
}

/**
 * 예상 녹화 시간(초) 계산 (순수 함수)
 * 재생 총 길이(초) / 배속 + 1초 (올림)
 */
export function calcExpectedVideoDurationSec(totalPlaySec: number, speed: number): number {
  if (speed <= 0) return 0;
  return Math.ceil(totalPlaySec / speed) + 1;
}

/**
 * H.264 인코더 호환을 위한 짝수 해상도 보정 (순수 함수)
 * 홀수 픽셀일 경우 1을 빼서 짝수로 만듦 (최소 2px)
 */
export function makeEvenDimension(val: number): number {
  const v = Math.max(2, Math.round(val));
  return v % 2 === 0 ? v : v - 1;
}

/**
 * Uint8Array 바이너리를 지정된 조각 크기(기본 512KB)로 분할 (순수 함수)
 * 0바이트인 경우 빈 배열 반환
 */
export function chunkBinary(
  buffer: Uint8Array,
  chunkSize: number = SHARE_CHUNK_SIZE
): Uint8Array[] {
  if (buffer.length === 0) return [];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(buffer.length, offset + chunkSize)));
  }
  return chunks;
}

/**
 * Uint8Array를 base64 문자열로 변환
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 리플레이 캔버스 상단 오버레이 그리기
 * - 상단 좌측: 시각 문구 (예: 14:30 또는 하루 전체)
 * - 상단 우측: 제목 및 LifeCommit 워터마크
 */
export function drawReplayOverlay(
  ctx: CanvasRenderingContext2D,
  options: {
    width: number;
    height: number;
    timeText: string;
    title: string;
  }
): void {
  ctx.save();
  // 상단 좌측: 시각 문구
  ctx.fillStyle = "#e3b341";
  ctx.font = "bold 14px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(options.timeText, 14, 12);

  // 상단 우측: 날짜 제목 + 작은 LifeCommit 표기
  ctx.fillStyle = "#c9d1d9";
  ctx.font = "bold 12px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.fillText(options.title, options.width - 14, 12);

  ctx.fillStyle = "#58a6ff";
  ctx.font = "bold 10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillText("LifeCommit", options.width - 14, 28);

  ctx.restore();
}
