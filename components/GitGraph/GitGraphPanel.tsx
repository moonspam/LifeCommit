"use client";

import { periodStart } from "@/lib/period";
import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import type { Commit, Branch } from "@/types/commit";
import { getCommitsByPeriod, getBranches } from "@/lib/queries";
import { subscribe, EVENT_COMMITS_UPDATED } from "@/lib/events";
import CommitNode from "./CommitNode";

// ── 브랜치 컬러 팔레트 ──
const NEON_COLORS: Record<string, string> = {
  yellow: "#f1e05a",
  pink: "#ff79c6",
  green: "#50fa7b",
  blue: "#8be9fd",
  red: "#ff5555",
  purple: "#bd93f9",
  etc: "#6272a4",
  system: "#a0a8b8",
  game: "#ff5555",
};

// 레이아웃 상수
const MAIN_X = 18; // main 트렁크 x
const LANE_GAP = 24; // 레인 간격 (레인이 많으면 laneGap이 좁힘)
const ROW_H = 48; // 커밋 행 높이
const DOT_R = 4.5; // 일반 도트 반지름
const MERGE_R = 6; // merge 도트 반지름

/** Lane per branch by id order (main = 0): ids are not dense (AUTOINCREMENT, branches added later), so `id - 1` can be 492. */
export function branchLanes(branchIds: number[]): (bid: number) => number {
  const rank = new Map([...new Set(branchIds)].filter((id) => id !== 1).sort((a, b) => a - b).map((id, i) => [id, i + 1]));
  return (bid) => (bid === 1 ? 0 : rank.get(bid) ?? rank.size + 1);
}
/** Narrower lanes when a view uses many branches, so the labels keep their room on a phone. */
export const laneGap = (maxLane: number) => (maxLane <= 3 ? LANE_GAP : 16);

interface GitGraphPanelProps {
  isReady: boolean;
  filterType: "today" | "week" | "month" | "year";
  targetDate?: string;
  onCloseDate?: () => void;
  resumeTick?: number;
}

interface Session {
  branchId: number;
  lane: number;
  startIdx: number;
  endIdx: number;
}

const drawOrthogonalPath = (x1: number, y1: number, x2: number, y2: number, r: number = 8) => {
  const midY = (y1 + y2) / 2;
  const dirX = x2 > x1 ? 1 : -1;
  const dirY = y2 > y1 ? 1 : -1;
  const maxR = Math.min(Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, r);
  return `M ${x1} ${y1} L ${x1} ${midY - dirY * maxR} Q ${x1} ${midY}, ${x1 + dirX * maxR} ${midY} L ${x2 - dirX * maxR} ${midY} Q ${x2} ${midY}, ${x2} ${midY + dirY * maxR} L ${x2} ${y2}`;
};

/**
 * 커밋을 선택할 때 타임라인이 가로로 스크롤되어 있으면 0으로 부드럽게 되돌림 (팝오버 화면 밖 노출 방지)
 */
export function scrollTimelineToLeftOnSelect(
  container: { scrollLeft: number; scrollTo: (options: ScrollToOptions) => void } | null,
  hasSelection: boolean
) {
  if (!hasSelection || !container) return;
  if (container.scrollLeft > 0) {
    container.scrollTo({ left: 0, behavior: "smooth" });
  }
}

import { useBackClose } from "@/lib/back";

