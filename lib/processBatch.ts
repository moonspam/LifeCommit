/**
 * One processing batch. Every read that decides a write (pending events, branch overrides, last commit, latest
 * location, geofences, the noise filter) happens on `d`, inside the caller's transaction, so a filter save or delete
 * cannot slip between reading an event and committing it. Pure of Capacitor so a real-SQLite check can run it.
 */
import type { SQLiteDBConnection } from "@capacitor-community/sqlite";
import type { DBRawEvent, CommitProcessorStrategy, ProcessorContext } from "./processor/types";
import { AppUsageStrategy } from "./processor/strategies/AppUsageStrategy";
import { CallLogStrategy } from "./processor/strategies/CallLogStrategy";
import { LocationStrategy } from "./processor/strategies/LocationStrategy";
import { PhotoStrategy } from "./processor/strategies/PhotoStrategy";
import { ReplyStrategy } from "./processor/strategies/ReplyStrategy";
import { SmsStrategy } from "./processor/strategies/SmsStrategy";
import { loadAppBranchOverrides, applyProcessResult } from "./processor/utils";
import { noisePackages } from "./filters";
import { readSetting, NOISE_FILTER_SETTING } from "./settings";
import { matchGeofence } from "./geo";
import { GEOFENCES_SQL } from "./rematch";

// ── 전략 맵 등록 ──
const strategies: Record<string, CommitProcessorStrategy> = {
  "APP_USAGE": new AppUsageStrategy(),
  "CALL": new CallLogStrategy(),
  "SMS": new SmsStrategy(),
  "LOCATION": new LocationStrategy(),
  "PHOTO": new PhotoStrategy(),
  "REPLY": new ReplyStrategy(),
};

/** Processed raw events keep their content this long (dedup of a re-flushed native buffer needs only minutes). */
export const RAW_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Deletes processed raw events older than RAW_RETENTION_MS (since processing), so a deleted record's original - an SMS
 * body, a reply, coordinates - leaves the app DB within 7 days. The latest row of each event type stays as the sync
 * cursor (CALL/SMS/PHOTO resume from MAX(started_at); without it they would re-import everything since install), with
 * its content redacted: the native queries use "> cursor", so the marker itself is never fetched or deduplicated again.
 */
export async function purgeRawEvents(d: SQLiteDBConnection, now: number): Promise<void> {
  const cutoff = now - RAW_RETENTION_MS;
  const markers = "(event_type, started_at) IN (SELECT event_type, MAX(started_at) FROM raw_events GROUP BY event_type)";
  await d.run(`DELETE FROM raw_events WHERE is_processed = 1 AND processed_at < ? AND NOT ${markers}`, [cutoff], false);
  await d.run(`UPDATE raw_events SET raw_data = '{}' WHERE is_processed = 1 AND processed_at < ? AND raw_data <> '{}'`, [cutoff], false);
}

export async function processBatch(d: SQLiteDBConnection): Promise<number> {
  const now = Date.now();
  // first, so it also runs when nothing new arrived (every sync round calls this at least once); rows this batch
  // processes get processed_at = now and are not affected
  await purgeRawEvents(d, now);
  await loadAppBranchOverrides(d);
  const res = await d.query(
    "SELECT * FROM raw_events WHERE is_processed = 0 ORDER BY started_at ASC LIMIT 500"
  );
  const events: DBRawEvent[] = res.values || [];

  if (events.length === 0) return 0;

  // 1. 위치 정보 수집 (배터리 최적화: GPS 하드웨어를 직접 호출하지 않고 네이티브 서비스가 수집한 DB 내 최신 위치 활용)
  let lat: number | null = null;
  let lng: number | null = null;
  let geofenceName: string | null = null;
  const geofences: any[] = (await d.query(GEOFENCES_SQL)).values || [];

  try {
    const lastLocRes = await d.query(
      "SELECT raw_data FROM raw_events WHERE event_type = 'LOCATION' ORDER BY started_at DESC LIMIT 1"
    );
    if (lastLocRes.values && lastLocRes.values.length > 0) {
      const locObj = JSON.parse(lastLocRes.values[0].raw_data);
      lat = locObj.lat ?? null; // a redacted marker (purgeRawEvents) is "{}"
      lng = locObj.lng ?? null;
      if (lat !== null && lng !== null) {
        const matched = matchGeofence(lat, lng, geofences);
        if (matched) {
          geofenceName = matched.name;
        }
      }
    }
  } catch (e) {
    console.warn("[Processor] Failed to fetch latest location event from DB:", e);
  }

  // 2. 노이즈 이벤트 및 유효 이벤트 분리 — 내장 목록 + 저장된 필터(같은 트랜잭션에서 읽음: 필터 저장과 경쟁하지 않음)
  const noise = noisePackages(await readSetting(d, NOISE_FILTER_SETTING));
  const noiseIds = events.filter(ev => noise.has(ev.app_package || "")).map(ev => ev.id);
  const validEvents = events.filter(ev => !noise.has(ev.app_package || ""));

  // 3. 마지막 커밋 1회만 조회 (배치 내에서 캐싱)
  let lastCommitCache: any = null;
  // UsageStats sessions (us:) are written by the usage drain and owned by it: no strategy may extend, close or merge
  // into one (a drain often inserts rows that start after the raw events being processed here)
  const lastRes = await d.query("SELECT * FROM commits WHERE id NOT LIKE 'us:%' ORDER BY started_at DESC LIMIT 1");
  lastCommitCache = lastRes.values && lastRes.values.length > 0 ? lastRes.values[0] : null;

  let processedCount = noiseIds.length;
  const context: ProcessorContext = { lat, lng, geofenceName, geofences };

  // 4. 개별 이벤트 가공 처리 (트랜잭션으로 묶어 고속 I/O 및 안전성 보장)
  // 노이즈 이벤트 일괄 처리
  for (const nid of noiseIds) {
    await d.run(`UPDATE raw_events SET is_processed = 1, processed_at = ? WHERE id = ?`, [now, nid], false);
  }
  for (const ev of validEvents) {
    try {
      const strategy = strategies[ev.event_type];
      if (!strategy) {
        console.warn(`[Processor] Unsupported event type: ${ev.event_type}`);
        await d.run(
          `UPDATE raw_events SET is_processed = 1, processed_at = ?, error_message = ? WHERE id = ?`,
          [now, `no strategy registered for event_type=${ev.event_type}`, ev.id],
          false
        );
        processedCount++;
        continue;
      }

      const result = await strategy.process(d, ev, lastCommitCache, context);

      const applied = await applyProcessResult(d, result, lastCommitCache);
      lastCommitCache = applied.lastCommitCache;

      await d.run(`UPDATE raw_events SET is_processed = 1, processed_at = ? WHERE id = ?`, [now, ev.id], false);
      processedCount++;
    } catch (evErr) {
      console.error(`[Processor] Failed to process event id=${ev.id} type=${ev.event_type}:`, evErr);
      // 실패한 이벤트도 is_processed=1로 표시해 다음 배치를 계속 진행시킨다.
      // (그대로 두면 이 이벤트가 매 배치마다 재조회되어 그 뒤의 모든 신규
      // 이벤트가 영구히 막히므로, 에러 메시지만 남기고 넘어간다.)
      const errMsg = evErr instanceof Error ? evErr.message : String(evErr);
      await d.run(
        `UPDATE raw_events SET is_processed = 1, processed_at = ?, error_message = ? WHERE id = ?`,
        [now, errMsg.slice(0, 500), ev.id],
        false
      );
      processedCount++;
    }
  }

  return processedCount;
}
