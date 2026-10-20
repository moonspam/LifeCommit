import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { locationHint } from "@/lib/rematch";
import { generateCommitId, closePreviousCommit } from "../utils";

import { resolveContactTagForProcessor } from "@/lib/tagManager";
import { normalizePhone } from "@/lib/people";

export class SmsStrategy implements CommitProcessorStrategy {
  eventType = "SMS" as const;

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
      console.warn("[SmsStrategy] JSON parse failed:", e);
    }

    const phoneNumber = raw.phoneNumber || "Unknown";
    const contactName = raw.contactName || null;
    const callType = raw.callType || "INCOMING"; // INCOMING 또는 OUTGOING
    const body = raw.body || "";

    // ── 1. 연락처 태그 매핑 및 이름 치환 (번호 일치 우선, 번호 일치 시에만 이름 치환) ──
    const tagRes = await db.query("SELECT * FROM contact_tags ORDER BY id ASC");
    const { authorTag, resolvedName } = resolveContactTagForProcessor(
      phoneNumber,
      contactName,
      tagRes.values || []
    );

    // SMS 방향 라벨링
    const dirLabel = callType === "INCOMING" ? "수신" : "발신";
    // 연락처 이름이 있으면 이름을, 없으면 전화번호를 그대로 표시 (개인용 자기 기록 앱이므로
    // 본인 문자 상대 번호를 스스로에게 마스킹할 필요는 없다고 판단)
    const displayName = resolvedName ? resolvedName : phoneNumber;

    // ── 2. 동일 발신자 5분 이내 연속 SMS 수신 시 기존 커밋에 병합(Squash) ──
    // 비어 있지 않은 정규화 전화번호(normalizePhone) 일치만으로 병합 (이름 기반 병합 금지: 동명이인 분리)
    if (lastCommitCache && lastCommitCache.event_type === "SMS") {
      let prevPhone = "";
      try {
        prevPhone = JSON.parse(lastCommitCache.body || "{}").phoneNumber || "";
      } catch {}

      const normCurrentPhone = phoneNumber ? normalizePhone(phoneNumber) : "";
      const normPrevPhone = prevPhone ? normalizePhone(prevPhone) : "";
      const isSamePhone = !!normCurrentPhone && normCurrentPhone === normPrevPhone;

      const gap = event.started_at - lastCommitCache.ended_at;
      if (gap < 300000 && isSamePhone) {
        const newEndedAt = Math.max(lastCommitCache.ended_at, event.started_at);
        const newDuration = Math.max(1, Math.floor((newEndedAt - lastCommitCache.started_at) / 1000));
        const bodyPreview = body.length > 20 ? body.substring(0, 20) + "..." : body;
        const hint = locationHint(context.geofenceName);
        const subject = `sms: ${displayName} ${dirLabel} "${bodyPreview}"${hint}`;

        await db.run(
          `UPDATE commits SET ended_at = ?, duration_sec = ?, subject = ?, body = ? WHERE id = ?`,
          [newEndedAt, newDuration, subject, JSON.stringify({ phoneNumber, contactName, callType, body }), lastCommitCache.id],
          false
        );

        return {
          shouldCreateNew: false,
          updatedCommitId: lastCommitCache.id,
        };
      }
    }

    // ── 이전 커밋 종료 처리 (5분 이상 공백이면 마지막 시점에서 바로 닫음) ──
    // previous commit: only an open-ended APP_USAGE is extended to this event (lib/processor/utils.ts)
    await closePreviousCommit(db, lastCommitCache, event.started_at);

    const commitId = generateCommitId();
    const branchId = 4; // feature/sns 브랜치

    // 본문 미리보기 (20자 제한)
    const bodyPreview = body.length > 20 ? body.substring(0, 20) + "..." : body;
    const hint = locationHint(context.geofenceName);
    const subject = `sms: ${displayName} ${dirLabel} "${bodyPreview}"${hint}`;

    const commitPayload = {
      id: commitId,
      branch_id: branchId,
      subject,
      body: JSON.stringify({ phoneNumber, contactName, callType, body }),
      author_tag: authorTag,
      started_at: event.started_at,
      ended_at: event.started_at,
      duration_sec: 1, // 시점 이벤트
      app_package: event.app_package || "com.android.mms",
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
