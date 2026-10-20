/**
 * 앱 내부 이벤트 버스
 * 컴포넌트 간 데이터 변경 알림을 위한 경량 Pub/Sub 시스템.
 * 폴링(Polling) 대신 이벤트 기반(Event-driven)으로 갱신하여 배터리 소모를 최소화합니다.
 */

type Listener = () => void;

const listeners: Record<string, Set<Listener>> = {};

/** 이벤트 구독. 반환된 함수를 호출하면 구독 해제됩니다. */
export function subscribe(event: string, listener: Listener): () => void {
  if (!listeners[event]) listeners[event] = new Set();
  listeners[event].add(listener);
  return () => { listeners[event]?.delete(listener); };
}

/** 이벤트 발행. 구독자 전원에게 알림을 보냅니다. */
export function emit(event: string): void {
  listeners[event]?.forEach(fn => fn());
}

// ── 이벤트 이름 상수 ──
/** TerminalPanel의 Processor가 새 커밋을 생성했을 때 발행 */
export const EVENT_COMMITS_UPDATED = "commits-updated";
/** usageSync's collection status changed (permission / last failure, Step 6e) */
export const EVENT_USAGE_STATUS = "usage-status";
