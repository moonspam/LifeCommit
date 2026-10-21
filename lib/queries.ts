import { getDB } from "./db";
import { COVERAGE_SQL, coverageParams, parseCoverage } from "./coverage";
import { periodSec, PERIOD_ROWS_SQL, PERIOD_SEC_SQL, periodRowsParams, periodSecParams } from "./periodSec";
import { dayRange, dateKey } from "./today";
import { Commit } from "@/types/commit";
import { Capacitor } from "@capacitor/core";

// ── 웹 UI 테스트용 더미 데이터 ──
const DUMMY_BRANCHES = [
  { id: 1, name: 'main', color: '#f1e05a' },
  { id: 2, name: 'feature/web', color: '#50fa7b' },
  { id: 3, name: 'feature/media', color: '#ff79c6' },
  { id: 4, name: 'feature/sns', color: '#8be9fd' },
  { id: 5, name: 'feature/work', color: '#bd93f9' },
  { id: 6, name: 'feature/life', color: '#ffb86c' },
  { id: 7, name: 'feature/etc', color: '#6272a4' },
  { id: 8, name: 'feature/system', color: '#a0a8b8' },
  { id: 9, name: 'feature/game', color: '#ff5555' },
];

const now = Date.now();
const DUMMY_COMMITS: Commit[] = [
  {
    id: "c1",
    branchId: 1,
    parentId: null,
    subject: "chore: Idle state",
    body: null,
    authorTag: null,
    startedAt: now - 7200000,
    endedAt: now - 6000000,
    durationSec: 1200,
    appPackage: "com.android.launcher",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🏢 Company",
    lat: 35.1151,
    lng: 129.0422,
    createdAt: now
  },
  {
    id: "c2",
    branchId: 2,
    parentId: "c1",
    subject: "feat: Chrome 브라우징",
    body: null,
    authorTag: null,
    startedAt: now - 6000000,
    endedAt: now - 4800000,
    durationSec: 1200,
    appPackage: "com.android.chrome",
    eventType: "APP_USAGE",
    squashedEvents: [
      { pkg: "com.sec.android.app.launcher", durationSec: 3, note: "런처 복귀", eventType: "APP_USAGE" },
      { pkg: "com.android.settings", durationSec: 2, note: "설정 확인", eventType: "APP_USAGE" }
    ],
    geofenceName: "🏢 Company",
    lat: 35.1151,
    lng: 129.0422,
    createdAt: now
  },
  {
    id: "c3",
    branchId: 2,
    parentId: "c2",
    subject: "feat: Chrome 몰입중",
    body: null,
    authorTag: null,
    startedAt: now - 4800000,
    endedAt: now - 3600000,
    durationSec: 1200,
    appPackage: "com.android.chrome",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🏢 Company",
    lat: 35.1151,
    lng: 129.0422,
    createdAt: now
  },
  {
    id: "c4",
    branchId: 1,
    parentId: "c3",
    subject: "merge: Merge 'feature/web' into main",
    body: null,
    authorTag: null,
    startedAt: now - 3600000,
    endedAt: now - 3600000,
    durationSec: 0,
    appPackage: null,
    eventType: "MERGE",
    squashedEvents: [],
    geofenceName: "🏢 Company",
    lat: 35.1151,
    lng: 129.0422,
    createdAt: now
  },
  {
    id: "c5",
    branchId: 1,
    parentId: "c4",
    subject: "chore: Idle state",
    body: null,
    authorTag: null,
    startedAt: now - 3000000,
    endedAt: now - 2700000,
    durationSec: 300,
    appPackage: "com.android.launcher",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🚌 Transit Line 1",
    lat: 36.3325,
    lng: 127.4342,
    createdAt: now
  },
  {
    id: "c6",
    branchId: 4,
    parentId: "c5",
    subject: "sms: 박준호 수신 \"오늘 저녁에 삼겹살 어때?\"",
    body: JSON.stringify({
      phoneNumber: "010-1234-5678",
      contactName: "박준호",
      callType: "INCOMING",
      body: "오늘 저녁에 삼겹살 어때? 마트에서 장보고 들어가는 길이야! 고기 구워 먹자~"
    }),
    authorTag: "#family",
    startedAt: now - 2700000,
    endedAt: now - 2700000,
    durationSec: 1,
    appPackage: "com.android.mms",
    eventType: "SMS",
    squashedEvents: [],
    geofenceName: "🚌 Transit Line 1",
    lat: 36.3325,
    lng: 127.4342,
    createdAt: now
  },
  {
    id: "c7",
    branchId: 4,
    parentId: "c6",
    subject: "call: 박준호 발신 통화 (2분 30초)",
    body: JSON.stringify({
      phoneNumber: "010-1234-5678",
      contactName: "박준호",
      callType: "OUTGOING",
      durationSec: 150
    }),
    authorTag: "#family",
    startedAt: now - 2580000,
    endedAt: now - 2430000,
    durationSec: 150,
    appPackage: "com.android.dialer",
    eventType: "CALL",
    squashedEvents: [],
    geofenceName: "🚌 Transit Line 1",
    lat: 36.3325,
    lng: 127.4342,
    createdAt: now
  },
  {
    id: "c8",
    branchId: 4,
    parentId: "c7",
    subject: "reply: [Jiho] \"오늘 소주 한잔?\" → 미안 삼겹살 먹기로함",
    body: JSON.stringify({
      sender: "Jiho",
      receivedMsg: "오늘 퇴근하고 가볍게 소주 한잔 고? 다른 애들도 온대",
      replyMsg: "미안미안! 오늘 집에서 삼겹살 구워준다고 장보고 들어간대서 바로 집으로 가야 함. 다음에 꼭 사주라!",
      packageName: "com.kakao.talk"
    }),
    authorTag: "#family",
    startedAt: now - 2400000,
    endedAt: now - 2400000,
    durationSec: 1,
    appPackage: "com.kakao.talk",
    eventType: "REPLY",
    squashedEvents: [],
    geofenceName: "🚌 Transit Line 1",
    lat: 36.3325,
    lng: 127.4342,
    createdAt: now
  },
  {
    id: "c9",
    branchId: 1,
    parentId: "c8",
    subject: "merge: Merge 'feature/sns' into main",
    body: null,
    authorTag: null,
    startedAt: now - 2100000,
    endedAt: now - 2100000,
    durationSec: 0,
    appPackage: null,
    eventType: "MERGE",
    squashedEvents: [],
    geofenceName: "🚌 Transit Line 1",
    lat: 36.3325,
    lng: 127.4342,
    createdAt: now
  },
  {
    id: "c10",
    branchId: 1,
    parentId: "c9",
    subject: "chore: Idle state",
    body: null,
    authorTag: null,
    startedAt: now - 1800000,
    endedAt: now - 1500000,
    durationSec: 300,
    appPackage: "com.android.launcher",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🏠 Home",
    lat: 37.5665,
    lng: 126.9780,
    createdAt: now
  },
  {
    id: "c11",
    branchId: 3,
    parentId: "c10",
    subject: "feat: YouTube 시청중",
    body: null,
    authorTag: null,
    startedAt: now - 1500000,
    endedAt: now - 600000,
    durationSec: 900,
    appPackage: "com.google.android.youtube",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🏠 Home",
    lat: 37.5665,
    lng: 126.9780,
    createdAt: now
  },
  {
    id: "c12",
    branchId: 3,
    parentId: "c11",
    subject: "photo: 사진 촬영 (IMG_20260528_1330.jpg)",
    body: JSON.stringify({
      photoUri: "content://media/external/images/media/10002",
      fileName: "IMG_20260528_1330.jpg"
    }),
    authorTag: null,
    startedAt: now - 600000,
    endedAt: now - 600000,
    durationSec: 1,
    appPackage: "com.android.camera2",
    eventType: "PHOTO",
    squashedEvents: [
      { pkg: "com.sec.android.gallery", durationSec: 4, note: "저녁 삼겹살 사진 갤러리 확인", eventType: "APP_USAGE" }
    ],
    geofenceName: "🏠 Home",
    lat: 37.5665,
    lng: 126.9780,
    createdAt: now
  },
  {
    id: "c13",
    branchId: 1,
    parentId: "c12",
    subject: "merge: Merge 'feature/media' into main",
    body: null,
    authorTag: null,
    startedAt: now - 300000,
    endedAt: now - 300000,
    durationSec: 0,
    appPackage: null,
    eventType: "MERGE",
    squashedEvents: [],
    geofenceName: "🏠 Home",
    lat: 37.5665,
    lng: 126.9780,
    createdAt: now
  },
  {
    id: "c14",
    branchId: 1,
    parentId: "c13",
    subject: "chore: Idle state",
    body: null,
    authorTag: null,
    startedAt: now - 60000,
    endedAt: now - 60000,
    durationSec: 60,
    appPackage: "com.android.launcher",
    eventType: "APP_USAGE",
    squashedEvents: [],
    geofenceName: "🏠 Home",
    lat: 37.5665,
    lng: 126.9780,
    createdAt: now
  }
];

