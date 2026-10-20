/**
 * 조회 요청 모델: 선택형 패널(그리고 이후 터미널 명령)이 공유하는 하나의 입력 경계.
 * 요청 → validateRequest(날짜·기간·지원 조합) → toFilter(태그 펼침) → executeNlQuery(실행기). 해석(파싱)은 없다.
 */
import { dateKey, shiftDate } from "./today";
import { periodStart, shiftPeriodStart } from "./period";
import { isValidCalendarDate, validateFilterSupport, type NlFilter, type NlKind, type NlMetric, type NlTimeOfDay } from "./nlsearch";
import { queryText, type QueryLocale } from "./queryText";

export type QueryRequest = {
  from: string; to: string;            // YYYY-MM-DD, 기기 로컬 날짜
  timeOfDay: NlTimeOfDay;
  kind: NlKind;                        // 필수 ("전체" 없음)
  target:
    | { type: "app"; pkg: string }
    | { type: "person"; key: string }  // tel:… / msg:…
    | { type: "tag"; tag: string }     // 통화·문자만
    | { type: "place"; source: "geofence" | "dong"; name: string }
    | null;                            // 그 종류 전체
  metric: NlMetric;
};

export type QueryContext = { people: { key: string; name: string; tag?: string | null; tags?: string[]; saved?: boolean }[] };

export const MAX_RANGE_DAYS = 92;
const TIMES: NlTimeOfDay[] = ["any", "morning", "lunch", "afternoon", "evening", "night"];
const KINDS: NlKind[] = ["app", "call", "sms", "reply", "location"];
const METRICS: NlMetric[] = ["duration", "count", "list"];

export type Checked<T = undefined> = ({ ok: true } & (T extends undefined ? object : { value: T })) | { ok: false; reason: string };

