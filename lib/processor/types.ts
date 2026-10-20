import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { EventType } from "@/types/commit";

export interface DBRawEvent {
  id: number;
  event_type: string; // "APP_USAGE", "CALL", "SMS", "LOCATION", "PHOTO" 등
  app_package: string | null;
  raw_data: string;
  started_at: number;
  ended_at: number | null;
  is_processed: number;
}

export interface ProcessorContext {
  lat: number | null;
  lng: number | null;
  geofenceName: string | null;
  /** 장소 목록(id 순). LOCATION 이벤트가 자기 좌표로 판정하는 데 쓴다. */
  geofences: any[];
}

export interface CommitProcessorStrategy {
  eventType: EventType;
  
  /**
   * 개별 raw_event를 처리하여 커밋 생성 여부를 판단합니다.
   * @param db SQLiteDBConnection 커넥션
   * @param event 가공할 raw_event 데이타
   * @param lastCommitCache 현재까지 가공 중 캐시된 가장 최신 커밋 (병합/이전 커밋 종료 시 활용)
   * @param context 위치 등의 공통 콘텍스트
   */
  process(
    db: SQLiteDBConnection,
    event: DBRawEvent,
    lastCommitCache: any,
    context: ProcessorContext
  ): Promise<{
    shouldCreateNew: boolean;
    commitPayloads?: {
      id: string;
      branch_id: number;
      subject: string;
      body?: string | null;
      author_tag?: string | null;
      started_at: number;
      ended_at: number;
      duration_sec: number;
      app_package: string | null;
      event_type: string;
      geofence_name: string | null;
      lat: number | null;
      lng: number | null;
      created_at: number;
      squashed_events?: string | null;
    }[];
    updatedCommitId?: string;
  }>;
}
