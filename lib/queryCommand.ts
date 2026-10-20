/**
 * 터미널 git log 확장 명령 ⇄ 조회 요청(QueryRequest) 변환 모듈 (lib/queryCommand.ts)
 * 
 * 지원 문법 (LifeCommit 앱 확장 문법):
 *   git log [--since=<날짜>] [--until=<날짜>] [--time=any|morning|lunch|afternoon|evening|night]
 *           [--type=app|call|sms|reply|location] [--app=<앱>] [--author=<사람>|--author=@<태그>]
 *           [--place=<장소>] [--count|--duration] [-n <N>]
 *   git log --grep=<키워드>
 */

import { dateKey, shiftDate } from "./today";
import { isValidCalendarDate, type NlKind, type NlMetric, type NlTimeOfDay } from "./nlsearch";
import { type QueryRequest, type Checked, validateRequest, normalizeTag } from "./query";
import type { QueryCandidates } from "./queryCandidates";
import { normalizePhone } from "./people";

export type ParsedQuery = QueryRequest & {
  limit?: number;
  isRawLog?: boolean;
  grep?: string;
};

function validDate(d: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
  return !!m && isValidCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** 날짜 문자열 파싱 (today, yesterday, N.days.ago, N.weeks.ago, YYYY-MM-DD) */
export function parseDateSpec(spec: string, now: Date): Checked<string> {
  const s = spec.trim();
  const today = dateKey(now);
  if (s === "today") return { ok: true, value: today };
  if (s === "yesterday") return { ok: true, value: shiftDate(today, -1) };

  const daysMatch = /^(\d+)\.days\.ago$/.exec(s);
  if (daysMatch) {
    const days = Number(daysMatch[1]);
    return { ok: true, value: shiftDate(today, -days) };
  }

  const weeksMatch = /^(\d+)\.weeks\.ago$/.exec(s);
  if (weeksMatch) {
    const weeks = Number(weeksMatch[1]);
    return { ok: true, value: shiftDate(today, -weeks * 7) };
  }

  if (validDate(s)) {
    return { ok: true, value: s };
  }

  return { ok: false, reason: `올바르지 않은 날짜 형식입니다: ${spec}` };
}

export type StructuralRawArgs = {
  kind: "structural";
  from: string;
  to: string;
  timeOfDay: NlTimeOfDay;
  kindType: NlKind;
  appSpec?: string;
  authorSpec?: string;
  placeSpec?: string;
  metric: NlMetric;
  limit?: number;
};

export type ParsedQueryArgs =
  | {
      kind: "raw";
      limit: number;
    }
  | {
      kind: "grep";
      keyword: string;
      limit: number;
    }
  | StructuralRawArgs;

/**
 * 터미널 토큰 배열의 구문 검증만 수행 (후보 목록 없이 동작).
 * 모르는 옵션, 중복 옵션, 값 없는 옵션, 플래그에 붙은 =값, 대상 옵션 중복, --grep 충돌, -n/--limit 정수 1~50 엄격 파싱.
 */
export function parseQueryArgs(
  rawTokens: string[],
  now = new Date()
): Checked<ParsedQueryArgs> {
  let tokens = rawTokens;
  if (tokens[0] === "git" && tokens[1] === "log") {
    tokens = tokens.slice(2);
  } else if (tokens[0] === "git" && tokens[1] === "search") {
    // git search <keyword...>
    const kw = tokens.slice(2).join(" ").trim();
    if (!kw) return { ok: false, reason: "검색어를 입력해 주세요" };
    return {
      ok: true,
      value: {
        kind: "grep",
        keyword: kw,
        limit: 10,
      },
    };
  }

  // 옵션 전혀 없음 -> 기존 git log (최근 기록 5개)
  if (tokens.length === 0) {
    return {
      ok: true,
      value: {
        kind: "raw",
        limit: 5,
      },
    };
  }

  const seenOpts = new Set<string>();
  let grep: string | undefined;
  let sinceSpec: string | undefined;
  let untilSpec: string | undefined;
  let timeSpec: string | undefined;
  let typeSpec: string | undefined;
  let appSpec: string | undefined;
  let authorSpec: string | undefined;
  let placeSpec: string | undefined;
  let countFlag = false;
  let durationFlag = false;
  let limitVal: number | undefined;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    let key = token;
    let val: string | undefined;

    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        key = token.slice(0, eqIdx);
        val = token.slice(eqIdx + 1);
      }
    } else if (token.startsWith("-n=")) {
      key = "-n";
      val = token.slice(3);
    }

    const checkDuplicate = (optName: string): { ok: false; reason: string } | null => {
      if (seenOpts.has(optName)) {
        return { ok: false, reason: `중복된 옵션입니다: ${optName}` };
      }
      seenOpts.add(optName);
      return null;
    };

    const getVal = (allowNegativeNum = false): Checked<string> => {
      if (val !== undefined) {
        if (!val.trim()) return { ok: false, reason: `옵션 값이 비어 있습니다: ${key}` };
        return { ok: true, value: val };
      }
      if (i + 1 >= tokens.length) {
        return { ok: false, reason: `옵션 값이 비어 있습니다: ${key}` };
      }
      const nextToken = tokens[i + 1];
      if (nextToken.startsWith("-")) {
        if (!(allowNegativeNum && /^-\d+$/.test(nextToken))) {
          return { ok: false, reason: `옵션 값이 비어 있습니다: ${key}` };
        }
      }
      i++;
      if (!nextToken.trim()) return { ok: false, reason: `옵션 값이 비어 있습니다: ${key}` };
      return { ok: true, value: nextToken };
    };

    switch (key) {
      case "--grep": {
        const dup = checkDuplicate("--grep");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        grep = v.value;
        break;
      }
      case "--since": {
        const dup = checkDuplicate("--since");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        const dateCheck = parseDateSpec(v.value, now);
        if (!dateCheck.ok) return dateCheck;
        sinceSpec = dateCheck.value;
        break;
      }
      case "--until": {
        const dup = checkDuplicate("--until");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        const dateCheck = parseDateSpec(v.value, now);
        if (!dateCheck.ok) return dateCheck;
        untilSpec = dateCheck.value;
        break;
      }
      case "--time": {
        const dup = checkDuplicate("--time");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        timeSpec = v.value;
        break;
      }
      case "--type": {
        const dup = checkDuplicate("--type");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        typeSpec = v.value;
        break;
      }
      case "--app": {
        const dup = checkDuplicate("--app");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        appSpec = v.value;
        break;
      }
      case "--author": {
        const dup = checkDuplicate("--author");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        authorSpec = v.value;
        break;
      }
      case "--place": {
        const dup = checkDuplicate("--place");
        if (dup) return dup;
        const v = getVal();
        if (!v.ok) return v;
        placeSpec = v.value;
        break;
      }
      case "--count": {
        if (val !== undefined) {
          return { ok: false, reason: "--count 옵션에는 값을 지정할 수 없습니다" };
        }
        const dup = checkDuplicate("--count");
        if (dup) return dup;
        countFlag = true;
        break;
      }
      case "--duration": {
        if (val !== undefined) {
          return { ok: false, reason: "--duration 옵션에는 값을 지정할 수 없습니다" };
        }
        const dup = checkDuplicate("--duration");
        if (dup) return dup;
        durationFlag = true;
        break;
      }
      case "-n":
      case "--limit": {
        const dup = checkDuplicate("-n");
        if (dup) return dup;
        const v = getVal(true);
        if (!v.ok) return v;
        const trimmed = v.value.trim();
        if (!/^\d+$/.test(trimmed)) {
          return { ok: false, reason: "-n (limit)은 1에서 50 사이의 정수여야 합니다" };
        }
        const num = Number(trimmed);
        if (!Number.isInteger(num) || num < 1 || num > 50) {
          return { ok: false, reason: "-n (limit)은 1에서 50 사이의 정수여야 합니다" };
        }
        limitVal = num;
        break;
      }
      default:
        return { ok: false, reason: `알 수 없는 옵션: ${token}` };
    }
    i++;
  }

  // 대상 옵션(--app, --author, --place)은 둘 이상 지정 시 오류
  const targetOpts = [
    appSpec !== undefined ? "--app" : null,
    authorSpec !== undefined ? "--author" : null,
    placeSpec !== undefined ? "--place" : null,
  ].filter(Boolean);
  if (targetOpts.length > 1) {
    return {
      ok: false,
      reason: `대상 옵션(${targetOpts.join(", ")})은 동시에 둘 이상 지정할 수 없습니다`,
    };
  }

  const hasStructural =
    sinceSpec !== undefined ||
    untilSpec !== undefined ||
    timeSpec !== undefined ||
    typeSpec !== undefined ||
    appSpec !== undefined ||
    authorSpec !== undefined ||
    placeSpec !== undefined ||
    countFlag ||
    durationFlag;

  if (grep !== undefined) {
    if (hasStructural) {
      return { ok: false, reason: "--grep 옵션은 다른 구조 옵션과 함께 쓸 수 없습니다" };
    }
    return {
      ok: true,
      value: {
        kind: "grep",
        keyword: grep,
        limit: limitVal ?? 10,
      },
    };
  }

  // -n 만 단독으로 주어진 경우 또는 옵션 없는 경우 -> 최근 기록 N개
  if (!hasStructural) {
    return {
      ok: true,
      value: {
        kind: "raw",
        limit: limitVal ?? 5,
      },
    };
  }

  if (countFlag && durationFlag) {
    return { ok: false, reason: "--count와 --duration은 동시에 지정할 수 없습니다" };
  }

  // 종류(kind) 결정 및 추론
  let kindType: NlKind;
  if (typeSpec) {
    const validKinds: NlKind[] = ["app", "call", "sms", "reply", "location"];
    if (!validKinds.includes(typeSpec as NlKind)) {
      return { ok: false, reason: `알 수 없는 조회 종류: ${typeSpec}` };
    }
    kindType = typeSpec as NlKind;
  } else {
    // --app만 있으면 app, --place만 있으면 location 단독 추론
    if (appSpec && !placeSpec && !authorSpec) {
      kindType = "app";
    } else if (placeSpec && !appSpec && !authorSpec) {
      kindType = "location";
    } else {
      return { ok: false, reason: "무엇을 조회할지 --type을 지정해 주세요 (app, call, sms, reply, location)" };
    }
  }

  // 시간대 파싱
  let timeOfDay: NlTimeOfDay = "any";
  if (timeSpec) {
    if (timeSpec === "all" || timeSpec === "any") {
      timeOfDay = "any";
    } else if (["morning", "lunch", "afternoon", "evening", "night"].includes(timeSpec)) {
      timeOfDay = timeSpec as NlTimeOfDay;
    } else {
      return { ok: false, reason: `알 수 없는 시간대: ${timeSpec}` };
    }
  }

  // 측정 방식 결정
  const metric: NlMetric = countFlag ? "count" : durationFlag ? "duration" : "list";

  const today = dateKey(now);
  const from = sinceSpec ?? today;
  const to = untilSpec ?? today;

  return {
    ok: true,
    value: {
      kind: "structural",
      from,
      to,
      timeOfDay,
      kindType,
      appSpec,
      authorSpec,
      placeSpec,
      metric,
      limit: limitVal,
    },
  };
}