/** 기간 일수(양 끝 포함). 날짜는 기기 로컬 달력 날짜이므로 UTC 정오로 계산해 DST에 흔들리지 않는다. */
function spanDays(from: string, to: string): number {
  const ms = (d: string) => { const [y, m, day] = d.split("-").map(Number); return Date.UTC(y, m - 1, day); };
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

function validDate(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return !!m && isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 태그 표기 정규화: DB의 "#가족"과 입력의 "@가족"/"가족"을 같게 본다. */
export const normalizeTag = (tag: string) => tag.normalize("NFC").trim().replace(/^[#@]+/, "");

function filterOf(req: QueryRequest, people: string[]): NlFilter {
  const t = req.target;
  return {
    from: req.from, to: req.to, timeOfDay: req.timeOfDay,
    apps: t?.type === "app" ? [t.pkg] : [],
    places: t?.type === "place" ? [{ source: t.source, name: t.name }] : [],
    people, kinds: [req.kind], metric: req.metric,
  };
}

/** 사람 키 집합을 아직 모를 때(태그)는 종류에 맞는 자리표시 키로 지원 조합만 검사한다. */
export function validateRequest(req: QueryRequest): Checked {
  if (!validDate(req.from) || !validDate(req.to)) return { ok: false, reason: "날짜가 올바르지 않습니다 (달력에 없는 날짜)" };
  if (req.from > req.to) return { ok: false, reason: "시작일이 종료일보다 늦습니다" };
  const days = spanDays(req.from, req.to);
  if (days > MAX_RANGE_DAYS) return { ok: false, reason: `기간은 최대 ${MAX_RANGE_DAYS}일까지 조회할 수 있습니다 (현재 ${days}일)` };
  if (!TIMES.includes(req.timeOfDay)) return { ok: false, reason: "알 수 없는 시간대" };
  if (!KINDS.includes(req.kind)) return { ok: false, reason: "무엇을 조회할지 선택해 주세요" };
  if (!METRICS.includes(req.metric)) return { ok: false, reason: "알 수 없는 측정 방식" };
  const t = req.target;
  let people: string[] = [];
  if (t) {
    if (t.type === "app" && req.kind !== "app") return { ok: false, reason: "앱 대상은 앱 조회에만 쓸 수 있습니다" };
    if (t.type === "place" && req.kind !== "location") return { ok: false, reason: "장소 대상은 장소 조회에만 쓸 수 있습니다" };
    if (t.type === "app" && !t.pkg) return { ok: false, reason: "앱이 비어 있습니다" };
    if (t.type === "place" && !t.name) return { ok: false, reason: "장소가 비어 있습니다" };
    if (t.type === "person") {
      if (req.kind === "app" || req.kind === "location") return { ok: false, reason: "사람 대상은 통화·문자·답장 조회에만 쓸 수 있습니다" };
      if (!t.key) return { ok: false, reason: "사람이 비어 있습니다" };
      people = [t.key];
    }
    if (t.type === "tag") {
      if (req.kind !== "call" && req.kind !== "sms") return { ok: false, reason: "태그 묶음은 통화·문자 조회에만 쓸 수 있습니다" };
      if (!normalizeTag(t.tag)) return { ok: false, reason: "태그가 비어 있습니다" };
      people = ["tel:0"]; // 자리표시: 실제 키는 toFilter에서 펼친다
    }
  }
  const support = validateFilterSupport(filterOf(req, people));
  return support.valid ? { ok: true } : { ok: false, reason: support.reason ?? "지원하지 않는 조합입니다" };
}

/** 요청 → 실행기 Filter. 태그는 그 태그가 붙은 tel: 사람 키 전부로 펼친다. 빈 태그는 전체 사람 조회로 새지 않게 막는다. */
export function toFilter(req: QueryRequest, ctx: QueryContext): Checked<NlFilter> {
  const v = validateRequest(req);
  if (!v.ok) return v;
  const t = req.target;
  if (t?.type === "tag") {
    const want = normalizeTag(t.tag);
    const keys = [
      ...new Set(
        ctx.people
          .filter(
            (p) =>
              p.key.startsWith("tel:") &&
              (p.tags?.some((tg) => normalizeTag(tg) === want) || (p.tag != null && normalizeTag(p.tag) === want))
          )
          .map((p) => p.key)
      ),
    ];
    if (keys.length === 0) return { ok: false, reason: `#${want} 태그가 붙은 사람이 없어 조회하지 않습니다` };
    return { ok: true, value: filterOf(req, keys) };
  }
  return { ok: true, value: filterOf(req, t?.type === "person" ? [t.key] : []) };
}

export type DatePreset = "today" | "yesterday" | "thisWeek" | "lastWeek" | "thisMonth" | "last7";

/**
 * 날짜 프리셋 (기기 로컬 날짜). 주는 월요일 시작(lib/period.ts의 periodStart와 같은 규칙),
 * 이번 주/이번 달은 오늘까지, "최근 7일"은 오늘을 포함한 7일(오늘-6 ~ 오늘).
 */
export function datePreset(preset: DatePreset, now = new Date()): { from: string; to: string } {
  const today = dateKey(now);
  switch (preset) {
    case "today": return { from: today, to: today };
    case "yesterday": { const y = shiftDate(today, -1); return { from: y, to: y }; }
    case "thisWeek": return { from: dateKey(periodStart("week", now)), to: today };
    case "lastWeek": {
      const start = shiftPeriodStart("week", periodStart("week", now), -1);
      return { from: dateKey(start), to: shiftDate(dateKey(start), 6) };
    }
    case "thisMonth": return { from: dateKey(periodStart("month", now)), to: today };
    case "last7": return { from: shiftDate(today, -6), to: today };
  }
}

/** 결과 카드 머리글용 요약 문장. targetLabel은 표시용(앱 라벨·사람 이름 등), 식별에는 쓰지 않는다. */
export function summarizeRequest(req: QueryRequest, targetLabel?: string, locale: QueryLocale = "ko"): string {
  const T = queryText(locale);
  const target = !req.target
    ? T.allTargets
    : req.target.type === "tag"
    ? T.tagGroup(req.target.tag)
    : (targetLabel ?? (req.target.type === "place" ? req.target.name : ""));
  return T.summarize(T.dateRange(req.from, req.to), T.timeOfDay[req.timeOfDay], T.kind[req.kind], target, T.metric[req.metric]);
}
