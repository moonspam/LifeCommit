"use client";

import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { getDB } from "@/lib/db";
import { getFlavor, type Flavor } from "@/lib/flavor";
import { subscribe, EVENT_COMMITS_UPDATED } from "@/lib/events";
import { type NlQueryResult, type NlKind, type NlMetric, type NlTimeOfDay, TIME_OF_DAY_UI_LABELS } from "@/lib/nlsearch";
import { type QueryRequest, type DatePreset, datePreset, validateRequest, summarizeRequest, normalizeTag } from "@/lib/query";
import { type QueryCandidates } from "@/lib/queryCandidates";
import { loadQueryContext, runQuery } from "@/lib/queryRun";

import {
  computeTargetSearchKeyAction,
  getTargetActiveOptionId,
  getActiveOptionId,
  dismissAutocompleteNav,
  isOptionHighlighted,
  clampHighlightIdx,
} from "@/lib/autocomplete";

interface AskPanelProps {
  isReady: boolean;
  onClose: () => void;
}

interface QueryHistoryItem {
  id: string;
  summary: string;
  timestamp: string;
  result: NlQueryResult;
}

/** UI 표시 텍스트 모음 (ko) */
const UI_TEXT = {
  headerTitle: "기록 조회",
  closeButton: "닫기",
  sectionWhen: "언제",
  sectionTime: "시간대",
  sectionWhat: "무엇을",
  sectionTarget: "대상",
  sectionHowMuch: "얼마나",
  dateDirect: "직접 입력",
  allTarget: "전체 (지정 없음)",
  presets: {
    today: "오늘",
    yesterday: "어제",
    thisWeek: "이번 주",
    lastWeek: "지난 주",
    thisMonth: "이번 달",
    last7: "최근 7일",
  } as Record<DatePreset, string>,
  times: TIME_OF_DAY_UI_LABELS,
  kinds: {
    app: "앱 사용",
    call: "통화",
    sms: "문자",
    reply: "답장",
    location: "장소·체류",
  } as Record<NlKind, string>,
  metrics: {
    duration: "시간 합계",
    count: "횟수",
    list: "기록 목록",
  } as Record<NlMetric, string>,
  btnExecute: "조회하기",
  loadingCandidates: "후보 목록 불러오는 중...",
  loadCandidatesError: "후보를 불러오는 중 오류가 발생했습니다.",
  noRecords: "아직 수집된 기록 없음",
  ossNotSupported: "이 빌드에서는 수집하지 않음",
  searchPlaceholder: "대상 검색...",
  noSearchResults: "일치하는 대상 없음",
  evidenceLabel: "근거 기록",
  noVisits: "방문 기록 없음",
  dbNotReady: "데이터베이스가 준비되지 않았습니다.",
  queryExecuting: "조회 및 계산 중...",
};

