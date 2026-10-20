export const APP_NAME_MAP_DATA: Record<string, string> = {
  "com.android.chrome":                         "크롬",
  "com.google.android.youtube":                 "유튜브",
  "com.google.android.gm":                      "지메일",
  "com.google.android.apps.maps":               "구글 지도",
  "com.google.android.apps.photos":             "구글 포토",
  "com.google.android.dialer":                  "전화",
  "com.samsung.android.dialer":                 "전화",
  "com.android.dialer":                         "전화",
  "com.google.android.contacts":                "연락처",
  "com.samsung.android.contacts":               "연락처",
  "com.android.contacts":                       "연락처",
  "com.google.android.calendar":                "캘린더",
  "com.samsung.android.calendar":               "캘린더",
  "com.google.android.keep":                    "Keep 메모",
  "com.samsung.android.app.notes":              "삼성 노트",
  "com.sec.android.app.sbrowser":               "삼성 인터넷",
  "com.samsung.android.messaging":              "메시지",
  "com.google.android.apps.messaging":          "메시지",
  "com.google.android.apps.docs":               "구글 문서",
  "com.google.android.apps.youtube.music":      "유튜브 뮤직",
  "com.google.android.googlequicksearchbox":    "구글 검색",
  "com.kakao.talk":                             "카카오톡",
  "com.instagram.android":                      "인스타그램",
  "com.twitter.android":                        "X (트위터)",
  "com.facebook.katana":                        "페이스북",
  "com.facebook.orca":                          "메신저",
  "com.discord":                                "디스코드",
  "org.telegram.messenger":                     "텔레그램",
  "com.naver.line":                             "라인",
  "com.slack":                                  "슬랙",
  "com.microsoft.teams":                        "팀즈",
  "com.nhn.android.search":                     "네이버",
  "com.nhn.android.nmap":                       "네이버 지도",
  "net.daum.android.map":                       "카카오맵",
  "com.kakaobank.channel":                      "카카오뱅크",
  "com.kakaopay.app":                           "카카오페이",
  "com.coupang.mobile":                         "쿠팡",
  "com.spotify.music":                          "스포티파이",
  "com.netflix.mediaclient":                    "넷플릭스",
  "com.tving.android":                          "티빙",
  "kr.co.wavve.app":                            "웨이브",
  "com.watcha":                                 "왓챠",
  "com.nexon.mabinogi":                         "마비노기",
  "com.nexon.bluearchive":                      "블루 아카이브",
  "com.miHoYo.GenshinImpact":                  "원신",
  "com.notion.id":                              "노션",
  "com.microsoft.office.word":                  "워드",
  "com.microsoft.office.excel":                 "엑셀",
  "com.baemin.android":                         "배달의민족",
  "com.yogiyo.android":                         "요기요",
  "com.android.settings":                       "설정",
  "com.android.camera2":                        "카메라",
  "com.sec.android.app.camera":                 "카메라",
  "com.samsung.android.gallery3d":              "갤러리",
};

export function generateCommitId(): string {
  return crypto.randomUUID();
}

const deviceLabels = new Map<string, string>();

/** Labels read from the device (lib/appLabels.ts); they win over the built-in map and the package-name fallback. */
export function rememberAppLabels(labels: Record<string, string>) {
  for (const [pkg, label] of Object.entries(labels)) if (label && label !== pkg) deviceLabels.set(pkg, label);
}

export const hasAppLabel = (pkg: string) => deviceLabels.has(pkg);

