import { formatDuration } from "./today";

export interface GrassLevelInfo {
  readonly level: number;
  readonly minSec: number;
  readonly color: string;
  readonly textColor: string;
  readonly legendLabel: string;
}

/**
 * 폰 사용시간 기준 10단계 잔디 팔레트 (한국 성인 하루 평균 약 2~3.7시간 기준)
 * 경계: "이상/미만". legendLabel은 그 단계의 시작값(1단계만 "<30m")
 */
export const GRASS_LEVELS: readonly GrassLevelInfo[] = [
  { level: 0, minSec: 0, color: "#161b22", textColor: "#8b949e", legendLabel: "0" },
  { level: 1, minSec: 1, color: "#1f3b57", textColor: "#ffffff", legendLabel: "<30m" },
  { level: 2, minSec: 1800, color: "#1f6feb", textColor: "#ffffff", legendLabel: "30m" },
  { level: 3, minSec: 3600, color: "#1b9aaa", textColor: "#ffffff", legendLabel: "1h" },
  { level: 4, minSec: 7200, color: "#2ea043", textColor: "#ffffff", legendLabel: "2h" },
  { level: 5, minSec: 10800, color: "#a5d63f", textColor: "#000000", legendLabel: "3h" },
  { level: 6, minSec: 14400, color: "#f2cc60", textColor: "#000000", legendLabel: "4h" },
  { level: 7, minSec: 18000, color: "#f0883e", textColor: "#000000", legendLabel: "5h" },
  { level: 8, minSec: 21600, color: "#f85149", textColor: "#ffffff", legendLabel: "6h" },
  { level: 9, minSec: 28800, color: "#db61a2", textColor: "#ffffff", legendLabel: "8h+" },
] as const;

/**
 * 주어진 초(sec)에 해당하는 잔디 레벨 (0 ~ 9)을 반환한다.
 * 경계는 "이상/미만" (예: 정확히 1시간(3600초) = 3단계).
 */
export function levelOf(sec: number): number {
  if (sec <= 0) return 0;
  if (sec < 1800) return 1;
  if (sec < 3600) return 2;
  if (sec < 7200) return 3;
  if (sec < 10800) return 4;
  if (sec < 14400) return 5;
  if (sec < 18000) return 6;
  if (sec < 21600) return 7;
  if (sec < 28800) return 8;
  return 9;
}

/**
 * 월 달력 셀 내부에 표시할 짧은 사용시간 형식 (예: 45m, 2.5h, 0이면 빈 문자열).
 */
export function formatScreenTimeShort(sec: number): string {
  if (sec <= 0) return "";
  if (sec < 3600) {
    const mins = Math.floor(sec / 60);
    return mins > 0 ? `${mins}m` : "<1m";
  }
  const hours = Math.floor(sec / 360) / 10;
  return `${hours}h`;
}

/**
 * 잔디 셀 hover 시 표시할 title 문자열 (예: "3시간 12분", "45분", "0분").
 */
export function formatScreenTimeTitle(sec: number): string {
  if (sec <= 0) return "0분";
  return formatDuration(sec);
}