export default function AskPanel({ isReady, onClose }: AskPanelProps) {
  // 날짜 설정
  const [activePreset, setActivePreset] = useState<DatePreset | null>("today");
  const [fromDate, setFromDate] = useState(() => datePreset("today").from);
  const [toDate, setToDate] = useState(() => datePreset("today").to);

  // 시간대
  const [timeOfDay, setTimeOfDay] = useState<NlTimeOfDay>("any");

  // 종류 및 대상
  const [kind, setKind] = useState<NlKind>("app");
  const [target, setTarget] = useState<QueryRequest["target"]>(null);
  const [targetLabel, setTargetLabel] = useState<string>("");

  // 측정 방식
  const [metric, setMetric] = useState<NlMetric>("duration");

  // 대상 검색창 검색어
  const [targetSearch, setTargetSearch] = useState("");
  const [searchHighlightIdx, setSearchHighlightIdx] = useState(0);
  const [isKeyboardNav, setIsKeyboardNav] = useState(false);

  // 실행 및 결과 상태
  const [executing, setExecuting] = useState(false);
  const [history, setHistory] = useState<QueryHistoryItem[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  // flavor 및 후보 데이터
  const [flavor, setFlavor] = useState<Flavor>("full");
  const [candidates, setCandidates] = useState<QueryCandidates | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);

  const dongAtRef = useRef<((lat: number, lng: number) => string | null) | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // flavor 감지
  useEffect(() => {
    getFlavor().then(setFlavor).catch(() => setFlavor("full"));
  }, []);

  // 후보 데이터 로드 함수
  const reloadCandidates = useCallback(async () => {
    if (!isReady) return;
    setCandidatesLoading(true);
    setCandidatesError(null);
    try {
      const db = getDB();
      const qctx = await loadQueryContext(db);
      dongAtRef.current = qctx.dongAt ?? null;
      setCandidates(qctx.candidates);

      // 재로딩 후 선택된 태그가 사라졌으면 선택 해제 (빈 집합 조회 방지)
      setTarget((prev) => {
        if (prev?.type === "tag") {
          const want = normalizeTag(prev.tag);
          const hasTag = qctx.candidates.people.some(
            (p) => p.tags?.some((tg) => normalizeTag(tg) === want) || (p.tag != null && normalizeTag(p.tag) === want)
          );
          if (!hasTag) {
            setTargetLabel("");
            setTargetSearch("");
            return null;
          }
        }
        return prev;
      });
    } catch (err: any) {
      console.error("[AskPanel] reloadCandidates error:", err);
      setCandidatesError(err?.message || String(err));
    } finally {
      setCandidatesLoading(false);
    }
  }, [isReady]);

  // 마운트 시 후보 로드 및 EVENT_COMMITS_UPDATED 구독
  useEffect(() => {
    reloadCandidates();
    const unsubscribe = subscribe(EVENT_COMMITS_UPDATED, reloadCandidates);
    return () => unsubscribe();
  }, [reloadCandidates]);

  // 프리셋 선택 핸들러
  const handleSelectPreset = (p: DatePreset) => {
    setActivePreset(p);
    const range = datePreset(p);
    setFromDate(range.from);
    setToDate(range.to);
    setValidationError(null);
  };

  // 날짜 직접 입력 변경 핸들러
  const handleFromChange = (val: string) => {
    setActivePreset(null);
    setFromDate(val);
    setValidationError(null);
  };

  const handleToChange = (val: string) => {
    setActivePreset(null);
    setToDate(val);
    setValidationError(null);
  };

  // 종류(무엇을) 변경 핸들러: 대상과 메트릭 초기화
  const handleSelectKind = (nextKind: NlKind) => {
    setKind(nextKind);
    setTarget(null);
    setTargetLabel("");
    setTargetSearch("");
    setIsKeyboardNav(false);
    setSearchHighlightIdx(0);
    setValidationError(null);

    // 종류에 따른 기본 metric 설정 및 지원 여부 검증
    const defaultMetric: NlMetric = nextKind === "sms" || nextKind === "reply" ? "count" : "duration";
    const testReq: QueryRequest = {
      from: fromDate,
      to: toDate,
      timeOfDay,
      kind: nextKind,
      target: null,
      metric: defaultMetric,
    };
    const check = validateRequest(testReq);
    if (check.ok) {
      setMetric(defaultMetric);
    } else {
      // 대안 metric 찾기
      const fallbackMetrics: NlMetric[] = ["count", "list", "duration"];
      const validFallback = fallbackMetrics.find((m) => validateRequest({ ...testReq, metric: m }).ok);
      if (validFallback) setMetric(validFallback);
    }
  };

  // 대상 선택 핸들러
  const handleSelectTarget = (nextTarget: QueryRequest["target"], label: string, summaryName?: string) => {
    setTarget(nextTarget);
    setTargetLabel(summaryName ?? label);
    setIsKeyboardNav(false);
    setValidationError(null);

    // 대상 변경 후 현재 metric이 유효하지 않으면 조정
    const testReq: QueryRequest = {
      from: fromDate,
      to: toDate,
      timeOfDay,
      kind,
      target: nextTarget,
      metric,
    };
    if (!validateRequest(testReq).ok) {
      const fallbackMetrics: NlMetric[] = ["duration", "count", "list"];
      const validFallback = fallbackMetrics.find((m) => validateRequest({ ...testReq, metric: m }).ok);
      if (validFallback) setMetric(validFallback);
    }
  };

  // 현재 종류에 대한 대상 후보 목록
  const currentTargetItems = useMemo(() => {
    if (!candidates) return [];
    if (kind === "app") {
      return candidates.apps.map((a) => ({
        key: `app:${a.pkg}`,
        label: a.label,
        summaryName: a.label,
        sub: a.pkg !== a.label ? a.pkg : undefined,
        target: { type: "app" as const, pkg: a.pkg },
      }));
    }
    if (kind === "call") {
      const tags = candidates.callTags.map((t) => ({
        key: `tag:${t.tag}`,
        label: `🏷 #${normalizeTag(t.tag)} (${t.members}명)`,
        summaryName: `#${normalizeTag(t.tag)}`,
        sub: "태그 묶음",
        target: { type: "tag" as const, tag: t.tag },
      }));
      const people = candidates.call.map((p) => ({
        key: p.key,
        label: p.label,
        summaryName: p.label,
        sub: p.tag ? `#${normalizeTag(p.tag)}` : undefined,
        target: { type: "person" as const, key: p.key },
      }));
      return [...tags, ...people];
    }
    if (kind === "sms") {
      const tags = candidates.smsTags.map((t) => ({
        key: `tag:${t.tag}`,
        label: `🏷 #${normalizeTag(t.tag)} (${t.members}명)`,
        summaryName: `#${normalizeTag(t.tag)}`,
        sub: "태그 묶음",
        target: { type: "tag" as const, tag: t.tag },
      }));
      const people = candidates.sms.map((p) => ({
        key: p.key,
        label: p.label,
        summaryName: p.label,
        sub: p.tag ? `#${normalizeTag(p.tag)}` : undefined,
        target: { type: "person" as const, key: p.key },
      }));
      return [...tags, ...people];
    }
    if (kind === "reply") {
      return candidates.reply.map((p) => ({
        key: p.key,
        label: p.label,
        summaryName: p.label,
        sub: undefined,
        target: { type: "person" as const, key: p.key },
      }));
    }
    if (kind === "location") {
      return candidates.places.map((pl) => ({
        key: `place:${pl.source}:${pl.name}`,
        label: `${pl.source === "geofence" ? "📍 " : "🗺 "}${pl.name}`,
        summaryName: pl.name,
        sub: pl.source === "geofence" ? (!pl.visited ? UI_TEXT.noVisits : undefined) : "행정동",
        target: { type: "place" as const, source: pl.source, name: pl.name },
      }));
    }
    return [];
  }, [candidates, kind]);

  // 검색어로 걸러진 대상 후보
  const filteredTargetItems = useMemo(() => {
    const q = targetSearch.trim().normalize("NFC").toLowerCase();
    if (!q) return currentTargetItems;
    return currentTargetItems.filter(
      (item) =>
        item.label.normalize("NFC").toLowerCase().includes(q) ||
        (item.sub && item.sub.normalize("NFC").toLowerCase().includes(q))
    );
  }, [currentTargetItems, targetSearch]);

  // oss 빌드에서 지원하지 않는 종류인지 판정
  const isOssUnsupportedKind = flavor === "oss" && kind !== "app";

  // 기록이 전혀 없는지 판정
  const hasNoRecordsForKind =
    !isOssUnsupportedKind &&
    candidates &&
    candidates.counts[kind] === 0;

  // metric 옵션 유효성 검사 헬퍼
  const getMetricSupport = (m: NlMetric) => {
    const testReq: QueryRequest = {
      from: fromDate,
      to: toDate,
      timeOfDay,
      kind,
      target,
      metric: m,
    };
    return validateRequest(testReq);
  };

  // 실행 핸들러: 공용 runQuery 함수 사용
  const handleExecute = async () => {
    if (!isReady || !candidates) {
      setValidationError(UI_TEXT.dbNotReady);
      return;
    }
    const req: QueryRequest = {
      from: fromDate,
      to: toDate,
      timeOfDay,
      kind,
      target,
      metric,
    };

    setValidationError(null);
    setExecuting(true);

    try {
      const db = getDB();
      const qctx = { candidates, dongAt: dongAtRef.current ?? undefined };
      const runRes = await runQuery(req, db, qctx);
      if (!runRes.ok) {
        setValidationError(runRes.reason);
        return;
      }

      const summary = summarizeRequest(req, targetLabel || undefined, "ko");
      const timeStr = new Date().toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      });

      setHistory((prev) => [
        ...prev,
        {
          id: `query-${Date.now()}`,
          summary,
          timestamp: timeStr,
          result: runRes.value,
        },
      ]);
    } catch (err: any) {
      console.error("[AskPanel] Execution error:", err);
      setValidationError(`조회 중 오류가 발생했습니다: ${err?.message || String(err)}`);
    } finally {
      setExecuting(false);
    }
  };

  // 스크롤 맨 아래로 이동
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history, executing]);

  // 대상 검색창 키보드 탐색 핸들러 (순수 헬퍼 computeTargetSearchKeyAction 사용)
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const action = computeTargetSearchKeyAction(e.key, searchHighlightIdx, filteredTargetItems.length);
    if (action.action === "reset") {
      e.preventDefault();
      setTargetSearch("");
      setIsKeyboardNav(false);
      setSearchHighlightIdx(0);
    } else if (action.action === "down" || action.action === "up") {
      e.preventDefault();
      setIsKeyboardNav(true);
      setSearchHighlightIdx(action.nextIdx);
    } else if (action.action === "select") {
      e.preventDefault();
      const item = filteredTargetItems[action.nextIdx];
      if (item) {
        handleSelectTarget(item.target, item.label, item.summaryName);
      }
    }
  };

  // 후보 수가 축소되었을 때 유효 범위로 clamp
  useEffect(() => {
    if (filteredTargetItems.length > 0 && searchHighlightIdx >= filteredTargetItems.length) {
      setSearchHighlightIdx(clampHighlightIdx(searchHighlightIdx, filteredTargetItems.length));
    }
  }, [filteredTargetItems.length, searchHighlightIdx]);

  // 활성 대상 항목이 뷰포트에 보이도록 스크롤 유지
  useEffect(() => {
    if (currentTargetItems.length > 8 && filteredTargetItems.length > 0) {
      const activeEl = document.getElementById(getTargetActiveOptionId(searchHighlightIdx, filteredTargetItems.length, "target-opt") ?? "");
      activeEl?.scrollIntoView({ block: "nearest" });
    }
  }, [searchHighlightIdx, filteredTargetItems.length, currentTargetItems.length]);

  return (
    <div className="flex flex-col h-full font-mono text-[10px] bg-terminal-black">
      {/* 헤더 바 */}
      <div className="flex items-center justify-between px-3 py-2 bg-terminal-surface border-b border-terminal-border select-none">
        <div className="flex items-center gap-2">
          <span className="text-terminal-yellow text-xs font-bold">✦ {UI_TEXT.headerTitle}</span>
        </div>
        <button
          onClick={onClose}
          className="text-terminal-gray hover:text-terminal-white p-1 rounded-sm hover:bg-terminal-border/40 transition-colors"
          title={UI_TEXT.closeButton}
        >
          ✕
        </button>
      </div>

      {/* 메인 스크롤 콘텐츠 */}
      <div className="flex-1 overflow-y-auto px-3 py-2.5 space-y-3 scrollbar-hide text-terminal-white">
        {/* ── 빌더 폼 ── */}
        <div className="bg-[#10131a] border border-terminal-border/80 rounded-sm p-2.5 space-y-2.5">
          {/* 1. 언제 */}
          <div className="space-y-1">
            <span className="text-[10px] text-terminal-gray font-bold">{UI_TEXT.sectionWhen}</span>
            <div className="flex flex-wrap gap-1">
              {(["today", "yesterday", "thisWeek", "lastWeek", "thisMonth", "last7"] as DatePreset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => handleSelectPreset(p)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    activePreset === p
                      ? "bg-terminal-green/20 text-terminal-green border-terminal-green/50 font-bold"
                      : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
                  }`}
                >
                  {UI_TEXT.presets[p]}
                </button>
              ))}
            </div>
            {/* 날짜 직접 입력 (360px 대응 grid) */}
            <div className="grid grid-cols-2 gap-1.5 pt-1">
              <input
                type="date"
                value={fromDate}
                onChange={(e) => handleFromChange(e.target.value)}
                className="bg-[#090b10] border border-terminal-border/60 rounded-sm px-1.5 py-0.5 text-[10px] text-terminal-white outline-hidden focus:border-terminal-green/60"
                title="시작 날짜"
              />
              <input
                type="date"
                value={toDate}
                onChange={(e) => handleToChange(e.target.value)}
                className="bg-[#090b10] border border-terminal-border/60 rounded-sm px-1.5 py-0.5 text-[10px] text-terminal-white outline-hidden focus:border-terminal-green/60"
                title="종료 날짜"
              />
            </div>
          </div>

          {/* 2. 시간대 */}
          <div className="space-y-1 pt-1 border-t border-terminal-border/30">
            <span className="text-[10px] text-terminal-gray font-bold">{UI_TEXT.sectionTime}</span>
            <div className="flex flex-wrap gap-1">
              {(["any", "morning", "lunch", "afternoon", "evening", "night"] as NlTimeOfDay[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTimeOfDay(t)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    timeOfDay === t
                      ? "bg-terminal-yellow/20 text-terminal-yellow border-terminal-yellow/50 font-bold"
                      : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
                  }`}
                >
                  {UI_TEXT.times[t]}
                </button>
              ))}
            </div>
          </div>

          {/* 3. 무엇을 */}
          <div className="space-y-1 pt-1 border-t border-terminal-border/30">
            <span className="text-[10px] text-terminal-gray font-bold">{UI_TEXT.sectionWhat}</span>
            <div className="flex flex-wrap gap-1">
              {(["app", "call", "sms", "reply", "location"] as NlKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => handleSelectKind(k)}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    kind === k
                      ? "bg-terminal-blue/20 text-terminal-blue border-terminal-blue/50 font-bold"
                      : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
                  }`}
                >
                  {UI_TEXT.kinds[k]}
                </button>
              ))}
            </div>
          </div>

          {/* 4. 대상 */}
          <div className="space-y-1 pt-1 border-t border-terminal-border/30">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-terminal-gray font-bold">{UI_TEXT.sectionTarget}</span>
              {candidatesLoading && (
                <span className="text-[9px] text-terminal-yellow animate-spin">◌</span>
              )}
            </div>

            {/* oss 미지원 안내 */}
            {isOssUnsupportedKind ? (
              <div className="text-[10px] text-terminal-gray/80 bg-[#161a23] p-2 rounded-sm border border-terminal-border/30">
                {UI_TEXT.ossNotSupported}
              </div>
            ) : candidatesError ? (
              <div className="text-[10px] text-terminal-red bg-terminal-red/10 p-2 rounded-sm border border-terminal-red/20">
                {UI_TEXT.loadCandidatesError}
              </div>
            ) : hasNoRecordsForKind ? (
              <div className="text-[10px] text-terminal-gray/80 bg-[#161a23] p-2 rounded-sm border border-terminal-border/30">
                {UI_TEXT.noRecords}
              </div>
            ) : (
              <div className="space-y-1.5">
                {/* 전체 선택 버튼 */}
                <button
                  type="button"
                  onClick={() => handleSelectTarget(null, "")}
                  className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                    target === null
                      ? "bg-terminal-green/20 text-terminal-green border-terminal-green/50 font-bold"
                      : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
                  }`}
                >
                  {UI_TEXT.allTarget}
                </button>

                {/* 8개 초과 시 자체 검색창 (키보드 지원, datalist 금지) */}
                {currentTargetItems.length > 8 && (
                  <div className="pt-0.5">
                    <input
                      ref={searchInputRef}
                      type="text"
                      role="combobox"
                      aria-autocomplete="list"
                      aria-controls="target-candidates-listbox"
                      aria-expanded={currentTargetItems.length > 0}
                      aria-activedescendant={getActiveOptionId(true, isKeyboardNav, searchHighlightIdx, filteredTargetItems.length, "target-opt")}
                      value={targetSearch}
                      onChange={(e) => {
                        setTargetSearch(e.target.value);
                        setIsKeyboardNav(false);
                        setSearchHighlightIdx(0);
                      }}
                      onFocus={() => {
                        setIsKeyboardNav(false);
                        setSearchHighlightIdx(0);
                      }}
                      onBlur={() => {
                        setIsKeyboardNav(dismissAutocompleteNav);
                      }}
                      onKeyDown={handleSearchKeyDown}
                      placeholder={UI_TEXT.searchPlaceholder}
                      aria-label="대상 검색"
                      className="w-full bg-[#090b10] border border-terminal-border/60 rounded-sm px-2 py-0.5 text-[10px] text-terminal-white placeholder-terminal-gray outline-hidden focus:border-terminal-blue/60"
                    />
                  </div>
                )}

                {/* 대상 후보 목록 */}
                <div
                  id="target-candidates-listbox"
                  role="listbox"
                  aria-label="대상 목록"
                  className="flex flex-wrap gap-1 max-h-32 overflow-y-auto p-1 bg-[#090b10] border border-terminal-border/40 rounded-sm scrollbar-hide"
                >
                  {filteredTargetItems.length === 0 ? (
                    <div className="text-[9px] text-terminal-gray p-1">{UI_TEXT.noSearchResults}</div>
                  ) : (
                    filteredTargetItems.map((item, idx) => {
                      const isSelected =
                        target !== null &&
                        ((target.type === "app" && item.target.type === "app" && target.pkg === item.target.pkg) ||
                          (target.type === "person" && item.target.type === "person" && target.key === item.target.key) ||
                          (target.type === "tag" && item.target.type === "tag" && target.tag === item.target.tag) ||
                          (target.type === "place" &&
                            item.target.type === "place" &&
                            target.source === item.target.source &&
                            target.name === item.target.name));

                      // 키보드 탐색 중일 때만 시각 강조 표시
                      const isHighlighted = isOptionHighlighted(isKeyboardNav, idx, searchHighlightIdx);

                      return (
                        <button
                          key={item.key}
                          id={getTargetActiveOptionId(idx, filteredTargetItems.length, "target-opt")}
                          role="option"
                          aria-selected={isSelected}
                          type="button"
                          onClick={() => handleSelectTarget(item.target, item.label, item.summaryName)}
                          className={`px-1.5 py-0.5 rounded text-[10px] border transition-colors flex items-center gap-1 ${
                            isSelected
                              ? "bg-terminal-green/20 text-terminal-green border-terminal-green/50 font-bold"
                              : isHighlighted
                              ? "bg-terminal-surface text-terminal-white border-terminal-blue/50"
                              : "text-terminal-gray border-terminal-border/40 hover:text-terminal-white hover:bg-terminal-surface/60"
                          }`}
                        >
                          <span className="truncate max-w-[160px]">{item.label}</span>
                          {item.sub && (
                            <span className="text-[8px] text-terminal-gray/70 shrink-0">({item.sub})</span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 5. 얼마나 */}
          <div className="space-y-1 pt-1 border-t border-terminal-border/30">
            <span className="text-[10px] text-terminal-gray font-bold">{UI_TEXT.sectionHowMuch}</span>
            <div className="flex flex-wrap gap-1">
              {(["duration", "count", "list"] as NlMetric[]).map((m) => {
                const support = getMetricSupport(m);
                const isSelected = metric === m;
                const isDisabled = !support.ok;

                return (
                  <button
                    key={m}
                    type="button"
                    disabled={isDisabled}
                    title={isDisabled ? support.reason : undefined}
                    onClick={() => {
                      if (!isDisabled) setMetric(m);
                    }}
                    className={`px-2 py-0.5 rounded text-[10px] border transition-colors ${
                      isSelected
                        ? "bg-terminal-yellow/20 text-terminal-yellow border-terminal-yellow/50 font-bold"
                        : isDisabled
                        ? "text-terminal-gray/30 border-terminal-border/20 cursor-not-allowed bg-transparent"
                        : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
                    }`}
                  >
                    {UI_TEXT.metrics[m]}
                  </button>
                );
              })}
            </div>
            {/* 현재 선택된 조합이 불가능할 경우 이유 표시 */}
            {(() => {
              const sup = getMetricSupport(metric);
              return !sup.ok ? (
                <div className="text-[9px] text-terminal-red/90 pt-0.5">
                  ※ {sup.reason}
                </div>
              ) : null;
            })()}
          </div>

          {/* 검증 에러 알림 */}
          {validationError && (
            <div className="text-[10px] text-terminal-red bg-terminal-red/10 px-2 py-1 rounded-sm border border-terminal-red/30">
              ※ {validationError}
            </div>
          )}

          {/* 실행 버튼 */}
          <div className="pt-1">
            <button
              type="button"
              disabled={executing || !getMetricSupport(metric).ok}
              onClick={handleExecute}
              className="w-full py-1.5 rounded-sm text-[11px] font-bold bg-terminal-green/20 text-terminal-green border border-terminal-green/50 hover:bg-terminal-green/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5 shadow-xs"
            >
              {executing ? (
                <>
                  <span className="animate-spin">◌</span>
                  <span>{UI_TEXT.queryExecuting}</span>
                </>
              ) : (
                <>
                  <span>✦</span>
                  <span>{UI_TEXT.btnExecute}</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* ── 결과 히스토리 카드 목록 ── */}
        {history.length > 0 && (
          <div className="space-y-3 pt-2">
            {history.map((item) => (
              <div key={item.id} className="space-y-1.5 animate-fade-in">
                {/* 결과 헤더 (요약 문장 및 시각) */}
                <div className="flex items-center justify-between text-terminal-yellow font-bold text-[10px]">
                  <div className="flex items-center gap-1 min-w-0">
                    <span className="shrink-0">✦</span>
                    <span className="truncate">{item.summary}</span>
                  </div>
                  <span className="text-[9px] text-terminal-gray font-normal shrink-0 pl-1">
                    {item.timestamp}
                  </span>
                </div>

                {/* 결과 카드 */}
                <div className="bg-terminal-surface border border-terminal-border rounded-sm p-2.5 space-y-2">
                  {/* 핵심 결과 값 */}
                  <div className="text-sm font-bold text-terminal-green py-0.5">
                    {item.result.value}
                    {item.result.unit ? ` ${item.result.unit}` : ""}
                  </div>

                  {/* 근거 기록 목록 */}
                  {item.result.rows && item.result.rows.length > 0 && (
                    <div className="space-y-1 pt-1 border-t border-terminal-border/30">
                      <div className="text-[9px] text-terminal-gray/70">{UI_TEXT.evidenceLabel}:</div>
                      <div className="space-y-1 max-h-48 overflow-y-auto scrollbar-hide">
                        {item.result.rows.map((r, ri) => (
                          <div
                            key={ri}
                            className="flex items-center justify-between text-[10px] bg-[#12151c] px-2 py-1 rounded-sm border border-terminal-border/20"
                          >
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-terminal-gray shrink-0">[{r.time}]</span>
                              <span className="text-terminal-white truncate">{r.title}</span>
                            </div>
                            <span className="text-terminal-yellow shrink-0 pl-2">{r.text}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 안내 메모 (note) */}
                  {item.result.note && (
                    <div className="text-[9px] text-terminal-gray/80 italic pt-1">
                      ※ {item.result.note}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}
