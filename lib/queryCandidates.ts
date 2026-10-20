/**
 * 선택형 조회의 대상 후보: DB에 실제 있는 값만, 종류별로. 패널을 열 때 한 번 읽는다(기록·장소·태그가 바뀌면 다시).
 * 표시 라벨은 식별 키가 아니다: 앱은 패키지명, 사람은 tel:/msg: 키, 장소는 {source,name}으로 식별한다.
 */
import { normalizePhone, isNumberLikeSender, buildTagMaps, resolvePersonTag } from "./people";
import { getPeopleDisplayLabelMap, type SqlAdapter } from "./nlsearch";
import { resolveAppName } from "./processor/utils";

export type TagRow = { contact_name: string; tag: string; phone_number?: string | null };
export type AppCandidate = { pkg: string; label: string; totalSec: number };
export type PersonCandidate = { key: string; name: string; label: string; saved: boolean; tag: string | null; tags: string[]; lastAt: number };
export type TagCandidate = { tag: string; members: number };
export type PlaceCandidate = { source: "geofence" | "dong"; name: string; visited: boolean };
export type QueryCandidates = {
  /** 종류별 전체 기록 수: 0이면 "아직 수집된 기록 없음" */
  counts: { app: number; call: number; sms: number; reply: number; location: number };
  apps: AppCandidate[];
  call: PersonCandidate[]; sms: PersonCandidate[]; reply: PersonCandidate[];
  callTags: TagCandidate[]; smsTags: TagCandidate[];
  places: PlaceCandidate[];
  /** 실행기에 넘기는 사람 목록(표시 라벨 구분·태그 펼침용): tel: 전체 + msg: 전체 */
  people: { key: string; name: string; tag: string | null; tags: string[]; saved: boolean }[];
};

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : String(v).trim());

/** 전화번호를 보기 좋은 하이픈 형식으로 포맷 (예: 010-1234-5678, 02-1234-5678) */
export function formatPhoneNumber(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 11) {
    return digits.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3");
  }
  if (digits.length === 10) {
    if (digits.startsWith("02")) {
      return digits.replace(/(02)(\d{4})(\d{4})/, "$1-$2-$3");
    }
    return digits.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  }
  if (digits.length === 9 && digits.startsWith("02")) {
    return digits.replace(/(02)(\d{3})(\d{4})/, "$1-$2-$3");
  }
  if (digits.length === 8) {
    return digits.replace(/(\d{4})(\d{4})/, "$1-$2");
  }
  return phone;
}