export async function getRecentRawEvents(limit: number = 50): Promise<any[]> {
  try {
    const db = getDB();
    const res = await db.query("SELECT * FROM raw_events ORDER BY id DESC LIMIT ?", [limit]);
    return res.values || [];
  } catch (e) {
    console.warn("Failed to get raw events:", e);
    return [];
  }
}

export async function getBranches(): Promise<{ id: number; name: string; color: string }[]> {
  try {
    const db = getDB();
    const res = await db.query("SELECT id, name, color FROM branches ORDER BY id ASC");
    return res.values || [];
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') return DUMMY_BRANCHES;
    console.warn("Failed to get branches:", e);
    return [];
  }
}

function mapCommitRow(row: any): Commit {
  return {
    id: row.id,
    branchId: row.branch_id,
    parentId: row.parent_id,
    subject: row.subject,
    body: row.body,
    authorTag: row.author_tag,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSec: row.duration_sec,
    appPackage: row.app_package,
    eventType: row.event_type,
    squashedEvents: row.squashed_events ? JSON.parse(row.squashed_events) : [],
    geofenceName: row.geofence_name,
    lat: row.lat,
    lng: row.lng,
    createdAt: row.created_at,
  };
}

export async function getRecentCommits(limit: number = 50): Promise<Commit[]> {
  try {
    const db = getDB();
    const res = await db.query("SELECT * FROM commits ORDER BY started_at ASC LIMIT ?", [limit]);
    if (!res.values) return [];
    return res.values.map(mapCommitRow);
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') return DUMMY_COMMITS;
    console.warn("Failed to get commits:", e);
    return [];
  }
}

