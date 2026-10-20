import { executeInTransaction } from "./db";
import { processBatch } from "./processBatch";
import { loadDongs } from "./dong";
import { rematchOnStartup } from "./rematch";
import { restoreSquashedLocationsOnStartup } from "./restoreLocations";
import { emit, EVENT_COMMITS_UPDATED } from "./events";
import { getFlavor } from "./flavor";

/**
 * 처리되지 않은 raw_events를 읽어서 commits 테이블에 논리적으로 묶어넣습니다. (전략 패턴 적용)
 */
export async function processRawEventsBatch(): Promise<number> {
  try {
    await loadDongs(); // outside the write lock: location titles only read the loaded boundaries inside it
    // 기존 DB 보정(표시는 app_settings, 있으면 쿼리 1번): 같은 직렬 큐 트랜잭션. 실패·미완료여도 수집 처리는 계속, 다음 주기에 재시도
    const isOss = (await getFlavor()) === "oss";
    const { changed: rematchChanged } = await rematchOnStartup(
      (fn) => executeInTransaction(fn, { requireTransaction: true }),
      isOss
    );
    if (rematchChanged > 0) emit(EVENT_COMMITS_UPDATED);

    // LOC-ETC A 버그로 과도하게 합쳐진 위치 커밋 1회 복구 (동 로드 후, processBatch 전)
    const { changed: restoreChanged } = await restoreSquashedLocationsOnStartup(
      (fn) => executeInTransaction(fn, { requireTransaction: true })
    );
    if (restoreChanged > 0) emit(EVENT_COMMITS_UPDATED);

    return await executeInTransaction((d) => processBatch(d), { requireTransaction: true });
  } catch (err) {
    console.error("Failed to process raw events:", err);
    return 0;
  }
}
