import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { locationHint } from "@/lib/rematch";
import { generateCommitId, closePreviousCommit } from "../utils";

import { resolveContactTagForProcessor } from "@/lib/tagManager";

export class CallLogStrategy implements CommitProcessorStrategy {
  eventType = "CALL" as const;

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
      console.warn("[CallLogStrategy] JSON parse failed:", e);
    }

    const phoneNumber = raw.phoneNumber || "Unknown Number";
    const contactName = raw.contactName || null;
    const callType = raw.callType || "INCOMING"; // INCOMING, OUTGOING, MISSED, REJECTED
    const durationSec = raw.durationSec || 0;

    // ── 1. 연락처 태그 매핑 및 이름 치환 (번호 일치 우선, 번호 일치 시에만 이름 치환) ──
    const tagRes = await db.query("SELECT * FROM contact_tags ORDER BY id ASC");
    const { authorTag, resolvedName } = resolveContactTagForProcessor(
      phoneNumber,
      contactName,
      tagRes.values || []
    );

    // previous commit: only an open-ended APP_USAGE is extended to this event (lib/processor/utils.ts)
    await closePreviousCommit(db, lastCommitCache, event.started_at);

    const commitId = generateCommitId();
    const branchId = 4; // feature/sns (또는 feature/call)
    
    // 통화 종류 한글 라벨링
    const typeLabels: Record<string, string> = {
      INCOMING: "수신 통화",
      OUTGOING: "발신 통화",
      MISSED: "부재중 통화",
      REJECTED: "거절된 통화"
    };
    const typeLabel = typeLabels[callType] || "통화";

    // subject 예: "call: 박준호와 발신 통화 (3분 20초) @ Home"
    // 연락처 이름이 있으면 이름을, 없으면 전화번호를 그대로 표시 (개인용 자기 기록 앱이므로
    // 본인 통화 상대 번호를 스스로에게 마스킹할 필요는 없다고 판단)
    const displayName = resolvedName ? resolvedName : phoneNumber;
    const durationText = durationSec > 0 ? ` (${Math.floor(durationSec / 60)}분 ${durationSec % 60}초)` : "";
    const hint = locationHint(context.geofenceName);
    const subject = `call: ${displayName} ${typeLabel}${durationText}${hint}`;

    const commitPayload = {
      id: commitId,
      branch_id: branchId,
      subject,
      body: JSON.stringify({ phoneNumber, contactName, callType, durationSec }),
      author_tag: authorTag,
      started_at: event.started_at,
      ended_at: event.started_at + (durationSec * 1000), // 통화 시간만큼 종료 시점 연장
      duration_sec: durationSec || 1,
      app_package: event.app_package || "com.android.dialer",
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