export async function getCommitsByPeriod(startTime: number, endTime: number): Promise<Commit[]> {
  try {
    const db = getDB();
    const res = await db.query(
      `SELECT * FROM commits WHERE ${PERIOD_ROWS_SQL} ORDER BY started_at ASC`, // rows overlapping the period
      periodRowsParams(startTime, endTime)
    );
    if (!res.values) return [];
    return res.values.map(mapCommitRow);
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') return DUMMY_COMMITS;
    console.warn("Failed to get commits by period:", e);
    return [];
  }
}

/** Location commits for moving replay: only LOCATION events within period. */
export async function getLocationCommitsByPeriod(startTime: number, endTime: number): Promise<Commit[]> {
  try {
    const db = getDB();
    const res = await db.query(
      `SELECT * FROM commits WHERE event_type = 'LOCATION' AND ${PERIOD_ROWS_SQL} ORDER BY started_at ASC`,
      periodRowsParams(startTime, endTime)
    );
    if (!res.values) return [];
    return res.values.map(mapCommitRow);
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') {
      return DUMMY_COMMITS.filter(c => c.eventType === 'LOCATION');
    }
    console.warn("Failed to get location commits by period:", e);
    return [];
  }
}

/** People interactions belong to the period in which they start, including a call's whole duration. */
export async function getPeopleCommitsByPeriod(startTime: number, endTime: number): Promise<Commit[]> {
  try {
    const res = await getDB().query(
      "SELECT * FROM commits WHERE event_type IN ('CALL', 'SMS', 'REPLY') AND started_at >= ? AND started_at <= ? ORDER BY started_at ASC",
      [startTime, endTime]
    );
    return (res.values || []).map(mapCommitRow);
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') return DUMMY_COMMITS;
    console.warn("Failed to get people interactions by period:", e);
    return [];
  }
}

