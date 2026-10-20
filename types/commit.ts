// ===========================
// 브랜치 타입
// ===========================

export type BranchType = "main" | "feature/web" | "feature/media" | "feature/sns" | "feature/work" | "feature/life" | "feature/etc" | "feature/system" | "feature/game";

export interface Branch {
  id: number;
  name: BranchType | string;
  color: string;
  createdAt: number; // Unix epoch ms
}

// ===========================
// 커밋 타입 (Squashed Commit)
// ===========================

export type EventType = "APP_USAGE" | "CALL" | "SMS" | "LOCATION" | "NOTIFICATION" | "PHOTO" | "REPLY" | "MERGE" | "MANUAL" | "manual";

/** Auto-Squash 시 내부에 병합된 단위 이벤트 */
export interface SquashedEvent {
  pkg: string;          // 앱 패키지 (com.android.chrome)
  durationSec: number;  // 해당 삽입 이벤트 지속 시간(초)
  note?: string;        // 보조 텍스트 (Accessibility 추출 내용 등)
  eventType: EventType;
}

// ===========================
// 세부 이벤트 데이터 인터페이스
// ===========================

export interface SmsBody {
  phoneNumber: string;
  contactName?: string | null;
  callType: "INCOMING" | "OUTGOING";
  body: string;
}

export interface CallBody {
  phoneNumber: string;
  contactName?: string | null;
  callType: "INCOMING" | "OUTGOING" | "MISSED" | "REJECTED";
  durationSec: number;
}

export interface ReplyBody {
  sender?: string;
  receivedMsg?: string;
  replyMsg?: string;
  packageName?: string;
}

export interface PhotoItem {
  photoUri: string;
  fileName: string;
}

export interface PhotoBody {
  photoUri?: string;
  fileName?: string;
  photos?: PhotoItem[];
}

export interface LocationBody {
  lat: number;
  lng: number;
  accuracy?: number;
  activityType?: string;
}

/** DB의 commits 테이블 매핑 */
export interface Commit {
  id: string;                         // SHA-like UUID
  branchId: number;
  parentId: string | null;
  subject: string;                    // "feat: Chrome - iluku blog 읽기"
  body: string | null;
  authorTag: string | null;           // '#family', '#work'
  startedAt: number;                  // Unix epoch ms
  endedAt: number;
  durationSec: number;
  appPackage: string | null;
  eventType: EventType;
  squashedEvents: SquashedEvent[];    // JSON 파싱 후
  geofenceName: string | null;
  lat: number | null;
  lng: number | null;
  createdAt: number;
}

// ===========================
// Raw Event (Staging Area)
// ===========================

export interface RawEvent {
  id?: number;
  eventType: EventType;
  appPackage: string | null;
  rawData: Record<string, unknown>;  // 이벤트 원본 JSON
  startedAt: number;
  endedAt: number | null;            // null = 진행 중
  isProcessed: 0 | 1 | 2;           // 0=대기, 1=커밋변환, 2=필터링
}

// ===========================
// 연락처 태그
// ===========================

export interface ContactTag {
  id?: number;
  contactName: string;
  tag: string;                        // '#family', '#work'
  phoneNumber?: string;
}

// ===========================
// 지오펜스
// ===========================

export interface Geofence {
  id?: number;
  name: string;                       // '🏠 Home'
  lat: number;
  lng: number;
  radiusM: number;
  branchTrigger: string;              // 기본 'main'
}

// ===========================
// Git-Graph 렌더링용 타입
// ===========================

export interface GraphNode {
  commit: Commit;
  branch: Branch;
  x: number;  // D3 렌더링 좌표
  y: number;
}

export interface GraphEdge {
  from: string; // commit id
  to: string;   // commit id
  branch: Branch;
}

// ===========================
// FTS5 검색 결과
// ===========================

export interface SearchResult {
  commitId: string;
  subject: string;
  snippet: string;   // FTS5 snippet() 함수 결과
  rank: number;
}