export default function GitGraphPanel({
  isReady,
  filterType,
  targetDate,
  onCloseDate,
  resumeTick,
}: GitGraphPanelProps) {
  const [selectedCommit, setSelectedCommit] = useState<Commit | null>(null);
  useBackClose(Boolean(selectedCommit), () => setSelectedCommit(null));
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollTimelineToLeftOnSelect(timelineRef.current, Boolean(selectedCommit));
  }, [selectedCommit]);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    getBranches().then((rows) => {
      if (rows.length > 0) {
        setBranches(rows.map((r) => ({ id: r.id, name: r.name, color: r.color, createdAt: 0 })));
      }
    });
  }, [isReady]);

  // Toast 자동 소멸
  useEffect(() => {
    if (!toastMsg) return;
    const timer = setTimeout(() => setToastMsg(null), 2000);
    return () => clearTimeout(timer);
  }, [toastMsg]);

  // 클립보드 복사
  const copyToClipboard = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setToastMsg(`"${text}" 복사됨!`);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setToastMsg(`"${text}" 복사됨!`);
    }
  }, []);

  // 미처리 raw_events 잔여 확인
  const checkUnprocessedEvents = useCallback(async () => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      const res = await db.query("SELECT COUNT(*) as cnt FROM raw_events WHERE is_processed = 0");
      const cnt = res.values?.[0]?.cnt ?? 0;
      setIsSyncing(cnt > 0);
    } catch {
      // 무시
    }
  }, []);

  // 커밋 데이터 조회
  const fetchCommits = useCallback(async () => {
    if (!isReady) return;
    setIsLoading(true);
    try {
      let dbCommits: Commit[] = [];
      if (targetDate) {
        const start = new Date(`${targetDate}T00:00:00`);
        start.setHours(0, 0, 0, 0);
        const end = new Date(`${targetDate}T00:00:00`);
        end.setHours(23, 59, 59, 999);
        dbCommits = await getCommitsByPeriod(start.getTime(), end.getTime());
      } else {
        const now = new Date();
        const start = new Date(now);
        if (filterType === "today") {
          start.setHours(0, 0, 0, 0);
        } else if (filterType === "week") {
          start.setTime(periodStart("week", now).getTime());
        } else if (filterType === "month") {
          start.setDate(1);
          start.setHours(0, 0, 0, 0);
        } else if (filterType === "year") {
          start.setMonth(0, 1);
          start.setHours(0, 0, 0, 0);
        }
        dbCommits = await getCommitsByPeriod(start.getTime(), now.getTime());
      }
      setCommits([...dbCommits].reverse());
    } catch (err) {
      console.error("[GitGraphPanel] Failed to fetch commits:", err);
    } finally {
      setIsLoading(false);
    }
    await checkUnprocessedEvents();
  }, [isReady, filterType, targetDate, checkUnprocessedEvents]);

  useEffect(() => {
    if (!isReady) return;

    fetchCommits();
    const unsubscribe = subscribe(EVENT_COMMITS_UPDATED, fetchCommits);
    const syncCheckInterval = setInterval(checkUnprocessedEvents, 3000);
    const fallbackInterval = setInterval(fetchCommits, 30000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchCommits();
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      unsubscribe();
      clearInterval(syncCheckInterval);
      clearInterval(fallbackInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [isReady, filterType, targetDate, resumeTick, fetchCommits, checkUnprocessedEvents]);

  const getBranch = useCallback(
    (id: number) => branches.find((b) => b.id === id) ?? { id, name: "main", color: NEON_COLORS.yellow, createdAt: 0 },
    [branches]
  );

  // ── SVG 그래프 경로 & 도트 계산 ──
  const { svgPaths, svgDots, totalHeight, graphWidth } = useMemo(() => {
    if (commits.length === 0) return { svgPaths: [], svgDots: [], totalHeight: 0, graphWidth: 60 };

    const getY = (idx: number) => idx * ROW_H + ROW_H / 2;
    // lanes only for branches in this view: a day with 3 branches does not reserve room for all 8
    const laneOf = branchLanes(commits.map((c) => c.branchId));

    const sessions: Session[] = [];
    let sStart = 0;
    for (let i = 1; i <= commits.length; i++) {
      if (i === commits.length || commits[i].branchId !== commits[sStart].branchId) {
        sessions.push({
          branchId: commits[sStart].branchId,
          lane: laneOf(commits[sStart].branchId),
          startIdx: sStart,
          endIdx: i - 1,
        });
        sStart = i;
      }
    }

    const maxLane = Math.max(...sessions.map((s) => s.lane), 0);
    const gap = laneGap(maxLane);
    const laneX = (lane: number) => MAIN_X + lane * gap;
    const gw = MAIN_X + (maxLane + 1) * gap + 8;

    const paths: React.ReactElement[] = [];
    const dots: React.ReactElement[] = [];

    // 1) Main 트렁크 배경선
    paths.push(
      <line
        key="trunk"
        x1={MAIN_X}
        y1={0}
        x2={MAIN_X}
        y2={commits.length * ROW_H}
        stroke={NEON_COLORS.yellow}
        strokeWidth={2}
        opacity={0.15}
      />
    );

    // 2) 세션별 렌더링 및 곡선 연결
    for (let si = 0; si < sessions.length; si++) {
      const s = sessions[si];
      const color = getBranch(s.branchId)?.color || NEON_COLORS.yellow;
      const sx = laneX(s.lane);
      const topY = getY(s.startIdx);
      const botY = getY(s.endIdx);

      if (s.lane === 0) {
        paths.push(
          <line
            key={`ms-${si}`}
            x1={MAIN_X}
            y1={topY}
            x2={MAIN_X}
            y2={botY}
            stroke={color}
            strokeWidth={2}
            opacity={0.6}
          />
        );
      } else if (s.startIdx !== s.endIdx) {
        paths.push(
          <line
            key={`fs-${si}`}
            x1={sx}
            y1={topY}
            x2={sx}
            y2={botY}
            stroke={color}
            strokeWidth={2}
            opacity={0.6}
          />
        );
      }

      if (si < sessions.length - 1) {
        const nextS = sessions[si + 1];
        const nextColor = getBranch(nextS.branchId)?.color || NEON_COLORS.yellow;

        if (s.lane > 0 && nextS.lane === 0) {
          paths.push(
            <path
              key={`fork-${si}`}
              d={drawOrthogonalPath(laneX(nextS.lane), getY(nextS.startIdx), sx, botY)}
              stroke={color}
              strokeWidth={1.5}
              fill="none"
              opacity={0.5}
            />
          );
        } else if (s.lane === 0 && nextS.lane > 0) {
          paths.push(
            <path
              key={`merge-${si}`}
              d={drawOrthogonalPath(laneX(nextS.lane), getY(nextS.startIdx), laneX(s.lane), getY(s.endIdx))}
              stroke={nextColor}
              strokeWidth={1.5}
              fill="none"
              opacity={0.5}
            />
          );
        } else if (s.lane > 0 && nextS.lane > 0 && s.lane !== nextS.lane) {
          paths.push(
            <path
              key={`cross-${si}`}
              d={drawOrthogonalPath(laneX(nextS.lane), getY(nextS.startIdx), sx, botY)}
              stroke={color}
              strokeWidth={1.5}
              fill="none"
              opacity={0.35}
            />
          );
        }
      }
    }

    // 3) 커밋 도트
    commits.forEach((c, idx) => {
      const lane = laneOf(c.branchId);
      const cx = laneX(lane);
      const cy = getY(idx);
      const color = getBranch(c.branchId)?.color || NEON_COLORS.yellow;
      const isMerge = c.subject.startsWith("merge:");

      if (isMerge) {
        dots.push(
          <circle
            key={`md-${idx}`}
            cx={cx}
            cy={cy}
            r={MERGE_R}
            fill="#0d1117"
            stroke={color}
            strokeWidth={2}
          />
        );
        dots.push(<circle key={`mi-${idx}`} cx={cx} cy={cy} r={2} fill={color} />);
      } else {
        dots.push(<circle key={`d-${idx}`} cx={cx} cy={cy} r={DOT_R} fill={color} />);
      }
    });

    return {
      svgPaths: paths,
      svgDots: dots,
      totalHeight: commits.length * ROW_H,
      graphWidth: gw,
    };
  }, [commits, branches, getBranch]);

  return (
    <div className="flex flex-col h-full bg-terminal-bg overflow-hidden border-r border-terminal-border relative">
      {/* Toast 알림 */}
      {toastMsg && (
        <div className="absolute top-12 inset-x-0 mx-auto w-fit z-100 bg-[#50fa7b] text-black text-xs font-mono font-bold px-4 py-2 rounded-lg shadow-lg animate-fade-in whitespace-nowrap">
          {toastMsg}
        </div>
      )}

      {/* 헤더 */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-border bg-terminal-surface shrink-0">
        <span className="text-terminal-blue text-[10px] font-mono font-bold uppercase tracking-widest opacity-80 flex items-center gap-2">
          <div
            className={`w-1.5 h-1.5 rounded-full ${
              isLoading || isSyncing ? "bg-[#f1e05a] animate-pulse" : "bg-terminal-blue" /* idle: no infinite animation (it kept the WebView repainting) */
            }`}
          />
          {targetDate ? `life-graph [${targetDate}]` : `life-graph engine [real-git-sync]`}
        </span>

        {targetDate && onCloseDate && (
          <button
            onClick={onCloseDate}
            className="text-[10px] font-mono text-terminal-gray/80 hover:text-terminal-white bg-terminal-bg px-2 py-0.5 rounded-sm border border-terminal-border/50 transition-colors"
          >
            ← TODAY
          </button>
        )}
      </div>

      {/* 커밋 타임라인 */}
      <div
        ref={timelineRef}
        className={`flex-1 overflow-auto scrollbar-hide transition-opacity duration-300 ${
          (isLoading || isSyncing) && commits.length > 0 ? "opacity-60" : "opacity-100"
        }`}
      >
        {commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-terminal-gray/40 text-xs font-mono gap-3">
            {isLoading || isSyncing ? (
              <>
                <div className="w-6 h-6 border-2 border-[#f1e05a]/30 border-t-[#f1e05a] rounded-full animate-spin" />
                <span>이벤트 데이터 동기화 중...</span>
              </>
            ) : (
              "커밋 대기 중..."
            )}
          </div>
        ) : (
          <div className="relative min-w-max" style={{ minHeight: totalHeight }}>
            {/* 고정 SVG 그래프 레이어: 가로 스크롤 시 왼쪽에 고정, 세로는 함께 스크롤 */}
            <div
              className="sticky left-0 pointer-events-none"
              style={{ width: graphWidth, height: 0, zIndex: 10 }}
            >
              {/* 그래프 배경 (가로 스크롤 시 밀려오는 텍스트 가림) */}
              <div
                className="absolute top-0 left-0 bg-terminal-bg"
                style={{ width: graphWidth, height: totalHeight }}
              />

              <svg
                className="absolute top-0 left-0"
                width={graphWidth}
                height={totalHeight}
              >
                {/* 선택된 행의 그래프 영역 배경 강조 */}
                {selectedCommit && (() => {
                  const sIdx = commits.findIndex((c) => c.id === selectedCommit.id);
                  if (sIdx < 0) return null;
                  return (
                    <rect
                      x={0}
                      y={sIdx * ROW_H}
                      width={graphWidth}
                      height={ROW_H}
                      fill="#161b22"
                    />
                  );
                })()}
                <g strokeLinecap="round">{svgPaths}</g>
                <g>{svgDots}</g>
              </svg>
            </div>

            {/* 커밋 노드 행 목록 */}
            {commits.map((commit, idx) => (
              <CommitNode
                key={commit.id || idx}
                commit={commit}
                branch={getBranch(commit.branchId)}
                isSelected={selectedCommit?.id === commit.id}
                graphWidth={graphWidth}
                rowHeight={ROW_H}
                onClick={() => setSelectedCommit(commit === selectedCommit ? null : commit)}
                onCopy={copyToClipboard}
                onToast={(msg) => setToastMsg(msg)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