export async function getDailyScreenSeconds(
  year: number,
  customDb?: { query(sql: string, params?: unknown[]): Promise<{ values?: any[] }> }
): Promise<{ date: string; sec: number }[]> {
  try {
    const db = customDb ?? getDB();
    const startOfYear = new Date(year, 0, 1, 0, 0, 0, 0).getTime();
    const endOfYear = new Date(year + 1, 0, 1, 0, 0, 0, 0).getTime() - 1;

    const { NOISE_PACKAGES } = await import("./constants");
    const noisePkgs = [...NOISE_PACKAGES].filter(Boolean);
    const noiseClause = noisePkgs.length ? `AND app_package NOT IN (${noisePkgs.map(() => "?").join(",")})` : "";

    // 1) 시작일과 종료일이 같은 날짜인 일반 세션 (SQL GROUP BY로 한 번에 집계)
    const sameDayQuery = `
      SELECT
        strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') AS day_date,
        SUM(duration_sec) AS total_sec
      FROM commits
      WHERE event_type = 'APP_USAGE'
        AND app_package IS NOT NULL
        ${noiseClause}
        AND started_at >= ? AND started_at <= ?
        AND strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') =
            strftime('%Y-%m-%d', CASE WHEN ended_at > started_at THEN (ended_at - 1) / 1000 ELSE started_at / 1000 END, 'unixepoch', 'localtime')
      GROUP BY day_date
      ORDER BY day_date ASC
    `;
    const sameDayRes = await db.query(sameDayQuery, [...noisePkgs, startOfYear, endOfYear]);

    // 2) 자정을 넘는 세션 (시작일 != 종료일)
    const crossMidnightQuery = `
      SELECT
        started_at,
        ended_at,
        duration_sec
      FROM commits
      WHERE event_type = 'APP_USAGE'
        AND app_package IS NOT NULL
        ${noiseClause}
        AND started_at <= ? AND (ended_at >= ? OR started_at >= ?)
        AND strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime') !=
            strftime('%Y-%m-%d', CASE WHEN ended_at > started_at THEN (ended_at - 1) / 1000 ELSE started_at / 1000 END, 'unixepoch', 'localtime')
    `;
    const crossMidnightRes = await db.query(crossMidnightQuery, [...noisePkgs, endOfYear, startOfYear, startOfYear]);


    const dateSecMap = new Map<string, number>();

    for (const row of sameDayRes.values || []) {
      const d = String(row.day_date);
      const sec = Number(row.total_sec || 0);
      dateSecMap.set(d, (dateSecMap.get(d) || 0) + sec);
    }

    for (const row of crossMidnightRes.values || []) {
      const startedAt = Number(row.started_at);
      const endedAt = Number(row.ended_at);
      const durationSec = Number(row.duration_sec);

      let cur = new Date(startedAt);
      cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate(), 0, 0, 0, 0);
      const endLimit = Math.max(endedAt, startedAt);

      while (cur.getTime() <= endLimit) {
        const curYear = cur.getFullYear();
        if (curYear === year) {
          const dateStr = dateKey(cur);
          const { start, end } = dayRange(dateStr);
          const s = periodSec({ startedAt, endedAt, durationSec }, start, end);
          if (s > 0) {
            dateSecMap.set(dateStr, (dateSecMap.get(dateStr) || 0) + s);
          }
        }
        cur.setDate(cur.getDate() + 1);
      }
    }

    const result: { date: string; sec: number }[] = [];
    for (const [date, sec] of dateSecMap.entries()) {
      if (sec > 0) {
        result.push({ date, sec });
      }
    }
    result.sort((a, b) => a.date.localeCompare(b.date));
    return result;
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') {
      const dummyCounts: { date: string; sec: number }[] = [];
      const now = new Date();
      for (let i = 0; i < 180; i++) {
        const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        if (d.getFullYear() === year) {
          const dateString = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          dummyCounts.push({
            date: dateString,
            sec: Math.floor(Math.random() * 21600),
          });
        }
      }
      return dummyCounts;
    }
    console.warn("Failed to get daily screen seconds:", e);
    return [];
  }
}