/**
 * 구조 질의 원문 인자를 후보 목록을 기반으로 해석하여 최종 ParsedQuery 생성.
 */
export function resolveQueryArgs(
  rawArgs: StructuralRawArgs,
  candidates: QueryCandidates
): Checked<ParsedQuery> {
  const { kindType, appSpec, authorSpec, placeSpec, from, to, timeOfDay, metric, limit } = rawArgs;

  // 대상(target) 해석
  let target: QueryRequest["target"] = null;

  if (appSpec) {
    if (kindType !== "app") {
      return { ok: false, reason: "앱 대상은 앱 조회에만 쓸 수 있습니다" };
    }
    const norm = appSpec.normalize("NFC").trim().toLowerCase();
    // 1) 패키지명 일치
    const pkgMatch = candidates.apps.find((a) => a.pkg.normalize("NFC").trim().toLowerCase() === norm);
    if (pkgMatch) {
      target = { type: "app", pkg: pkgMatch.pkg };
    } else {
      // 2) 라벨 일치
      const labelMatches = candidates.apps.filter((a) => a.label.normalize("NFC").trim().toLowerCase() === norm);
      if (labelMatches.length > 1) {
        return {
          ok: false,
          reason: `모호한 앱 이름입니다: '${appSpec}' (후보 패키지: ${labelMatches.map((a) => a.pkg).join(", ")})`,
        };
      }
      if (labelMatches.length === 1) {
        target = { type: "app", pkg: labelMatches[0].pkg };
      } else {
        // 포함 일치 후보 최대 5개
        const partial = candidates.apps
          .filter(
            (a) =>
              a.label.normalize("NFC").toLowerCase().includes(norm) ||
              a.pkg.normalize("NFC").toLowerCase().includes(norm)
          )
          .slice(0, 5);
        if (partial.length > 0) {
          return {
            ok: false,
            reason: `해당하는 앱을 찾을 수 없습니다: '${appSpec}' (비슷한 후보: ${partial.map((a) => a.label || a.pkg).join(", ")})`,
          };
        }
        return { ok: false, reason: `해당하는 앱을 찾을 수 없습니다: '${appSpec}'` };
      }
    }
  }

  if (authorSpec) {
    if (authorSpec.startsWith("@")) {
      const tag = normalizeTag(authorSpec);
      if (!tag) return { ok: false, reason: "태그가 비어 있습니다" };
      target = { type: "tag", tag };
    } else {
      if (kindType !== "call" && kindType !== "sms" && kindType !== "reply") {
        return { ok: false, reason: "사람 대상은 통화·문자·답장 조회에만 쓸 수 있습니다" };
      }
      const list = candidates[kindType] || [];

      // 1) tel: 또는 msg: 키 직접 입력
      if (authorSpec.startsWith("tel:") || authorSpec.startsWith("msg:")) {
        const directMatches = list.filter((p) => p.key === authorSpec);
        if (directMatches.length === 0) {
          return { ok: false, reason: `해당하는 키의 사람을 찾을 수 없습니다: '${authorSpec}'` };
        }
        target = { type: "person", key: directMatches[0].key };
      } else {
        // 2) 전화번호 표기: 입력 전체가 숫자, +, -, 공백, 괄호로만 구성되어 있을 때만 번호 경로
        const isPhonePattern = /^[0-9+\-()\s]+$/.test(authorSpec.trim());
        const normPhone = normalizePhone(authorSpec);

        if (isPhonePattern && normPhone && normPhone.length >= 7) {
          // tel: 키의 번호 부분과만 비교 (msg 키나 이름에서 숫자 추출 금지)
          const byPhone = list.filter((p) => {
            if (!p.key.startsWith("tel:")) return false;
            return normalizePhone(p.key.replace(/^tel:/, "")) === normPhone;
          });

          if (byPhone.length === 0) {
            return { ok: false, reason: `해당하는 전화번호의 사람을 찾을 수 없습니다: '${authorSpec}'` };
          }
          const uniqueKeys = new Set(byPhone.map((p) => p.key));
          if (uniqueKeys.size > 1) {
            return {
              ok: false,
              reason: `동일한 전화번호의 후보가 여러 명 있습니다: '${authorSpec}' (후보: ${byPhone.map((p) => p.label || p.name).join(", ")})`,
            };
          }
          target = { type: "person", key: byPhone[0].key };
        } else {
          // 3) 일반 이름 / 라벨 정확 일치 경로
          const norm = authorSpec.normalize("NFC").trim().toLowerCase();
          const matches = list.filter(
            (p) =>
              p.name.normalize("NFC").trim().toLowerCase() === norm ||
              p.label.normalize("NFC").trim().toLowerCase() === norm
          );

          if (matches.length === 0) {
            return { ok: false, reason: `해당하는 사람을 찾을 수 없습니다: '${authorSpec}'` };
          }
          const uniqueKeys = new Set(matches.map((p) => p.key));
          if (uniqueKeys.size > 1) {
            return {
              ok: false,
              reason: `동명이인이 있습니다: '${authorSpec}' (후보: ${matches.map((p) => p.label || p.name).join(", ")})`,
            };
          }
          target = { type: "person", key: matches[0].key };
        }
      }
    }
  }

  if (placeSpec) {
    if (kindType !== "location") {
      return { ok: false, reason: "장소 대상은 장소 조회에만 쓸 수 있습니다" };
    }
    let prefix: "geofence" | "dong" | null = null;
    let searchName = placeSpec;
    if (placeSpec.startsWith("geofence:")) {
      prefix = "geofence";
      searchName = placeSpec.slice("geofence:".length);
    } else if (placeSpec.startsWith("dong:")) {
      prefix = "dong";
      searchName = placeSpec.slice("dong:".length);
    }
    const norm = searchName.normalize("NFC").trim().toLowerCase();

    if (prefix) {
      const match = candidates.places.find(
        (p) => p.source === prefix && p.name.normalize("NFC").trim().toLowerCase() === norm
      );
      if (!match) return { ok: false, reason: `해당하는 장소를 찾을 수 없습니다: '${placeSpec}'` };
      target = { type: "place", source: prefix, name: match.name };
    } else {
      const geoMatch = candidates.places.find(
        (p) => p.source === "geofence" && p.name.normalize("NFC").trim().toLowerCase() === norm
      );
      const dongMatch = candidates.places.find(
        (p) => p.source === "dong" && p.name.normalize("NFC").trim().toLowerCase() === norm
      );

      if (geoMatch && dongMatch) {
        return {
          ok: false,
          reason: `'${placeSpec}'은 등록 장소와 행정동에 모두 존재합니다. --place=geofence:${placeSpec} 또는 --place=dong:${placeSpec} 형태로 지정해 주세요`,
        };
      }
      if (geoMatch) {
        target = { type: "place", source: "geofence", name: geoMatch.name };
      } else if (dongMatch) {
        target = { type: "place", source: "dong", name: dongMatch.name };
      } else {
        return { ok: false, reason: `해당하는 장소를 찾을 수 없습니다: '${placeSpec}'` };
      }
    }
  }

  const req: QueryRequest = {
    from,
    to,
    timeOfDay,
    kind: kindType,
    target,
    metric,
  };

  const valCheck = validateRequest(req);
  if (!valCheck.ok) return valCheck;

  return {
    ok: true,
    value: {
      ...req,
      limit,
    },
  };
}