export function resolveAppName(pkg: string): string {
  if (!pkg) return "Unknown App";
  const label = deviceLabels.get(pkg);
  if (label) return label;
  if (APP_NAME_MAP_DATA[pkg]) return APP_NAME_MAP_DATA[pkg];
  const last = pkg.split(".").pop() || pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

const appBranchOverrides = new Map<string, number>();
const branchIds = new Map<string, number>();

export async function loadAppBranchOverrides(db: { query: (sql: string) => Promise<{ values?: any[] }> }) {
  const result = await db.query("SELECT app_package, branch_id FROM app_branch_overrides");
  const branches = await db.query("SELECT id, name FROM branches");
  appBranchOverrides.clear();
  branchIds.clear();
  for (const row of result.values || []) appBranchOverrides.set(row.app_package, row.branch_id);
  for (const row of branches.values || []) branchIds.set(row.name, row.id);
}

const branchId = (name: string, fallback: number) => branchIds.get(name) || fallback;

export function setAppBranchOverride(pkg: string, branchId: number) {
  appBranchOverrides.set(pkg, branchId);
}

export function resolveBranchId(pkg: string): number {
  if (!pkg) return 1;
  const override = appBranchOverrides.get(pkg);
  if (override) return override;
  if (
    pkg.includes("chrome") || pkg.includes("browser") ||
    pkg.includes("whale") || pkg.includes("search") ||
    pkg.includes("naver") || pkg.includes("daum") ||
    pkg.includes("maps") || pkg.includes("whale")
  ) return branchId("feature/web", 2);
  if (
    pkg.includes("youtube") || pkg.includes("netflix") ||
    pkg.includes("tving") || pkg.includes("wavve") ||
    pkg.includes("watcha") || pkg.includes("spotify") ||
    pkg.includes("music") || pkg.includes("nexon") ||
    pkg.includes("miHoYo") || pkg.includes("game") ||
    pkg.includes("pearlabyss")
  ) return branchId("feature/media", 3);
  if (
    pkg.includes("kakao") || pkg.includes("instagram") ||
    pkg.includes("twitter") || pkg.includes("facebook") ||
    pkg.includes("discord") || pkg.includes("telegram") ||
    pkg.includes("line") || pkg.includes("slack") ||
    pkg.includes("teams") || pkg.includes("dialer") ||
    pkg.includes("telecom") || pkg.includes("contacts") || pkg.includes("kakao.talk")
  ) return branchId("feature/sns", 4);
  if (
    pkg.includes("notion") || pkg.includes("office") || pkg.includes("docs") ||
    pkg.includes("calendar") || pkg.includes("keep") || pkg.includes("trello") ||
    pkg.includes("asana") || pkg.includes("zoom")
  ) return branchId("feature/work", 5);
  if (
    pkg.includes("coupang") || pkg.includes("baemin") || pkg.includes("yogiyo") ||
    pkg.includes("bank") || pkg.includes("pay") || pkg.includes("tmap") ||
    pkg.includes("map") || pkg.includes("shopping")
  ) return branchId("feature/life", 6);
  return 1;
}

// ── 데이터 셰이핑 상수 ──
/**
 * Ends the previous commit when a new event starts. Only an APP_USAGE commit is open-ended (the app stays in front
 * until something else happens), so only it is extended to the new event (or closed at its own end after an idle gap).
 * CALL keeps its logged duration; SMS / PHOTO / LOCATION / REPLY / memos keep their own span.
 */
export async function closePreviousCommit(db: { run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown> }, last: any, nextStart: number) {
  if (!last || last.event_type !== "APP_USAGE") return;
  const endedAt = nextStart - last.ended_at > IDLE_THRESHOLD_MS ? last.ended_at : nextStart;
  await db.run(`UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?`,
    [endedAt, Math.max(1, Math.floor((endedAt - last.started_at) / 1000)), last.id], false);
}

// LifeCommit+ location fixes: a still, screen-off phone still reported every 3-10 min on the phone (2026-10-10, no
// distance filter); a longer gap means collection stopped (phone off, accessibility off), so a stay ends there
export const LOCATION_GAP_MS = 15 * 60 * 1000;
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000;    // 5분 이상 공백 → Idle state 삽입
export const MERGE_WINDOW_MS = 5 * 60 * 1000;      // 5분 이내 동일 앱 재접속 → 기존 커밋에 병합
export const SPLIT_THRESHOLD_MS = 15 * 60 * 1000;  // 15분 이상 연속 사용 → 커밋 분할
export const MICRO_COMMIT_SEC = 5;                  // 5초 미만 사용 → 스쿼시 대상

export interface ProcessResultDb {
  run(sql: string, params: unknown[], tx?: boolean): Promise<unknown>;
  query(sql: string, params?: unknown[]): Promise<{ values?: any[] }>;
}

/**
 * Strategy 실행 결과를 받아 INSERT 또는 캐시 갱신을 수행하는 공통 헬퍼 (processBatch & restoreLocations 공유)
 */
export async function applyProcessResult(
  d: ProcessResultDb,
  result: {
    shouldCreateNew: boolean;
    commitPayloads?: any[];
    updatedCommitId?: string;
  },
  lastCommitCache: any,
  tombstones?: Set<string>
): Promise<{ lastCommitCache: any; createdCount: number }> {
  let createdCount = 0;
  if (result.shouldCreateNew && result.commitPayloads && result.commitPayloads.length > 0) {
    for (const payload of result.commitPayloads) {
      let commitId = payload.id;
      if (tombstones) {
        while (tombstones.has(commitId)) {
          commitId = crypto.randomUUID();
        }
      }
      await d.run(
        `INSERT INTO commits (id, branch_id, subject, body, author_tag, started_at, ended_at, duration_sec, app_package, event_type, geofence_name, lat, lng, created_at, squashed_events)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          commitId,
          payload.branch_id,
          payload.subject,
          payload.body || null,
          payload.author_tag || null,
          payload.started_at,
          payload.ended_at,
          payload.duration_sec,
          payload.app_package,
          payload.event_type,
          payload.geofence_name,
          payload.lat,
          payload.lng,
          payload.created_at,
          payload.squashed_events || "[]",
        ],
        false
      );
      createdCount++;
      lastCommitCache = (await d.query("SELECT * FROM commits WHERE id = ?", [commitId])).values?.[0] ?? null;
    }
  } else if (!result.shouldCreateNew && result.updatedCommitId) {
    const freshRes = await d.query("SELECT * FROM commits WHERE id = ?", [result.updatedCommitId]);
    if (freshRes.values && freshRes.values.length > 0) {
      lastCommitCache = freshRes.values[0];
    }
  }
  return { lastCommitCache, createdCount };
}
