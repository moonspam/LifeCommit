import { shiftDate, dayRange, formatDuration, locationRuns, type LocationRun, STAY_CONTEXT_MS } from "./today";
import { PERIOD_ROWS_SQL, PERIOD_SEC_SQL, periodRowsParams, periodSecParams } from "./periodSec";
import { resolveAppName } from "./processor/utils";
import { normalizePhone, peopleDisplayLabels, type Person, isNumberLikeSender } from "./people";
import type { Commit } from "../types/commit";
import { queryText, type QueryLocale } from "./queryText";

export type NlTimeOfDay = "morning" | "lunch" | "afternoon" | "evening" | "night" | "any";
export type NlKind = "app" | "call" | "sms" | "reply" | "location";
export type NlMetric = "duration" | "count" | "list";
/** 장소 선택: 등록 장소(geofence_name 정확 일치)와 행정동(동 이름 정확 일치)을 source로 구분한다. */
export type NlPlace = { source: "geofence" | "dong"; name: string };

export type NlFilter = {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  timeOfDay: NlTimeOfDay;
  apps: string[];       // package names
  places: NlPlace[];
  people: string[];     // personKey (tel:... or msg:...)
  kinds: NlKind[];      // event kinds
  metric: NlMetric;     // duration | count | list
};

export type NlResultRow = {
  id: string;
  title: string;
  subtitle?: string;
  text: string;
  time?: string;
  sortTs?: number;
};

export type NlQueryResult = {
  value: string;
  unit?: string;
  rows: NlResultRow[];
  summary: string;
  note?: string;
  understood: boolean;
};

/** YYYY-MM-DD 형식 유효 달력 날짜 검증 (2월 30일 등 방지) */
export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export type TimeOfDayBound = {
  startHour: number;
  endHour: number;
  crossesMidnight?: boolean;
};

/** 실행기와 화면이 공유하는 단일 시간대 경계 정의 */
export const TIME_OF_DAY_BOUNDS: Record<Exclude<NlTimeOfDay, "any">, TimeOfDayBound> = {
  morning: { startHour: 6, endHour: 12 },
  lunch: { startHour: 11, endHour: 14 },
  afternoon: { startHour: 12, endHour: 18 },
  evening: { startHour: 18, endHour: 22 },
  night: { startHour: 22, endHour: 6, crossesMidnight: true },
};

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 시간대별 시간 범위 표기 (예: "06~12", "22~06") */
export function formatTimeOfDayRange(tod: Exclude<NlTimeOfDay, "any">): string {
  const b = TIME_OF_DAY_BOUNDS[tod];
  return `${pad2(b.startHour)}~${pad2(b.endHour)}`;
}

/** 화면(AskPanel 등)에서 사용하는 시간대 표기 라벨 모음: 실행기 정의와 100% 일치 */
export const TIME_OF_DAY_UI_LABELS: Record<NlTimeOfDay, string> = {
  any: "전체",
  morning: `아침 (${formatTimeOfDayRange("morning")})`,
  lunch: `점심 (${formatTimeOfDayRange("lunch")})`,
  afternoon: `오후 (${formatTimeOfDayRange("afternoon")})`,
  evening: `저녁 (${formatTimeOfDayRange("evening")})`,
  night: `밤 (${formatTimeOfDayRange("night")})`,
};

/**
 * Time of day definitions:
 * - morning:   06:00 ~ 12:00
 * - lunch:     11:00 ~ 14:00
 * - afternoon: 12:00 ~ 18:00
 * - evening:   18:00 ~ 22:00
 * - night:     22:00 ~ 06:00 (crosses midnight)
 *
 * DST(일광 절약 시간제) 전환일에도 로컬 시각을 정확히 보존하도록 Date 생성자로 경계를 계산.
 */
export function getTimeWindow(date: string, tod: NlTimeOfDay): { start: number; end: number } {
  const [yStr, mStr, dStr] = date.split("-");
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10) - 1;
  const d = parseInt(dStr, 10);

  if (tod === "any") {
    const dr = dayRange(date);
    return { start: dr.start, end: dr.end };
  }

  const b = TIME_OF_DAY_BOUNDS[tod];
  if (!b) {
    const dr = dayRange(date);
    return { start: dr.start, end: dr.end };
  }

  const start = new Date(y, m, d, b.startHour, 0, 0, 0).getTime();
  const nextD = b.crossesMidnight
    ? new Date(y, m, d + 1, b.endHour, 0, 0, 0)
    : new Date(y, m, d, b.endHour, 0, 0, 0);
  const end = nextD.getTime() - 1;
  return { start, end };
}

/** 전화번호 형태의 발신자 판정: lib/people.ts 공용 함수 사용 (NL1-7 #3) */
export { isNumberLikeSender };