/**
 * 터미널 토큰 배열을 분석하여 QueryRequest로 변환 (parseQueryArgs -> resolveQueryArgs 래퍼).
 */
export function parseQueryCommand(
  rawTokens: string[],
  candidates: QueryCandidates,
  now = new Date()
): Checked<ParsedQuery> {
  const parsed = parseQueryArgs(rawTokens, now);
  if (!parsed.ok) return parsed;

  if (parsed.value.kind === "raw") {
    const today = dateKey(now);
    return {
      ok: true,
      value: {
        from: today,
        to: today,
        timeOfDay: "any",
        kind: "app",
        target: null,
        metric: "list",
        isRawLog: true,
        limit: parsed.value.limit,
      },
    };
  }

  if (parsed.value.kind === "grep") {
    const today = dateKey(now);
    return {
      ok: true,
      value: {
        from: today,
        to: today,
        timeOfDay: "any",
        kind: "app",
        target: null,
        metric: "list",
        grep: parsed.value.keyword,
        limit: parsed.value.limit,
      },
    };
  }

  return resolveQueryArgs(parsed.value, candidates);
}

/** 인자 이스케이프 포맷터 (공백, 따옴표, 역슬래시 포함 시 큰따옴표로 감쌈) */
function formatArg(key: string, val: string): string {
  if (/[\s"'\\@]/.test(val)) {
    const escaped = val.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${key}="${escaped}"`;
  }
  return `${key}=${val}`;
}

/**
 * QueryRequest를 git log 명령 문자열로 직렬화.
 */
export function formatQueryCommand(
  req: QueryRequest,
  candidates?: QueryCandidates,
  now = new Date()
): string {
  const parts: string[] = ["git", "log"];

  const today = dateKey(now);
  const yesterday = shiftDate(today, -1);

  if (req.from === today && req.to === today) {
    parts.push("--since=today", "--until=today");
  } else if (req.from === yesterday && req.to === yesterday) {
    parts.push("--since=yesterday", "--until=yesterday");
  } else {
    parts.push(`--since=${req.from}`, `--until=${req.to}`);
  }

  if (req.timeOfDay !== "any") {
    parts.push(`--time=${req.timeOfDay}`);
  }

  parts.push(`--type=${req.kind}`);

  if (req.target) {
    const t = req.target;
    if (t.type === "app") {
      parts.push(formatArg("--app", t.pkg));
    } else if (t.type === "person") {
      if (t.key.startsWith("tel:")) {
        parts.push(formatArg("--author", t.key.replace(/^tel:/, "")));
      } else {
        parts.push(formatArg("--author", t.key));
      }
    } else if (t.type === "tag") {
      const tagStr = `@${normalizeTag(t.tag)}`;
      parts.push(formatArg("--author", tagStr));
    } else if (t.type === "place") {
      const placeVal = `${t.source}:${t.name}`;
      parts.push(formatArg("--place", placeVal));
    }
  }

  if (req.metric === "count") {
    parts.push("--count");
  } else if (req.metric === "duration") {
    parts.push("--duration");
  }

  return parts.join(" ");
}
