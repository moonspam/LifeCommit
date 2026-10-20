/**
 * LifeCommit - 자동완성 검색창 키보드 탐색 및 하이라이트 순수 헬퍼 모듈
 * AskPanel, FilterSettingsModal 및 검증 스크립트에서 공용으로 사용
 */

/** 키보드 탐색 순수 액션 계산 */
export function computeTargetSearchKeyAction(
  key: string,
  currentIdx: number,
  totalItems: number
): { action: "reset" | "down" | "up" | "select" | "none"; nextIdx: number } {
  if (key === "Escape") {
    return { action: "reset", nextIdx: 0 };
  }
  if (totalItems <= 0) {
    return { action: "none", nextIdx: 0 };
  }
  const clampedIdx = Math.max(0, Math.min(currentIdx, totalItems - 1));
  if (key === "ArrowDown") {
    return { action: "down", nextIdx: currentIdx < 0 ? 0 : (clampedIdx + 1) % totalItems };
  }
  if (key === "ArrowUp") {
    return { action: "up", nextIdx: currentIdx < 0 ? totalItems - 1 : (clampedIdx - 1 + totalItems) % totalItems };
  }
  if (key === "Enter") {
    return { action: "select", nextIdx: clampedIdx };
  }
  return { action: "none", nextIdx: clampedIdx };
}

/** 활성 옵션 ID (aria-activedescendant) 순수 계산 함수 (접두어 지원) */
export function getTargetActiveOptionId(
  highlightIdx: number,
  totalItems: number,
  prefix = "target-opt"
): string | undefined {
  return totalItems > 0 && highlightIdx >= 0 && highlightIdx < totalItems
    ? `${prefix}-${highlightIdx}`
    : undefined;
}

/** 상태 기반 활성 옵션 ID 계산 (목록 닫힘 또는 blur/탐색 미활성 시 undefined 반환) */
export function getActiveOptionId(
  isOpen: boolean,
  isKeyboardNav: boolean,
  highlightIdx: number,
  totalItems: number,
  prefix: string
): string | undefined {
  if (!isOpen || !isKeyboardNav) return undefined;
  return getTargetActiveOptionId(highlightIdx, totalItems, prefix);
}

/** blur 시 키보드 탐색 상태 해제 순수 전이 함수 */
export function dismissAutocompleteNav(_isNavigating: boolean): boolean {
  return false;
}

/** 옵션 항목 키보드 하이라이트 여부 순수 계산 함수 */
export function isOptionHighlighted(
  isKeyboardNav: boolean,
  idx: number,
  highlightIdx: number
): boolean {
  return isKeyboardNav && idx === highlightIdx;
}

/** 후보 목록 개수 변경 시 하이라이트 인덱스를 유효 범위 [0, total - 1]로 clamp */
export function clampHighlightIdx(idx: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(idx, total - 1));
}
