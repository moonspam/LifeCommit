/**
 * AccessibilityPlugin - 화면 텍스트 이벤트 수신 플러그인 인터페이스
 *
 * Android AccessibilityService를 래핑.
 * 화면에 표시된 텍스트(예: Chrome 탭 제목 "iluku blog")를 추출하여
 * Staging Area에 전달함.
 * 실제 Kotlin 구현은 Phase 3에서 진행.
 */

import { registerPlugin } from "@capacitor/core";

// ── 타입 정의 ─────────────────────────────────────────────

export interface AccessibilityEvent {
  packageName: string;        // 이벤트 발생 앱 패키지
  appLabel: string;
  eventType:
    | "WINDOW_STATE_CHANGED"     // 앱 전환
    | "WINDOW_CONTENT_CHANGED"   // 화면 내용 변경
    | "VIEW_SCROLLED"
    | "VIEW_CLICKED"
    | "LOCATION"                 // GPS 위치 변경
    | "REPLY";                   // 답장 이벤트
  extractedText: string;       // 화면에서 추출된 텍스트 (탭 제목 등)
  contentDescription: string | null;
  timestamp: number;           // Unix epoch ms
}

export interface AccessibilityServiceStatus {
  isEnabled: boolean;         // 설정에서 서비스 활성화 여부
  isRunning: boolean;         // 서비스 실제 실행 여부
}

// ── 플러그인 인터페이스 ───────────────────────────────────

export interface AccessibilityPluginInterface {
  /**
   * AccessibilityService 활성화 상태 확인
   */
  getServiceStatus(): Promise<AccessibilityServiceStatus>;

  /**
   * 접근성 설정 페이지로 이동 (사용자가 직접 활성화해야 함)
   */
  openAccessibilitySettings(): Promise<void>;

  /**
   * 실시간 접근성 이벤트 리스너 등록
   * → Kotlin 서비스가 이벤트를 감지할 때마다 JS 레이어에 브로드캐스트
   */
  addListener(
    eventName: "accessibilityEvent",
    listenerFunc: (event: AccessibilityEvent) => void
  ): Promise<{ remove: () => Promise<void> }>;

  /**
   * 특정 앱의 현재 화면 텍스트 즉시 조회 (폴링 방식)
   */
  getCurrentScreenText(options: {
    packageName: string;
  }): Promise<{ text: string }>;

  /**
   * 앱이 꺼져 있을 때 네이티브 버퍼에 쌓인 이벤트들을 가져옴 (peek, 버퍼는 비우지 않음).
   * upToSeq는 반환된 이벤트들 중 가장 큰 시퀀스 ID. 반환된 이벤트를 SQLite에
   * 안전하게 커밋한 뒤 그 upToSeq 값 그대로 confirmFlush()를 호출해야 버퍼에서
   * 제거된다 -- 그렇지 않으면 다음 플러시 주기에 동일 이벤트가 다시 반환된다.
   */
  flushBufferedEvents(): Promise<{ events: string; upToSeq: number }>;

  /**
   * flushBufferedEvents()로 받아 SQLite에 성공적으로 커밋한 이벤트들의 upToSeq
   * (해당 응답에서 받은 값 그대로) 이하인 이벤트만 네이티브 버퍼에서 제거.
   * 개수(count)가 아니라 이벤트 자신의 시퀀스 ID로 식별하므로, 그 사이 네이티브
   * 쪽에서 새 이벤트가 추가되거나 용량 제한으로 오래된 항목이 evict되어도 항상
   * 정확한 이벤트만 지워진다. 커밋에 실패했다면 호출하지 않아야 다음 주기에 재시도된다.
   */
  confirmFlush(options: { upToSeq: number }): Promise<void>;

  /**
   * 네이티브 레벨의 커스텀 노이즈 필터 패키지 목록을 업데이트
   */
  updateNoiseFilters(options: { packages: string[] }): Promise<void>;
}

// ── 플러그인 등록 ─────────────────────────────────────────
const AccessibilityPlugin = registerPlugin<AccessibilityPluginInterface>(
  "AccessibilityPlugin",
  {
    web: () =>
      import("./mocks/AccessibilityMock").then((m) => new m.AccessibilityMock()),
  }
);

export default AccessibilityPlugin;