/** Convert context people to Person array and compute disambiguation display labels (NL1-5 #2, NL1-6 #5) */
export function getPeopleDisplayLabelMap(
  people: { key: string; name: string; tag?: string | null; saved?: boolean }[]
): Map<string, { full: string; node: string }> {
  const personList: Person[] = people.map((p) => ({
    key: p.key,
    name: p.name,
    tag: p.tag ?? null,
    saved: p.saved !== false,
    calls: 0,
    callSec: 0,
    sms: 0,
    replies: 0,
    score: 0,
    lastAt: 0,
    lastKind: "CALL" as const,
  }));
  const baseMap = peopleDisplayLabels(personList);

  // 동명이인 그룹별 메신저 라벨 보강 (NL1-6 #5: 관계도처럼 '이름 · 앱 이름' 부여)
  const nameGroups = new Map<string, typeof people>();
  for (const p of people) {
    const clean = p.name.replace(/\s*·.*$/, "").trim();
    const list = nameGroups.get(clean) ?? [];
    list.push(p);
    nameGroups.set(clean, list);
  }

  const resultMap = new Map<string, { full: string; node: string }>();
  for (const p of people) {
    const clean = p.name.replace(/\s*·.*$/, "").trim();
    const group = nameGroups.get(clean) ?? [];
    if (group.length > 1 && p.key.startsWith("msg:")) {
      const parts = p.key.split(":");
      const pkg = parts[1] ?? "";
      const appName = resolveAppName(pkg);
      const label = `${p.name} · ${appName}`;
      resultMap.set(p.key, { full: label, node: label });
    } else if (group.length > 1 && p.key.startsWith("tel:")) {
      const baseLabel = baseMap.get(p.key);
      if (baseLabel && baseLabel.full !== p.name) {
        resultMap.set(p.key, baseLabel);
      } else {
        const digits = p.key.slice(4).replace(/\D/g, "");
        const suffix = digits.length >= 4 ? ` (…${digits.slice(-4)})` : "";
        const label = `${p.name}${suffix}`;
        resultMap.set(p.key, { full: label, node: label });
      }
    } else {
      const baseLabel = baseMap.get(p.key);
      if (baseLabel) {
        resultMap.set(p.key, baseLabel);
      } else {
        resultMap.set(p.key, { full: p.name, node: p.name });
      }
    }
  }

  return resultMap;
}

export type FilterValidationResult = {
  valid: boolean;
  reason?: string;
};

/** kinds가 비어 있을 때 실제 필터 조건에 따라 실행되는 유효 이벤트 종류 계산 (NL1-7 #1) */
export function getEffectiveKinds(filter: NlFilter): NlKind[] {
  if (filter.kinds.length > 0) {
    return filter.kinds;
  }
  // 지정된 조건에 따라 해당 조건을 실제 적용할 수 있는 기본 종류만 결정 (앱 사용 기록으로 대체 금지)
  if (filter.people.length > 0 && filter.apps.length > 0) {
    return ["reply"];
  }
  if (filter.people.length > 0) {
    const hasTel = filter.people.some((k) => k.startsWith("tel:"));
    const hasMsg = filter.people.some((k) => k.startsWith("msg:"));
    if (!hasTel && hasMsg) {
      return ["reply"];
    }
    if (filter.metric === "duration") return ["call"];
    if (filter.metric === "count") return hasMsg ? ["call", "sms", "reply"] : ["call", "sms"];
    return ["call", "sms"];
  }
  if (filter.places.length > 0) {
    return ["location"];
  }
  if (filter.apps.length > 0) {
    return ["app"];
  }
  // 아무 대상 조건이 없는 전체 질의
  if (filter.metric === "list") {
    return ["app", "call", "sms", "location"];
  }
  return ["app"];
}

/** 단일 조건 × 이벤트 종류 지원표 검증 (NL1-6 #3, #4, NL1-7 #1, Review 44 #1) */
export function validateFilterSupport(filter: NlFilter): FilterValidationResult {
  const { kinds, apps, people, places, metric } = filter;

  // 1. 단일 조건간 상호 충돌 및 관계 질문 검사 (NL1-6 #3, #4, Review 49 #2)
  const hasLocation = places.length > 0 || kinds.includes("location");
  const hasApp = apps.length > 0 || kinds.includes("app");
  const hasContact = people.length > 0 || kinds.includes("call") || kinds.includes("sms") || kinds.includes("reply");

  if (hasLocation && hasApp) {
    return { valid: false, reason: "장소와 앱 조건의 동시 사용은 지원하지 않음" };
  }
  if (hasLocation && hasContact) {
    return { valid: false, reason: "장소와 사람 조건의 동시 사용은 지원하지 않음" };
  }
  if (apps.length > 0 && people.length > 0) {
    if (kinds.length > 0 && !kinds.includes("reply")) {
      return { valid: false, reason: "앱과 사람 조건의 동시 사용은 답장(reply)에만 지원함" };
    }
    if (metric !== "count") {
      return { valid: false, reason: "앱과 사람 조건이 함께 있는 경우 답장 횟수(count)만 지원함" };
    }
  }

  // 2. 실제로 실행될 종류(effectiveKinds)에 대해 지원표 검사 (NL1-7 #1, Review 44 #1)
  const targetKinds = getEffectiveKinds(filter);

  for (const kind of targetKinds) {
    if (kind === "app") {
      if (people.length > 0) return { valid: false, reason: "앱 사용 기록에는 사람 조건을 적용할 수 없음" };
      if (places.length > 0) return { valid: false, reason: "앱 사용 기록에는 장소 조건을 적용할 수 없음" };
    } else if (kind === "call") {
      if (apps.length > 0) return { valid: false, reason: "통화 기록에는 앱 조건을 적용할 수 없음" };
      if (places.length > 0) return { valid: false, reason: "통화 기록에는 장소 조건을 적용할 수 없음" };
      if (people.length > 0 && people.every((k) => k.startsWith("msg:"))) {
        return { valid: false, reason: "메신저 상대는 통화 기록을 지원하지 않음" };
      }
    } else if (kind === "sms") {
      if (apps.length > 0) return { valid: false, reason: "문자 기록에는 앱 조건을 적용할 수 없음" };
      if (places.length > 0) return { valid: false, reason: "문자 기록에는 장소 조건을 적용할 수 없음" };
      if (metric === "duration") return { valid: false, reason: "문자 기록은 시간(duration) 측정을 지원하지 않음" };
      if (people.length > 0 && people.every((k) => k.startsWith("msg:"))) {
        return { valid: false, reason: "메신저 상대는 문자 기록을 지원하지 않음" };
      }
    } else if (kind === "reply") {
      if (places.length > 0) return { valid: false, reason: "답장 기록에는 장소 조건을 적용할 수 없음" };
      if (metric !== "count") return { valid: false, reason: "답장 기록은 횟수(count) 측정만 지원함" };
      if (people.length > 0 && people.every((k) => k.startsWith("tel:"))) {
        return { valid: false, reason: "전화 연락처는 답장(메신저) 기록을 지원하지 않음" };
      }
    } else if (kind === "location") {
      if (apps.length > 0) return { valid: false, reason: "장소 기록에는 앱 조건을 적용할 수 없음" };
      if (people.length > 0) return { valid: false, reason: "장소 기록에는 사람 조건을 적용할 수 없음" };
    }
  }

  return { valid: true };
}

