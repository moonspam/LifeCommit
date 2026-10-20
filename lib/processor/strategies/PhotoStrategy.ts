import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { locationHint } from "@/lib/rematch";
import { generateCommitId, closePreviousCommit } from "../utils";

export class PhotoStrategy implements CommitProcessorStrategy {
  eventType = "PHOTO" as const;

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
      console.warn("[PhotoStrategy] JSON parse failed:", e);
    }

    const photoUri = raw.photoUri || "";
    const fileName = raw.fileName || "unknown_photo.jpg";

    // ── 1. 사진 병합(Squashing) 로직 ──
    // 직전 커밋이 PHOTO이고, 10분 이내이며, 장소가 동일하면 합친다.
    if (
      lastCommitCache &&
      lastCommitCache.event_type === "PHOTO" &&
      event.started_at - lastCommitCache.ended_at <= 10 * 60 * 1000 &&
      lastCommitCache.geofence_name === context.geofenceName
    ) {
      let photos: any[] = [];
      try {
        const parsedBody = JSON.parse(lastCommitCache.body || "{}");
        if (Array.isArray(parsedBody.photos)) {
          photos = parsedBody.photos;
        } else if (parsedBody.photoUri) {
          photos = [parsedBody];
        }
      } catch (e) {}

      photos.push({ photoUri, fileName });

      const hint = locationHint(context.geofenceName);
      const newSubject = `photo: 사진 촬영 (${photos.length}장)${hint}`;
      const newBody = JSON.stringify({ photos });
      const newEndedAt = event.started_at;
      const newDuration = Math.max(1, Math.floor((newEndedAt - lastCommitCache.started_at) / 1000));

      await db.run(
        `UPDATE commits SET subject = ?, body = ?, ended_at = ?, duration_sec = ? WHERE id = ?`,
        [newSubject, newBody, newEndedAt, newDuration, lastCommitCache.id]
      );

      return {
        shouldCreateNew: false,
        updatedCommitId: lastCommitCache.id
      };
    }

    // previous commit: only an open-ended APP_USAGE is extended to this event (lib/processor/utils.ts)
    await closePreviousCommit(db, lastCommitCache, event.started_at);

    // ── 3. 새 커밋 생성 ──
    const commitId = generateCommitId();
    const branchId = 3; // feature/media

    const hint = locationHint(context.geofenceName);
    const subject = `photo: 사진 촬영 (${fileName})${hint}`;

    const commitPayload = {
      id: commitId,
      branch_id: branchId,
      subject,
      body: JSON.stringify({ photos: [{ photoUri, fileName }] }),
      author_tag: null,
      started_at: event.started_at,
      ended_at: event.started_at,
      duration_sec: 1, // 시점 이벤트
      app_package: "com.android.camera2",
      event_type: this.eventType,
      geofence_name: context.geofenceName,
      lat: context.lat,
      lng: context.lng,
      created_at: Date.now()
    };

    return {
      shouldCreateNew: true,
      commitPayloads: [commitPayload]
    };
  }
}