export async function getTopBranches(startMs: number, endMs: number): Promise<{ name: string, count: number, percentage: number, color: string }[]> {
  try {
    const db = getDB();
    
    const query = `
      SELECT 
        b.name, 
        b.color,
        COUNT(c.id) as cnt
      FROM commits c
      JOIN branches b ON c.branch_id = b.id
      WHERE c.started_at >= ? AND c.started_at <= ? AND c.event_type != 'MERGE'
      GROUP BY b.id
      ORDER BY cnt DESC
      LIMIT 3
    `;
    const res = await db.query(query, [startMs, endMs]);
    
    if (!res.values || res.values.length === 0) return [];
    
    // Total count for percentage calculation
    const totalQuery = `SELECT COUNT(id) as total FROM commits WHERE started_at >= ? AND started_at <= ? AND event_type != 'MERGE'`;
    const totalRes = await db.query(totalQuery, [startMs, endMs]);
    const total = totalRes.values?.[0]?.total || 1;
    
    return res.values.map((row: any) => ({
      name: row.name,
      color: row.color,
      count: row.cnt,
      percentage: Math.round((row.cnt / total) * 100)
    }));
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') {
      return [
        { name: 'main', count: 120, percentage: 64, color: '#f1e05a' },
        { name: 'feature/media', count: 40, percentage: 21, color: '#ff79c6' },
        { name: 'feature/web', count: 28, percentage: 15, color: '#50fa7b' }
      ];
    }
    return [];
  }
}

export async function getTopApps(startMs: number, endMs: number): Promise<{ pkg: string, name: string, durationSec: number, count: number }[]> {
  try {
    const db = getDB();

    // 노이즈 패키지 필터는 파이프라인 공용 소스(lib/constants.ts)를 그대로 재사용
    const { NOISE_PACKAGES } = await import("./constants");
    const noisePkgs = Array.from(NOISE_PACKAGES).filter(Boolean);
    const noiseClause = noisePkgs.length > 0
      ? `AND app_package NOT IN (${noisePkgs.map(() => "?").join(",")})`
      : "";

    const query = `
      SELECT
        app_package,
        SUM(${PERIOD_SEC_SQL}) as total_duration,
        COUNT(*) as cnt
      FROM commits
      WHERE app_package IS NOT NULL
        AND event_type = 'APP_USAGE' -- calls are counted separately: a call overlaps the dialer's own usage session
        ${noiseClause}
        AND ${PERIOD_ROWS_SQL}
      GROUP BY app_package
      ORDER BY total_duration DESC
      LIMIT 3
    `;
    const res = await db.query(query, [...periodSecParams(startMs, endMs), ...noisePkgs, ...periodRowsParams(startMs, endMs)]);
    
    if (!res.values) return [];
    
    // Resolve app names
    const { resolveAppName } = await import("./processor/utils");
    await (await import("./appLabels")).loadAppLabels(res.values.map((row: any) => row.app_package));
    
    return res.values.map((row: any) => ({
      pkg: row.app_package,
      name: resolveAppName(row.app_package),
      durationSec: row.total_duration,
      count: row.cnt
    }));
  } catch (e) {
    if (Capacitor.getPlatform() === 'web') {
      return [
        { pkg: 'com.google.android.youtube', name: 'YouTube', durationSec: 116100, count: 42 },
        { pkg: 'com.kakao.talk', name: '카카오톡', durationSec: 67200, count: 30 },
        { pkg: 'com.android.chrome', name: 'Chrome', durationSec: 43500, count: 18 }
      ];
    }
    return [];
  }
}

/** Apps still on main across all history (one classification applies to every past record, so there is no per-day list). */
export async function getUnclassifiedApps(): Promise<{ pkg: string; name: string; durationSec: number }[]> {
  try {
    const db = getDB();
    const { NOISE_PACKAGES } = await import("./constants");
    const noisePkgs = [...NOISE_PACKAGES].filter(Boolean);
    const clause = noisePkgs.length ? `AND app_package NOT IN (${noisePkgs.map(() => "?").join(",")})` : "";
    const result = await db.query(
      `SELECT app_package, SUM(duration_sec) duration_sec FROM commits WHERE branch_id = 1 AND event_type = 'APP_USAGE'
       AND app_package IS NOT NULL ${clause} GROUP BY app_package ORDER BY duration_sec DESC`,
      noisePkgs
    );
    const { resolveAppName } = await import("./processor/utils");
    await (await import("./appLabels")).loadAppLabels((result.values || []).map((row: any) => row.app_package));
    return (result.values || []).map((row: any) => ({ pkg: row.app_package, name: resolveAppName(row.app_package), durationSec: row.duration_sec }));
  } catch { return []; }
}