/** Location run helpers for executeNlQuery (NL1-5 #1, #4) */
function parseLocationCommits(rows: Record<string, unknown>[]): Commit[] {
  return rows.map((row) => {
    let b: any = {};
    try { b = JSON.parse(String(row.body ?? "{}")); } catch {}
    const startedAt = Number(row.started_at);
    const endedAt = row.ended_at != null ? Number(row.ended_at) : startedAt + Number(row.duration_sec ?? 0) * 1000;
    const lat = row.lat != null ? Number(row.lat) : (b.lat != null ? Number(b.lat) : 0);
    const lng = row.lng != null ? Number(row.lng) : (b.lng != null ? Number(b.lng) : 0);
    return {
      id: String(row.id ?? `loc-${startedAt}`),
      branchId: 0,
      parentId: null,
      subject: "",
      body: row.body ? String(row.body) : null,
      authorTag: null,
      startedAt,
      endedAt,
      durationSec: Math.round((endedAt - startedAt) / 1000),
      appPackage: null,
      eventType: "LOCATION" as const,
      squashedEvents: [],
      geofenceName: row.geofence_name ? String(row.geofence_name) : null,
      lat,
      lng,
      createdAt: startedAt,
    };
  });
}

function resolveRunPlace(run: LocationRun, dongAtFn: ((lat: number, lng: number) => string | null) | undefined, unknownDong: string): { gName: string; dongName: string; displayName: string } {
  const gName = run.first.geofenceName ? String(run.first.geofenceName) : "";
  const dongName = dongAtFn ? (dongAtFn(run.lat, run.lng) ?? "") : "";
  const displayName = gName || dongName || unknownDong;
  return { gName, dongName, displayName };
}

/** 장소 선택은 정확히 비교한다(부분 일치 없음): 등록 장소는 geofence_name, 행정동은 동 이름. 같은 이름이어도 source로 구분. */
function matchesPlaceFilter(gName: string, dongName: string, places: NlPlace[]): boolean {
  if (places.length === 0) return true;
  return places.some((p) => (p.source === "geofence" ? gName === p.name : dongName === p.name));
}

/**
 * 조회용 체류 묶음: 장소(geofence_name, 동 이름)가 바뀌는 지점에서 먼저 끊은 뒤 locationRuns로 묶는다.
 * 등록 장소 밖(geofence_name=null)에서 A동→B동으로 이어 기록될 때도 동이 바뀌는 지점에서 끊어,
 * B동을 골랐을 때 A동으로 합쳐져 0건이 되는 일을 막는다(시간·횟수·목록 모두).
 * Today/Replay가 쓰는 locationRuns 자체는 바꾸지 않는다.
 */
function placeRuns(commits: Commit[], dongAt?: (lat: number, lng: number) => string | null): LocationRun[] {
  const locs = commits.filter((c) => c.eventType === "LOCATION" && c.lat != null && c.lng != null).sort((a, b) => a.startedAt - b.startedAt);
  const chunks: Commit[][] = [];
  for (const c of locs) {
    const last = chunks[chunks.length - 1];
    const prev = last ? last[last.length - 1] : null;
    const gName = c.geofenceName ?? null;
    const dong = dongAt && c.lat != null && c.lng != null ? dongAt(c.lat, c.lng) : null;
    const prevGName = prev ? (prev.geofenceName ?? null) : null;
    const prevDong = prev && dongAt && prev.lat != null && prev.lng != null ? dongAt(prev.lat, prev.lng) : null;

    if (prev && prevGName === gName && prevDong === dong) {
      last.push(c);
    } else {
      chunks.push([c]);
    }
  }
  return chunks.flatMap((chunk) => locationRuns(chunk)).sort((a, b) => a.start - b.start);
}

