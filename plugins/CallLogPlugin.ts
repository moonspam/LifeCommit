/**
 * CallLogPlugin - 통화 기록 및 SMS 읽기 플러그인 인터페이스
 *
 * Android READ_CALL_LOG, READ_SMS 권한을 사용하여
 * 통화 기록과 SMS 메시지를 읽음.
 * contact_tags 테이블과 연동하여 #family 등 태그를 부착.
 * 실제 Kotlin 구현은 Phase 3에서 진행.
 */

import { registerPlugin } from "@capacitor/core";

// ── 타입 정의 ─────────────────────────────────────────────

export type CallType = "INCOMING" | "OUTGOING" | "MISSED" | "REJECTED";

export interface CallLogEntry {
  id: string;
  contactName: string | null;    // 주소록 이름 (null = 미등록 번호)
  phoneNumber: string;           // E.164 포맷 권장
  callType: CallType;
  durationSec: number;           // 통화 시간 (초)
  timestamp: number;             // 통화 시작 Unix epoch ms
  resolvedTag: string | null;    // contact_tags에서 조회된 태그
}

export interface SmsEntry {
  id: string;
  address: string;               // 발신/수신 전화번호
  contactName: string | null;
  body: string;                  // SMS 내용 (개인정보 - 암호화 DB에만 저장)
  type: "INBOX" | "SENT";
  timestamp: number;
  resolvedTag: string | null;
}

export interface GetCallLogsOptions {
  afterTimestamp?: number;       // 이후 로그만 (증분 조회)
  limit?: number;                // 최대 건수 (기본 100)
  offset?: number;               // 페이지네이션 오프셋 (기본 0)
}

export interface GetCallLogsResult {
  calls: CallLogEntry[];
}

export interface GetSmsOptions {
  afterTimestamp?: number;
  limit?: number;
  offset?: number;                // 페이지네이션 오프셋 (기본 0)
}

export interface GetSmsResult {
  messages: SmsEntry[];
}

export interface CallEvent {
  type: "CALL_STARTED" | "CALL_ENDED";
  phoneNumber: string;
  contactName: string | null;
  resolvedTag: string | null;
  timestamp: number;
}

// ── 플러그인 인터페이스 ───────────────────────────────────

export interface CallLogPluginInterface {
  /**
   * READ_CALL_LOG 권한 확인
   */
  hasCallLogPermission(): Promise<{ granted: boolean }>;

  /**
   * READ_SMS 권한 확인
   */
  hasSmsPermission(): Promise<{ granted: boolean }>;

  /**
   * Capacitor 권한 관리 표준 API
   */
  checkPermissions(): Promise<{ callLog: string; sms: string }>;
  requestPermissions(options?: { permissions: string[] }): Promise<{ callLog: string; sms: string }>;

  /**
   * 통화 기록 조회
   */
  getCallLogs(options?: GetCallLogsOptions): Promise<GetCallLogsResult>;

  /**
   * SMS 조회
   */
  getSms(options?: GetSmsOptions): Promise<GetSmsResult>;

  /**
   * 주소록 연락처 목록 조회 (READ_CONTACTS 권한)
   */
  listContacts(): Promise<{ contacts: { name: string; phone: string }[] }>;

  /**
   * 실시간 통화 시작/종료 이벤트 리스너
   * (PhoneStateListener 기반)
   */
  addListener(
    eventName: "callStateChanged",
    listenerFunc: (event: CallEvent) => void
  ): Promise<{ remove: () => Promise<void> }>;

  /**
   * 실시간 SMS 수신 이벤트 리스너
   */
  addListener(
    eventName: "smsReceived",
    listenerFunc: (message: SmsEntry) => void
  ): Promise<{ remove: () => Promise<void> }>;
}

// ── 플러그인 등록 ─────────────────────────────────────────
const CallLogPlugin = registerPlugin<CallLogPluginInterface>("CallLogPlugin", {
  web: () =>
    import("./mocks/CallLogMock").then((m) => new m.CallLogMock()),
});

export default CallLogPlugin;
