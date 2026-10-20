/**
 * 공용 기록 조회 실행 모듈 (lib/queryRun.ts)
 * AskPanel(카드 UI)과 Terminal(텍스트 명령)이 동일한 컨텍스트 로딩 및 질의 실행 파이프라인을 공유한다.
 */

import type { SqlAdapter, NlQueryResult } from "./nlsearch";
import { executeNlQuery } from "./nlsearch";
import { type QueryRequest, type Checked, validateRequest, toFilter } from "./query";
import { loadQueryCandidates, type QueryCandidates, type TagRow } from "./queryCandidates";
import { GEOFENCES_SQL } from "./rematch";
import { loadDongs, dongAt, type Dong } from "./dong";
import { loadAppLabels } from "./appLabels";
import { resolveAppName } from "./processor/utils";

export type QueryRunContext = {
  candidates: QueryCandidates;
  dongAt?: (lat: number, lng: number) => string | null;
};

/**
 * DB에서 후보(QueryCandidates)와 행정동 판정 함수(dongAt)를 한 번에 로드.
 * AskPanel 마운트/갱신 시와 터미널 명령 실행 시 공용으로 호출한다.
 */
export async function loadQueryContext(db: SqlAdapter): Promise<QueryRunContext> {
  const gfRes = await db.query(GEOFENCES_SQL);
  const geofences = (gfRes.values ?? []) as any[];

  const tagsRes = await db.query("SELECT * FROM contact_tags ORDER BY id ASC");
  const tags = (tagsRes.values ?? []) as TagRow[];

  // 행정동 로드
  let dongAtFn: ((lat: number, lng: number) => string | null) | undefined;
  try {
    const dongs = await loadDongs();
    if (dongs) {
      dongAtFn = (lat: number, lng: number) => dongAt(dongs, lat, lng);
    }
  } catch (e) {
    console.warn("[queryRun] loadDongs error:", e);
  }

  // 앱 패키지 및 라벨 비동기 로드
  try {
    const pkgsRes = await db.query(
      "SELECT DISTINCT app_package FROM commits WHERE event_type = 'APP_USAGE' AND app_package IS NOT NULL"
    );
    const pkgs = (pkgsRes.values ?? []).map((r: any) => String(r.app_package)).filter(Boolean);
    await loadAppLabels(pkgs);
  } catch (e) {
    console.warn("[queryRun] loadAppLabels error:", e);
  }

  const candidates = await loadQueryCandidates(db, {
    geofences,
    tags,
    dongAt: dongAtFn,
    appLabel: resolveAppName,
  });

  return { candidates, dongAt: dongAtFn };
}

/**
 * 정형화된 요청(QueryRequest)을 검증 -> 필터 변환 -> executeNlQuery로 실행.
 * 실패 시 { ok: false, reason: "..." }를 반환하고, 성공 시 { ok: true, value: NlQueryResult }를 반환한다.
 */
export async function runQuery(
  req: QueryRequest,
  db: SqlAdapter,
  qctx: QueryRunContext
): Promise<Checked<NlQueryResult>> {
  const valCheck = validateRequest(req);
  if (!valCheck.ok) return valCheck;

  const ctx = { people: qctx.candidates.people };
  const filterCheck = toFilter(req, ctx);
  if (!filterCheck.ok) return filterCheck;

  const result = await executeNlQuery(filterCheck.value, db, {
    people: ctx.people,
    dongAt: qctx.dongAt,
  });

  return { ok: true, value: result };
}
