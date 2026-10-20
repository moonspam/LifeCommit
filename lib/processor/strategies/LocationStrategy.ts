import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { generateCommitId, LOCATION_GAP_MS, closePreviousCommit } from "../utils";
import { haversineDistance, matchGeofence } from "@/lib/geo";
import { locationSubject } from "@/lib/rematch";

export class LocationStrategy implements CommitProcessorStrategy {
  eventType = "LOCATION" as const;

  async process(
    db: SQLiteDBConnection,
    event: DBRawEvent,
    lastCommitCache: any,
    context: ProcessorContext
  ) {
    let raw: any = {};
    try {
      raw = JSON.parse(event.raw_data);
    } catch (e) {
      console.warn("[LocationStrategy] JSON parse failed:", e);
    }

    // raw_data에서 좌표 추출 (연산자 우선순위 버그 수정)
    const lat = raw.lat ?? 0;
    const lng = raw.lng ?? (raw.lon ?? 0);
    const accuracy = raw.accuracy || 0;

    // 지오펜스 매칭: 이 이벤트 자기 좌표로 판정 (한 배치에 A→B 이동이 있어도 A 커밋엔 A)
    // ponytail: 다른 이벤트 종류(앱 사용 등)는 좌표가 없어 배치의 최신 위치 기준 그대로 — 한 배치 안 이동이면 부정확할 수 있음
    const geofenceName: string | null = matchGeofence(lat, lng, context.geofences)?.name ?? null;

    // 이전 커밋이 동일한 위치(예: 150m 이내)에 머무는 중인지 확인
    if (lastCommitCache && lastCommitCache.event_type === this.eventType) {
      const prevLat = lastCommitCache.lat;
      const prevLng = lastCommitCache.lng;

      if (prevLat !== null && prevLng !== null) {
        const dist = haversineDistance(prevLat, prevLng, lat, lng);
        
        // 150m 이내면 동일한 "머무름(Stationary)"으로 간주하고 커밋을 종료시점을 갱신
        if (dist <= 150 && event.started_at - lastCommitCache.ended_at <= LOCATION_GAP_MS) { // a longer gap: collection stopped
          const mergeEndedAt = event.started_at;
          const newDuration = Math.max(1, Math.floor((mergeEndedAt - lastCommitCache.started_at) / 1000));
          
          await db.run(
            `UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?`,
            [mergeEndedAt, newDuration, lastCommitCache.id]
          );

          return {
            shouldCreateNew: false,
            updatedCommitId: lastCommitCache.id
          };
        }
      }
    }

    // ── 새로운 위치 커밋 생성 ──
    // previous commit: only an open-ended APP_USAGE is extended to this event (lib/processor/utils.ts)
    await closePreviousCommit(db, lastCommitCache, event.started_at);

    const commitId = generateCommitId();
    const branchId = 2; // feature/transit (또는 feature/web와 병합해서 임시 사용)

    // subject 결정
    // registered place > administrative dong (offline, preloaded by lib/processor.ts; null without it) > coordinates (in body)
    const subject = locationSubject(geofenceName, lat, lng);

    const commitPayload = {
      id: commitId,
      branch_id: branchId,
      subject,
      body: JSON.stringify({ lat, lng, accuracy }),
      author_tag: null,
      started_at: event.started_at,
      ended_at: event.started_at,
      duration_sec: 1,
      app_package: "system.location",
      event_type: this.eventType,
      geofence_name: geofenceName,
      lat,
      lng,
      created_at: Date.now()
    };

    return {
      shouldCreateNew: true,
      commitPayloads: [commitPayload]
    };
  }
}