/** Interface for SQLite database adapter */
export interface SqlAdapter {
  query(sql: string, params?: unknown[]): Promise<{ values?: Record<string, unknown>[] }>;
}

/** Execute the interpreted query against real SQLite */
export async function executeNlQuery(
  filter: NlFilter,
  db: SqlAdapter,
  extra?: {
    locale?: QueryLocale;
    people?: { key: string; name: string; tag?: string | null; saved?: boolean }[];
    dongAt?: (lat: number, lng: number) => string | null;
  }
): Promise<NlQueryResult> {
  const T = queryText(extra?.locale);
  const peopleMap = new Map((extra?.people ?? []).map((p) => [p.key, p]));
  const displayLabelMap = getPeopleDisplayLabelMap(extra?.people ?? []);

  // 단일 조건 × 종류 지원표 검증 (NL1-6 #3, #4)
  const supportCheck = validateFilterSupport(filter);
  if (!supportCheck.valid) {
    return {
      value: T.unsupportedValue,
      unit: undefined,
      rows: [],
      summary: T.unsupportedSummary,
      note: supportCheck.reason,
      understood: false,
    };
  }

  // 동명이인은 여기서 거절하지 않는다: 요청 모델은 키(tel:/msg:)로 선택하므로 명시한 키 집합을 그대로 실행한다.
  // 이름 → 키 모호성 검사는 명령 입력 단계(QB-C)에서 한다.

  // Calculate inclusive windows for each day in [from, to]
  const days: string[] = [];
  let curr = filter.from;
  while (curr <= filter.to) {
    days.push(curr);
    curr = shiftDate(curr, 1);
  }

  const windows = days.map((d) => getTimeWindow(d, filter.timeOfDay));

  let note: string | undefined;

  const isMultiDay = filter.from !== filter.to;
  const formatRowTime = (ts: number): string => T.rowTime(ts, isMultiDay);

  const matchesPeopleFilter = (rawPhone: string): boolean => {
    if (filter.people.length === 0) return true;
    const normPhone = normalizePhone(rawPhone);
    if (!normPhone) return false; // 빈 번호는 절대 일치하지 않음
    return filter.people.some((k) => {
      if (!k.startsWith("tel:")) return false;
      const keyPhone = k.slice(4);
      const normKey = normalizePhone(keyPhone);
      return normKey.length > 0 && normKey === normPhone;
    });
  };

  const resolvePersonInfo = (rawPhone: string, contactName?: string) => {
    const norm = normalizePhone(rawPhone);
    const personKey = `tel:${norm}`;
    const person = peopleMap.get(personKey) || peopleMap.get(`tel:${rawPhone}`);
    const isSaved = contactName ? true : (person?.saved !== false && !!person?.name && !/^\d{7,}$/.test(person.name));
    const labelInfo = displayLabelMap.get(personKey) || (person ? displayLabelMap.get(person.key) : undefined);
    let displayName = labelInfo?.full || contactName || person?.name;
    if (!displayName) {
      const last4 = norm.slice(-4);
      displayName = last4 ? `…${last4}` : T.unknownNumber;
    }
    return { personKey, person, isSaved, displayName };
  };

  const activeKinds = getEffectiveKinds(filter);

  // 1. DURATION METRIC
  if (filter.metric === "duration") {
    let totalSec = 0;
    const rows: NlResultRow[] = [];

    // App duration
    if (activeKinds.includes("app")) {
      for (const w of windows) {
        let sql = `SELECT ${PERIOD_SEC_SQL} AS sec, started_at, ended_at, duration_sec, app_package FROM commits WHERE event_type = 'APP_USAGE' AND ${PERIOD_ROWS_SQL}`;
        const params: unknown[] = [...periodSecParams(w.start, w.end), ...periodRowsParams(w.start, w.end)];
        if (filter.apps.length > 0) {
          sql += ` AND app_package IN (${filter.apps.map(() => "?").join(",")})`;
          params.push(...filter.apps);
        }
        const res = await db.query(sql, params);
        for (const row of res.values ?? []) {
          const sec = Number(row.sec ?? 0);
          totalSec += sec;
          const pkg = String(row.app_package ?? "");
          rows.push({
            id: `app-${row.started_at}`,
            title: resolveAppName(pkg),
            text: formatDuration(sec),
            time: formatRowTime(Number(row.started_at)),
          });
        }
      }
    }

    // Call duration (Review 51 Must fix 2: 상대별 합계 및 관계도 라벨)
    if (activeKinds.includes("call")) {
      const isPersonSpecific = filter.people.length > 0;
      const personGroups = new Map<string, { displayName: string; totalSec: number; lastTs: number }>();
      let unsavedCallSec = 0;
      let unsavedCallCount = 0;
      let unsavedCallLastTs = 0;

      for (const w of windows) {
        const sql = `SELECT id, duration_sec, started_at, body FROM commits WHERE event_type = 'CALL' AND started_at >= ? AND started_at <= ?`;
        const params: unknown[] = [w.start, w.end];
        const res = await db.query(sql, params);
        for (const row of res.values ?? []) {
          let b: any = {};
          try { b = JSON.parse(String(row.body ?? "{}")); } catch {}
          const rawPhone = String(b.phoneNumber ?? "");
          if (!matchesPeopleFilter(rawPhone)) continue;

          const sec = Number(row.duration_sec ?? 0);
          totalSec += sec;

          const { isSaved, displayName } = resolvePersonInfo(rawPhone, b.contactName);
          const startedAt = Number(row.started_at);

          if (isPersonSpecific) {
            rows.push({
              id: `call-${row.started_at}`,
              title: displayName || T.phoneCall,
              text: formatDuration(sec),
              time: formatRowTime(startedAt),
            });
          } else {
            if (!isSaved) {
              unsavedCallCount++;
              unsavedCallSec += sec;
              unsavedCallLastTs = Math.max(unsavedCallLastTs, startedAt);
            } else {
              const g = personGroups.get(displayName) ?? { displayName, totalSec: 0, lastTs: 0 };
              g.totalSec += sec;
              g.lastTs = Math.max(g.lastTs, startedAt);
              personGroups.set(displayName, g);
            }
          }
        }
      }

      if (!isPersonSpecific) {
        const sortedGroups = Array.from(personGroups.values()).sort((a, b) => b.lastTs - a.lastTs);
        for (const g of sortedGroups) {
          rows.push({
            id: `call-person-${g.displayName}`,
            title: g.displayName,
            text: formatDuration(g.totalSec),
            time: formatRowTime(g.lastTs),
          });
        }
        if (unsavedCallCount > 0) {
          rows.push({
            id: "call-unsaved-numbers",
            title: T.unsavedNumbers,
            text: T.unsavedCountDur(unsavedCallCount, formatDuration(unsavedCallSec)),
            time: unsavedCallLastTs > 0 ? formatRowTime(unsavedCallLastTs) : undefined,
          });
        }
      }
    }

    // Location duration (NL1-5 #1, NL1-7 #2)
    if (activeKinds.includes("location")) {
      const globalReadStart = Math.min(...windows.map((w) => w.start)) - STAY_CONTEXT_MS;
      const globalReadEnd = Math.max(...windows.map((w) => w.end)) + STAY_CONTEXT_MS;
      const sql = `SELECT id, duration_sec, started_at, ended_at, geofence_name, lat, lng, body FROM commits WHERE event_type = 'LOCATION' AND started_at <= ? AND (ended_at >= ? OR started_at + duration_sec * 1000 >= ?) ORDER BY started_at ASC`;
      const params: unknown[] = [globalReadEnd, globalReadStart, globalReadStart];
      const res = await db.query(sql, params);
      const locCommits = parseLocationCommits(res.values ?? []);
      const runs = placeRuns(locCommits, extra?.dongAt);

      for (const w of windows) {
        for (const run of runs) {
          const { gName, dongName, displayName } = resolveRunPlace(run, extra?.dongAt, T.unknownDong);
          if (!matchesPlaceFilter(gName, dongName, filter.places)) continue;

          const overlapStart = Math.max(run.start, w.start);
          const overlapEnd = Math.min(run.end, w.end);
          const overlapMs = Math.max(0, overlapEnd - overlapStart);
          const overlapSec = Math.round(overlapMs / 1000);

          if (overlapSec > 0) {
            totalSec += overlapSec;
            rows.push({
              id: `loc-run-${run.start}-${w.start}`,
              title: displayName,
              text: formatDuration(overlapSec),
              time: formatRowTime(overlapStart),
            });
          }
        }
      }
    }

    return {
      value: formatDuration(totalSec),
      unit: undefined,
      rows,
      summary: T.totalUsed(formatDuration(totalSec)),
      note,
      understood: true,
    };
  }

  // 2. COUNT METRIC
  if (filter.metric === "count") {
    let totalCount = 0;
    let callCount = 0;
    let smsCount = 0;
    let replyCount = 0;
    let locCount = 0;
    let appCount = 0;
    const unit = activeKinds.length === 1 && activeKinds[0] === "sms" ? T.unitConversations : T.unitTimes;
    const rows: NlResultRow[] = [];

    // App sessions
    if (activeKinds.includes("app")) {
      for (const w of windows) {
        let sql = `SELECT id, app_package, started_at FROM commits WHERE event_type = 'APP_USAGE' AND started_at >= ? AND started_at <= ?`;
        const params: unknown[] = [w.start, w.end];
        if (filter.apps.length > 0) {
          sql += ` AND app_package IN (${filter.apps.map(() => "?").join(",")})`;
          params.push(...filter.apps);
        }
        const res = await db.query(sql, params);
        const list = res.values ?? [];
        totalCount += list.length;
        appCount += list.length;
        for (const r of list) {
          rows.push({
            id: String(r.id),
            title: resolveAppName(String(r.app_package)),
            text: T.appRun,
            time: formatRowTime(Number(r.started_at)),
          });
        }
      }
    }

    // Call count (Review 51 Must fix 2: 상대별 합계 및 관계도 라벨)
    if (activeKinds.includes("call")) {
      const isPersonSpecific = filter.people.length > 0;
      const personGroups = new Map<string, { displayName: string; count: number; lastTs: number }>();
      let unsavedCallCount = 0;
      let unsavedCallLastTs = 0;

      for (const w of windows) {
        const sql = `SELECT id, body, duration_sec, started_at FROM commits WHERE event_type = 'CALL' AND started_at >= ? AND started_at <= ?`;
        const params: unknown[] = [w.start, w.end];
        const res = await db.query(sql, params);
        for (const r of res.values ?? []) {
          let b: any = {};
          try { b = JSON.parse(String(r.body ?? "{}")); } catch {}
          const rawPhone = String(b.phoneNumber ?? "");
          if (!matchesPeopleFilter(rawPhone)) continue;

          totalCount++;
          callCount++;

          const { isSaved, displayName } = resolvePersonInfo(rawPhone, b.contactName);
          const startedAt = Number(r.started_at);

          if (isPersonSpecific) {
            rows.push({
              id: String(r.id),
              title: T.phoneCall,
              text: T.callOnce,
              time: formatRowTime(startedAt),
            });
          } else {
            if (!isSaved) {
              unsavedCallCount++;
              unsavedCallLastTs = Math.max(unsavedCallLastTs, startedAt);
            } else {
              const g = personGroups.get(displayName) ?? { displayName, count: 0, lastTs: 0 };
              g.count++;
              g.lastTs = Math.max(g.lastTs, startedAt);
              personGroups.set(displayName, g);
            }
          }
        }
      }

      if (!isPersonSpecific) {
        const sortedGroups = Array.from(personGroups.values()).sort((a, b) => b.lastTs - a.lastTs);
        for (const g of sortedGroups) {
          rows.push({
            id: `call-person-${g.displayName}`,
            title: g.displayName,
            text: T.callN(g.count),
            time: formatRowTime(g.lastTs),
          });
        }
        if (unsavedCallCount > 0) {
          rows.push({
            id: "call-unsaved-numbers",
            title: T.unsavedNumbers,
            text: T.unsavedCount(unsavedCallCount),
            time: unsavedCallLastTs > 0 ? formatRowTime(unsavedCallLastTs) : undefined,
          });
        }
      }
    }

    // SMS count (as "문자 대화 N번 대화", Review 51 Must fix 2: 상대별 합계 및 관계도 라벨)
    if (activeKinds.includes("sms")) {
      const isPersonSpecific = filter.people.length > 0;
      const personGroups = new Map<string, { displayName: string; count: number; lastTs: number }>();
      let unsavedSmsCount = 0;
      let unsavedSmsLastTs = 0;

      for (const w of windows) {
        const sql = `SELECT id, body, started_at FROM commits WHERE event_type = 'SMS' AND started_at >= ? AND started_at <= ?`;
        const params: unknown[] = [w.start, w.end];
        const res = await db.query(sql, params);
        for (const r of res.values ?? []) {
          let b: any = {};
          try { b = JSON.parse(String(r.body ?? "{}")); } catch {}
          const rawPhone = String(b.phoneNumber ?? "");
          if (!matchesPeopleFilter(rawPhone)) continue;

          totalCount++;
          smsCount++;

          const { isSaved, displayName } = resolvePersonInfo(rawPhone, b.contactName);
          const startedAt = Number(r.started_at);

          if (isPersonSpecific) {
            rows.push({
              id: String(r.id),
              title: T.smsConversation,
              text: T.smsOnce,
              time: formatRowTime(startedAt),
            });
          } else {
            if (!isSaved) {
              unsavedSmsCount++;
              unsavedSmsLastTs = Math.max(unsavedSmsLastTs, startedAt);
            } else {
              const g = personGroups.get(displayName) ?? { displayName, count: 0, lastTs: 0 };
              g.count++;
              g.lastTs = Math.max(g.lastTs, startedAt);
              personGroups.set(displayName, g);
            }
          }
        }
      }

      if (!isPersonSpecific) {
        const sortedGroups = Array.from(personGroups.values()).sort((a, b) => b.lastTs - a.lastTs);
        for (const g of sortedGroups) {
          rows.push({
            id: `sms-person-${g.displayName}`,
            title: g.displayName,
            text: T.smsN(g.count),
            time: formatRowTime(g.lastTs),
          });
        }
        if (unsavedSmsCount > 0) {
          rows.push({
            id: "sms-unsaved-numbers",
            title: T.unsavedNumbers,
            text: T.unsavedCount(unsavedSmsCount),
            time: unsavedSmsLastTs > 0 ? formatRowTime(unsavedSmsLastTs) : undefined,
          });
        }
      }
    }

    // Reply count (#3: 앱 필터 및 사람 필터 적용, NL1-6 #1: 번호형 sender 숨김)
    if (activeKinds.includes("reply")) {
      let unsavedReplyCount = 0;
      for (const w of windows) {
        const sql = `SELECT id, body, started_at FROM commits WHERE event_type = 'REPLY' AND started_at >= ? AND started_at <= ?`;
        const params: unknown[] = [w.start, w.end];
        const res = await db.query(sql, params);
        for (const r of res.values ?? []) {
          let b: any = {};
          try { b = JSON.parse(String(r.body ?? "{}")); } catch {}
          const sender = String(b.sender ?? "");
          const pkg = String(b.packageName ?? "");

          // 앱 필터 검사
          if (filter.apps.length > 0 && !filter.apps.includes(pkg)) {
            continue;
          }

          // 사람 필터 검사 (NL1-5 #3: 사람 키는 앱+이름 쌍 msg:<pkg>:<sender> 으로 엄격히 비교)
          if (filter.people.length > 0) {
            const msgKey = `msg:${pkg}:${sender}`;
            const matched = filter.people.some((k) => {
              if (k.startsWith("msg:")) return k === msgKey;
              return false;
            });
            if (!matched) continue;
          }

          totalCount++;
          replyCount++;
          if (filter.people.length === 0 && isNumberLikeSender(sender)) {
            unsavedReplyCount++;
          } else {
            rows.push({
              id: String(r.id),
              title: T.reply,
              text: T.replyOnce(sender),
              time: formatRowTime(Number(r.started_at)),
            });
          }
        }
      }
      if (unsavedReplyCount > 0) {
        rows.push({
          id: "reply-unsaved-numbers",
          title: T.reply,
          text: T.unsavedCount(unsavedReplyCount),
        });
      }
    }

    // Location visits (NL1-5 #1, NL1-6 #6, NL1-7 #2)
    if (activeKinds.includes("location")) {
      const globalReadStart = Math.min(...windows.map((w) => w.start)) - STAY_CONTEXT_MS;
      const globalReadEnd = Math.max(...windows.map((w) => w.end)) + STAY_CONTEXT_MS;
      const sql = `SELECT id, duration_sec, started_at, ended_at, geofence_name, lat, lng, body FROM commits WHERE event_type = 'LOCATION' AND started_at <= ? AND (ended_at >= ? OR started_at + duration_sec * 1000 >= ?) ORDER BY started_at ASC`;
      const params: unknown[] = [globalReadEnd, globalReadStart, globalReadStart];
      const res = await db.query(sql, params);
      const locCommits = parseLocationCommits(res.values ?? []);
      const runs = placeRuns(locCommits, extra?.dongAt);

      const seenRunKeys = new Set<string>();
      for (const run of runs) {
        const { gName, dongName, displayName } = resolveRunPlace(run, extra?.dongAt, T.unknownDong);
        if (!matchesPlaceFilter(gName, dongName, filter.places)) continue;

        const overlapsAnyWindow = windows.some((w) => {
          const overlapStart = Math.max(run.start, w.start);
          const overlapEnd = Math.min(run.end, w.end);
          return Math.round((overlapEnd - overlapStart) / 1000) > 0;
        });

        if (!overlapsAnyWindow) continue;

        const runKey = `loc-run-${run.start}`;
        if (seenRunKeys.has(runKey)) continue;
        seenRunKeys.add(runKey);

        totalCount++;
        locCount++;
        rows.push({
          id: runKey,
          title: displayName,
          text: T.visitOnce(displayName),
          time: formatRowTime(run.start),
        });
      }
    }

    let summary = T.totalCount(totalCount, unit);
    if (activeKinds.length > 1) {
      const parts: string[] = [];
      if (callCount > 0) parts.push(T.partCall(callCount));
      if (smsCount > 0) parts.push(T.partSms(smsCount));
      if (replyCount > 0) parts.push(T.partReply(replyCount));
      if (locCount > 0) parts.push(T.partVisit(locCount));
      if (appCount > 0) parts.push(T.partApp(appCount));
      if (parts.length > 0) {
        summary = `${T.totalCount(totalCount, unit)} (${parts.join(" · ")})`;
      }
    }

    return {
      value: String(totalCount),
      unit,
      rows,
      summary,
      note,
      understood: true,
    };
  }

  // 3. LIST METRIC ("뭐 했지", "누구랑", "어디" - #5: 미저장 번호 묶음, #6: LIMIT 선적용 방지 및 필터 선반영)
  const allMatchedRows: NlResultRow[] = [];
  let unsavedPhoneCount = 0;

  const targetTypes: string[] = [];
  if (filter.kinds.length === 0) {
    if (activeKinds.includes("app")) targetTypes.push("APP_USAGE");
    if (activeKinds.includes("call")) targetTypes.push("CALL");
    if (activeKinds.includes("sms")) targetTypes.push("SMS");
    if (activeKinds.includes("location")) targetTypes.push("LOCATION");
  } else {
    if (filter.kinds.includes("app")) targetTypes.push("APP_USAGE");
    if (filter.kinds.includes("call")) targetTypes.push("CALL");
    if (filter.kinds.includes("sms")) targetTypes.push("SMS");
    if (filter.kinds.includes("location")) targetTypes.push("LOCATION");
  }

  for (const w of windows) {
    const nonLocTypes = targetTypes.filter((t) => t !== "LOCATION");
    if (nonLocTypes.length > 0) {
      let sql = `SELECT id, event_type, app_package, geofence_name, body, duration_sec, started_at FROM commits WHERE started_at >= ? AND started_at <= ?`;
      const params: unknown[] = [w.start, w.end];

      sql += ` AND event_type IN (${nonLocTypes.map(() => "?").join(",")})`;
      params.push(...nonLocTypes);

      if (filter.kinds.length === 1 && filter.kinds[0] === "app" && filter.apps.length > 0) {
        sql += ` AND app_package IN (${filter.apps.map(() => "?").join(",")})`;
        params.push(...filter.apps);
      }

      sql += ` ORDER BY started_at DESC`;

      const res = await db.query(sql, params);
      for (const r of res.values ?? []) {
        const type = String(r.event_type ?? "");
        const timeStr = formatRowTime(Number(r.started_at));

        if (type === "APP_USAGE") {
          if (filter.kinds.length > 0 && !filter.kinds.includes("app")) continue;
          const pkg = String(r.app_package ?? "");
          if (filter.apps.length > 0 && !filter.apps.includes(pkg)) continue;
          allMatchedRows.push({
            id: String(r.id),
            title: resolveAppName(pkg),
            text: formatDuration(Number(r.duration_sec ?? 0)),
            time: timeStr,
            sortTs: Number(r.started_at),
          });
        } else if (type === "CALL" || type === "SMS") {
          const kind = type === "CALL" ? "call" : "sms";
          if (filter.kinds.length > 0 && !filter.kinds.includes(kind)) continue;
          let b: any = {};
          try { b = JSON.parse(String(r.body ?? "{}")); } catch {}
          const rawPhone = String(b.phoneNumber ?? "");
          if (!matchesPeopleFilter(rawPhone)) continue;

          const personKey = `tel:${normalizePhone(rawPhone)}`;
          const person = peopleMap.get(personKey) || peopleMap.get(`tel:${rawPhone}`);
          const isSaved = b.contactName ? true : (person?.saved !== false && !!person?.name && !/^\d{7,}$/.test(person.name));

          // 미저장·번호형 기본 숨김 (#5): 특정 사람 질의가 아닌 전체 목록 질의 시 묶음 표시
          if (!isSaved && filter.people.length === 0) {
            unsavedPhoneCount++;
            continue;
          }

          const labelInfo = displayLabelMap.get(personKey) || (person ? displayLabelMap.get(person.key) : undefined);
          let displayName = labelInfo?.full || b.contactName || person?.name;
          if (!displayName) {
            const norm = normalizePhone(rawPhone);
            const last4 = norm.slice(-4);
            displayName = last4 ? `…${last4}` : T.unknownNumber;
          }
          allMatchedRows.push({
            id: String(r.id),
            title: type === "CALL" ? "전화 통화" : "문자 대화",
            text: `${displayName} (${formatDuration(Number(r.duration_sec ?? 0))})`,
            time: timeStr,
            sortTs: Number(r.started_at),
          });
        }
      }
    }
  }

  // Location runs (NL1-5 #1, #4, NL1-7 #2): run 단위로 묶어 '동 이름/장소 이름 · 머문 시간' 1줄씩 표시
  if (targetTypes.includes("LOCATION")) {
    const globalReadStart = Math.min(...windows.map((w) => w.start)) - STAY_CONTEXT_MS;
    const globalReadEnd = Math.max(...windows.map((w) => w.end)) + STAY_CONTEXT_MS;
    const sql = `SELECT id, duration_sec, started_at, ended_at, geofence_name, lat, lng, body FROM commits WHERE event_type = 'LOCATION' AND started_at <= ? AND (ended_at >= ? OR started_at + duration_sec * 1000 >= ?) ORDER BY started_at ASC`;
    const params: unknown[] = [globalReadEnd, globalReadStart, globalReadStart];
    const res = await db.query(sql, params);
    const locCommits = parseLocationCommits(res.values ?? []);
    const runs = placeRuns(locCommits, extra?.dongAt);

    for (const w of windows) {
      for (const run of runs) {
        const { gName, dongName, displayName } = resolveRunPlace(run, extra?.dongAt, T.unknownDong);
        if (!matchesPlaceFilter(gName, dongName, filter.places)) continue;

        const overlapStart = Math.max(run.start, w.start);
        const overlapEnd = Math.min(run.end, w.end);
        const overlapSec = Math.max(0, Math.round((overlapEnd - overlapStart) / 1000));
        if (overlapSec <= 0) continue;

        allMatchedRows.push({
          id: `loc-run-${run.start}-${w.start}`,
          title: T.placeVisit,
          text: T.placeDur(displayName, formatDuration(overlapSec)),
          time: formatRowTime(overlapStart),
          sortTs: overlapStart,
        });
      }
    }
  }

  // 시간 역순 정렬
  allMatchedRows.sort((a, b) => (b.sortTs ?? 0) - (a.sortTs ?? 0));

  // 미저장 번호 묶음 행 추가 (#5)
  if (unsavedPhoneCount > 0) {
    allMatchedRows.push({
      id: "unsaved-phones-summary",
      title: T.unsavedNumbers,
      text: `${unsavedPhoneCount}건`,
      time: T.hiddenByDefault,
    });
  }

  const MAX_DISPLAY = 50;
  const rows = allMatchedRows.slice(0, MAX_DISPLAY);
  const totalCount = allMatchedRows.length;
  if (totalCount > MAX_DISPLAY) {
    const omitted = totalCount - MAX_DISPLAY;
    note = (note ? `${note}\n` : "") + T.omitted(omitted);
  }

  return {
    value: T.recordCount(totalCount),
    unit: undefined,
    rows,
    summary: totalCount > MAX_DISPLAY ? T.listSummaryTruncated(totalCount, MAX_DISPLAY) : T.listSummary(totalCount),
    note,
    understood: true,
  };
}