export interface AppClassificationItem {
  pkg: string;
  name: string;
  totalDurationSec: number;
  branchId: number;
  branchName: string;
  branchColor: string;
  /** 기록 중 현재 분류와 다른 브랜치가 남아 있음 → 현재 분류도 다시 적용 가능 */
  mixed?: boolean;
}

export interface AppClassificationGroup {
  branchId: number;
  branchName: string;
  branchColor: string;
  displayName: string;
  apps: AppClassificationItem[];
}

export const STANDARD_BRANCH_NAMES: readonly string[] = [
  "main",
  "web",
  "media",
  "sns",
  "game",
  "work",
  "life",
  "etc",
  "system",
] as const;

export function getBranchOrderIndex(branchName: string): number {
  if (branchName === "main") return 0;
  const stripped = branchName.replace(/^feature\//, "");
  const idx = STANDARD_BRANCH_NAMES.indexOf(stripped as any);
  return idx !== -1 ? idx : 999;
}

export function getBranchDisplayName(branchName: string): string {
  if (branchName === "main") return "미분류";
  return branchName.replace("feature/", "");
}

/**
 * 앱 분류 목록을 브랜치별로 묶고 사용시간 내림차순 및 검색 필터를 적용하는 순수 함수
 * 브랜치 ID가 희소하더라도 브랜치 이름 순서(main -> web -> media -> sns -> work -> life -> etc -> system)대로 그룹화한다.
 */
export function groupAndSortAppClassifications(
  apps: AppClassificationItem[],
  branches: { id: number; name: string; color: string }[],
  searchQuery: string = ""
): AppClassificationGroup[] {
  const query = searchQuery.trim().toLowerCase();

  // 1. 검색 필터 (이름 또는 패키지명 부분 일치, 대소문자 무시)
  const filteredApps = query
    ? apps.filter(
        (app) =>
          app.name.toLowerCase().includes(query) ||
          app.pkg.toLowerCase().includes(query)
      )
    : apps;

  // 브랜치 정보 맵
  const branchMap = new Map<number, { id: number; name: string; color: string }>();
  for (const b of branches) {
    branchMap.set(b.id, b);
  }

  // 2. 그룹별로 앱 묶기
  const groupsByBranchId = new Map<number, AppClassificationItem[]>();
  for (const app of filteredApps) {
    let list = groupsByBranchId.get(app.branchId);
    if (!list) {
      list = [];
      groupsByBranchId.set(app.branchId, list);
    }
    list.push(app);
  }

  // 3. 각 그룹 안에서 사용시간 내림차순 정렬
  for (const list of groupsByBranchId.values()) {
    list.sort((a, b) => b.totalDurationSec - a.totalDurationSec);
  }

  // 4. 그룹 정렬 (main -> web -> media -> sns -> work -> life -> etc -> system -> 기타 브랜치)
  const result: AppClassificationGroup[] = [];

  for (const [branchId, groupApps] of groupsByBranchId.entries()) {
    const branchInfo = branchMap.get(branchId) || {
      id: branchId,
      name: groupApps[0]?.branchName || `branch-${branchId}`,
      color: groupApps[0]?.branchColor || "#6272a4",
    };
    result.push({
      branchId,
      branchName: branchInfo.name,
      branchColor: branchInfo.color,
      displayName: getBranchDisplayName(branchInfo.name),
      apps: groupApps,
    });
  }

  result.sort((a, b) => {
    const orderA = getBranchOrderIndex(a.branchName);
    const orderB = getBranchOrderIndex(b.branchName);
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return a.branchName.localeCompare(b.branchName);
  });

  return result;
}

/**
 * 기록에 있는 APP_USAGE 앱 전체를 조회하여 현재 분류와 누적 사용시간을 반환한다. (노이즈 제외)
 */
export async function getAppClassifications(
  customDb?: { query(sql: string, params?: unknown[]): Promise<{ values?: any[] }> }
): Promise<AppClassificationItem[]> {
  try {
    const db = customDb ?? getDB();
    const { NOISE_PACKAGES } = await import("./constants");
    const noisePkgs = [...NOISE_PACKAGES].filter(Boolean);
    const clause = noisePkgs.length ? `AND c.app_package NOT IN (${noisePkgs.map(() => "?").join(",")})` : "";

    const sql = `
      SELECT
        agg.app_package,
        agg.total_duration_sec,
        agg.branch_id,
        COALESCE(b.name, 'main') AS branch_name,
        COALESCE(b.color, '#f1e05a') AS branch_color,
        EXISTS (SELECT 1 FROM commits c3 WHERE c3.app_package = agg.app_package AND c3.event_type = 'APP_USAGE' AND c3.branch_id <> agg.branch_id) AS mixed
      FROM (
        SELECT
          c.app_package,
          SUM(c.duration_sec) AS total_duration_sec,
          COALESCE(
            (SELECT abo.branch_id FROM app_branch_overrides abo WHERE abo.app_package = c.app_package),
            (SELECT c2.branch_id FROM commits c2 WHERE c2.app_package = c.app_package AND c2.event_type = 'APP_USAGE' ORDER BY c2.started_at DESC LIMIT 1)
          ) AS branch_id
        FROM commits c
        WHERE c.event_type = 'APP_USAGE'
          AND c.app_package IS NOT NULL
          ${clause}
        GROUP BY c.app_package
      ) agg
      LEFT JOIN branches b ON b.id = agg.branch_id
      ORDER BY agg.total_duration_sec DESC
    `;

    const result = await db.query(sql, noisePkgs);
    const rows = result.values || [];

    const { resolveAppName } = await import("./processor/utils");
    const { loadAppLabels } = await import("./appLabels");
    await loadAppLabels(rows.map((row: any) => row.app_package));

    return rows.map((row: any) => ({
      pkg: row.app_package,
      name: resolveAppName(row.app_package),
      totalDurationSec: Number(row.total_duration_sec || 0),
      branchId: Number(row.branch_id || 1),
      branchName: String(row.branch_name || "main"),
      branchColor: String(row.branch_color || "#f1e05a"),
      mixed: Number(row.mixed || 0) === 1,
    }));
  } catch (err) {
    console.warn("Failed to get app classifications:", err);
    return [];
  }
}

/** Coverage rows overlapping [start, end] plus the first/last coverage ever (Step 6e, lib/coverage.ts). */
export async function getCoverage(start: number, end: number): Promise<{ rows: { from: number; to: number; reason: string | null }[]; firstStart: number | null; lastEnd: number | null }> {
  try {
    const db = getDB();
    return parseCoverage((await db.query(COVERAGE_SQL, coverageParams(start, end))).values || []);
  } catch (e) {
    console.warn("[queries] coverage read failed:", e);
    return { rows: [], firstStart: null, lastEnd: null };
  }
}

/**
 * SQLite FTS5 전문 검색을 활용한 커밋 검색
 */
export async function searchCommitsFTS(queryText: string, limit: number = 20): Promise<Commit[]> {
  try {
    const db = getDB();
    const cleanQuery = queryText.trim().replace(/['"*]/g, "");
    if (!cleanQuery) return [];

    // 공백으로 분리된 단어들을 FTS5 접두어 와일드카드로 결합 (예: "크롬" "검색"*)
    const ftsTokens = cleanQuery
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`)
      .join(" ");

    const ftsQuery = `
      SELECT c.* 
      FROM commits c
      JOIN commits_fts f ON c.rowid = f.rowid
      WHERE commits_fts MATCH ?
      ORDER BY c.started_at DESC
      LIMIT ?
    `;

    const res = await db.query(ftsQuery, [ftsTokens, limit]);
    if (!res.values) return [];
    return res.values.map(mapCommitRow);
  } catch (e) {
    if (Capacitor.getPlatform() === "web") {
      const q = queryText.toLowerCase();
      return DUMMY_COMMITS.filter(
        (c) =>
          c.subject.toLowerCase().includes(q) ||
          (c.body && c.body.toLowerCase().includes(q)) ||
          (c.appPackage && c.appPackage.toLowerCase().includes(q))
      );
    }
    console.warn("Failed to search commits via FTS5:", e);
    return [];
  }
}