export async function loadQueryCandidates(
  db: SqlAdapter,
  opts: { geofences: { name: string }[]; tags: TagRow[]; dongAt?: (lat: number, lng: number) => string | null; appLabel?: (pkg: string) => string },
): Promise<QueryCandidates> {
  const appLabel = opts.appLabel ?? resolveAppName;
  const q = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await db.query(sql, params)).values ?? [];

  const counts = { app: 0, call: 0, sms: 0, reply: 0, location: 0 };
  const typeKey: Record<string, keyof typeof counts> = { APP_USAGE: "app", CALL: "call", SMS: "sms", REPLY: "reply", LOCATION: "location" };
  for (const r of await q("SELECT event_type, COUNT(*) AS n FROM commits WHERE event_type IN ('APP_USAGE','CALL','SMS','REPLY','LOCATION') GROUP BY event_type")) {
    const k = typeKey[str(r.event_type)];
    if (k) counts[k] = Number(r.n) || 0;
  }

  // 앱: APP_USAGE만, 패키지 기준 중복 제거, 앱 이름(라벨) 가나다/알파벳 순
  const apps = (await q("SELECT app_package, SUM(duration_sec) AS sec FROM commits WHERE event_type = 'APP_USAGE' AND app_package IS NOT NULL GROUP BY app_package"))
    .map((r) => ({ pkg: str(r.app_package), label: appLabel(str(r.app_package)), totalSec: Number(r.sec) || 0 }))
    .filter((a) => a.pkg)
    .sort((a, b) => a.label.localeCompare(b.label, "ko") || a.pkg.localeCompare(b.pkg));

  // 태그 매핑 규칙: buildPeople과 동일한 헬퍼 재사용 (이름 우선, 번호 fallback)
  const { tagByName, tagByPhone } = buildTagMaps(opts.tags);

  // 통화·문자 사람: CALL+SMS 전체에서 번호별로 최신 저장 이름과 태그를 한 번 결정
  // 종류별 후보는 해당 종류 기록이 있는 사람만 추리되 이름·라벨·태그는 공통 정보 사용
  // json_valid(body) = 1로 잘못된 JSON 본문 보호
  const telMap = new Map<
    string,
    {
      phone: string;
      latestName: string;
      latestNameAt: number;
      callLastAt: number;
      smsLastAt: number;
      hasCall: boolean;
      hasSms: boolean;
    }
  >();

  const telRows = await q(
    `SELECT event_type,
            json_extract(body, '$.phoneNumber') AS phone,
            json_extract(body, '$.contactName') AS name,
            MAX(started_at) AS last
     FROM commits
     WHERE event_type IN ('CALL', 'SMS')
       AND body IS NOT NULL
       AND json_valid(body) = 1
     GROUP BY event_type, phone, name`
  );

  for (const r of telRows) {
    const phone = normalizePhone(str(r.phone));
    if (!phone) continue;
    const type = str(r.event_type);
    const name = str(r.name);
    const last = Number(r.last) || 0;

    let e = telMap.get(phone);
    if (!e) {
      e = {
        phone,
        latestName: "",
        latestNameAt: -1,
        callLastAt: 0,
        smsLastAt: 0,
        hasCall: false,
        hasSms: false,
      };
      telMap.set(phone, e);
    }

    if (type === "CALL") {
      e.hasCall = true;
      e.callLastAt = Math.max(e.callLastAt, last);
    } else if (type === "SMS") {
      e.hasSms = true;
      e.smsLastAt = Math.max(e.smsLastAt, last);
    }

    if (name && last >= e.latestNameAt) {
      e.latestName = name;
      e.latestNameAt = last;
    }
  }

  // 번호별 공통 Person 정보 생성 (이름 우선, 번호 fallback 규칙의 태그 결정)
  type TelCommon = {
    key: string;
    name: string;
    saved: boolean;
    tag: string | null;
    tags: string[];
    callLastAt: number;
    smsLastAt: number;
    hasCall: boolean;
    hasSms: boolean;
  };
  const telCommons: TelCommon[] = [];
  for (const e of telMap.values()) {
    const saved = !!e.latestName;
    const name = e.latestName || formatPhoneNumber(e.phone);
    const tag = resolvePersonTag(name, e.phone, tagByName, tagByPhone);
    const tags = tag ? [tag] : [];
    telCommons.push({
      key: `tel:${e.phone}`,
      name,
      saved,
      tag,
      tags,
      callLastAt: e.callLastAt,
      smsLastAt: e.smsLastAt,
      hasCall: e.hasCall,
      hasSms: e.hasSms,
    });
  }

  const call: PersonCandidate[] = telCommons
    .filter((c) => c.hasCall)
    .map((c) => ({
      key: c.key,
      name: c.name,
      label: c.name,
      saved: c.saved,
      tag: c.tag,
      tags: c.tags,
      lastAt: c.callLastAt,
    }));

  const sms: PersonCandidate[] = telCommons
    .filter((c) => c.hasSms)
    .map((c) => ({
      key: c.key,
      name: c.name,
      label: c.name,
      saved: c.saved,
      tag: c.tag,
      tags: c.tags,
      lastAt: c.smsLastAt,
    }));

  // 답장 사람: 앱 + sender (번호형·알 수 없음 제외, json_valid로 보호)
  const reply: PersonCandidate[] = [];
  for (const r of await q(
    `SELECT json_extract(body, '$.sender') AS sender,
            json_extract(body, '$.packageName') AS pkg,
            MAX(started_at) AS last
     FROM commits
     WHERE event_type = 'REPLY'
       AND body IS NOT NULL
       AND json_valid(body) = 1
     GROUP BY sender, pkg`
  )) {
    const sender = str(r.sender), pkg = str(r.pkg);
    if (!sender || sender === "알 수 없음" || isNumberLikeSender(sender)) continue;
    reply.push({ key: `msg:${pkg}:${sender}`, name: sender, label: sender, saved: true, tag: null, tags: [], lastAt: Number(r.last) || 0 });
  }

  const people = [
    ...telCommons.map((c) => ({ key: c.key, name: c.name, tag: c.tag, tags: c.tags, saved: c.saved })),
    ...reply.map((p) => ({ key: p.key, name: p.name, tag: p.tag, tags: p.tags, saved: p.saved })),
  ];
  const labels = getPeopleDisplayLabelMap(people);
  for (const list of [call, sms, reply]) {
    for (const p of list) {
      p.label = labels.get(p.key)?.full ?? p.name;
    }
    // 저장된 연락처(이름 있음) 먼저 -> 그 안에서 이름순, 그다음 번호만 있는 사람
    list.sort((a, b) => {
      if (a.saved !== b.saved) return a.saved ? -1 : 1;
      return a.label.localeCompare(b.label, "ko") || b.lastAt - a.lastAt;
    });
  }

  const tagsOf = (list: PersonCandidate[]): TagCandidate[] => {
    const m = new Map<string, Set<string>>();
    for (const p of list) {
      for (const t of p.tags) {
        if (!m.has(t)) m.set(t, new Set());
        m.get(t)!.add(p.key);
      }
    }
    return [...m].map(([tag, keys]) => ({ tag, members: keys.size })).sort((a, b) => a.tag.localeCompare(b.tag));
  };

  // 장소: 등록 장소(방문 기록 있는 것 먼저) + 기록에 나온 행정동
  const visited = new Set((await q("SELECT DISTINCT geofence_name FROM commits WHERE event_type = 'LOCATION' AND geofence_name IS NOT NULL")).map((r) => str(r.geofence_name)));
  const geos: PlaceCandidate[] = opts.geofences.map((g) => ({ source: "geofence" as const, name: g.name, visited: visited.has(g.name) }));
  geos.sort((a, b) => Number(b.visited) - Number(a.visited));
  const dongs = new Set<string>();
  if (opts.dongAt) {
    for (const r of await q("SELECT DISTINCT lat, lng FROM commits WHERE event_type = 'LOCATION' AND lat IS NOT NULL AND lng IS NOT NULL")) {
      const n = opts.dongAt(Number(r.lat), Number(r.lng));
      if (n) dongs.add(n);
    }
  }
  const places = [...geos, ...[...dongs].sort((a, b) => a.localeCompare(b)).map((name) => ({ source: "dong" as const, name, visited: true }))];

  return { counts, apps, call, sms, reply, callTags: tagsOf(call), smsTags: tagsOf(sms), places, people };
}
