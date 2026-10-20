import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { generateCommitId, closePreviousCommit } from "../utils";

export class ReplyStrategy implements CommitProcessorStrategy {
  eventType = "REPLY" as const;

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
      console.warn("[ReplyStrategy] JSON parse failed:", e);
    }

    const sender = raw.sender || "알 수 없음";
    const receivedMsg = raw.receivedMsg || "이전 대화";
    const replyMsg = raw.replyMsg || "";

    // 1. 중복 방지: 직전 커밋이 같은 앱·같은 대화(sender, receivedMsg)의 같은 답장이고 60초 이내인 경우만 같은 답장
    //    (앱이나 받은 메시지가 다르면 다른 대화: 따로 기록)
    if (lastCommitCache && lastCommitCache.event_type === "REPLY" && lastCommitCache.app_package === event.app_package) {
      try {
        const lastBody = JSON.parse(lastCommitCache.body || "{}");
        if (
          lastBody.sender === sender &&
          lastBody.receivedMsg === receivedMsg &&
          lastBody.replyMsg === replyMsg &&
          event.started_at - lastCommitCache.ended_at < 60000
        ) {
          // 60초 내 동일 답장은 시간만 연장하고 새 커밋 생성 안함
          await db.run(
            `UPDATE commits SET ended_at = ? WHERE id = ?`,
            [event.started_at, lastCommitCache.id]
          );
          return {
            shouldCreateNew: false,
            updatedCommitId: lastCommitCache.id,
          };
        }
      } catch {}
    }

    // 2. 이전 커밋 종료 처리 (5분 이상 공백이면 마지막 시점에서 바로 닫음)
    // previous commit: only an open-ended APP_USAGE is extended to this event (lib/processor/utils.ts)
    await closePreviousCommit(db, lastCommitCache, event.started_at);

    const commitId = generateCommitId();
    const branchId = 4; // feature/sns 브랜치에 매핑

    // 수신 메시지가 너무 길면 요약
    const shortReceived = receivedMsg.length > 20 ? receivedMsg.substring(0, 20) + "..." : receivedMsg;
    const subject = `reply: [${sender}] "${shortReceived}" → ${replyMsg}`;

    const commitPayload = {
      id: commitId,
      branch_id: branchId,
      subject,
      body: JSON.stringify({ sender, receivedMsg, replyMsg, packageName: event.app_package }),
      author_tag: null,
      started_at: event.started_at,
      ended_at: event.started_at,
      duration_sec: 1, // 시점 이벤트
      app_package: event.app_package,
      event_type: this.eventType,
      geofence_name: context.geofenceName,
      lat: context.lat,
      lng: context.lng,
      created_at: Date.now(),
    };

    return {
      shouldCreateNew: true,
      commitPayloads: [commitPayload],
    };
  }
}
