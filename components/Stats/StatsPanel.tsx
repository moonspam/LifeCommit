"use client";

import { useEffect, useState } from "react";
import ContributionGraph from "./ContributionGraph";
import { getTopBranches, getTopApps, getLocationCommitsByPeriod } from "@/lib/queries";
import { subscribe, EVENT_COMMITS_UPDATED } from "@/lib/events";
import { periodStart, periodWindow, shiftPeriodStart } from "@/lib/period";
import { getFlavor, type Flavor } from "@/lib/flavor";
import { STAY_CONTEXT_MS } from "@/lib/today";
import type { Commit } from "@/types/commit";
import PeopleGraph from "./PeopleGraph";
import ReplayView from "../Today/ReplayView";
import ReplayButton from "../Today/ReplayButton";

function formatDuration(sec: number) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm > 0 ? rm + 'm' : ''}`;
}

interface StatsPanelProps {
  filterType: 'week' | 'month' | 'year';
  onDayClick?: (date: string) => void;
  resumeTick?: number;
  isReady?: boolean;
}

export default function StatsPanel({ filterType, onDayClick, resumeTick, isReady = false }: StatsPanelProps) {
  // the parent keys this component by filterType, so the anchor starts at the current period and resets on tab change
  const [anchor, setAnchor] = useState(() => periodStart(filterType));
  // only the boolean is derived at render time; the query window is computed inside the loader so "now" never feeds effect deps
  const { canNext } = periodWindow(filterType, anchor);
  // the whole period (not clipped to now, so it is stable across renders); PeopleGraph clips "as of" itself
  const periodEnd = shiftPeriodStart(filterType, anchor, 1).getTime() - 1;
  const [flavor, setFlavor] = useState<Flavor>("oss");
  useEffect(() => { void getFlavor().then(setFlavor); }, []);

  const [topBranches, setTopBranches] = useState<{name: string, percentage: number, color: string}[]>([]);
  const [topApps, setTopApps] = useState<{pkg: string, name: string, durationSec: number, count: number}[]>([]);

  const [replayOpen, setReplayOpen] = useState(false);
  const [replayCommits, setReplayCommits] = useState<Commit[] | null>(null);
  const [replayParams, setReplayParams] = useState<{ start: number; end: number; key: string } | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  useEffect(() => {
    if (!isReady) return;
    let active = true;
    
    const loadStats = async () => {
      try {
        const { start: winStart, end: winEnd } = periodWindow(filterType, anchor);
        const [branches, apps] = await Promise.all([
          getTopBranches(winStart, winEnd),
          getTopApps(winStart, winEnd)
        ]);
        
        if (!active) return;
        setTopBranches(branches);
        setTopApps(apps);
      } catch (err) {
        console.error("[Stats] Failed to load top stats:", err);
      }
    };
    
    loadStats();
    
    const unsubscribe = subscribe(EVENT_COMMITS_UPDATED, loadStats);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [filterType, anchor, resumeTick, isReady]);
  
  const isMonthMode = filterType === 'month';
  const fmt = (d: Date) => `${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  const label = {
    week: `${anchor.getFullYear()}.${fmt(anchor)} ~ ${fmt(new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + 6))}`,
    month: `${anchor.getFullYear()}년 ${anchor.getMonth() + 1}월`,
    year: `${anchor.getFullYear()}년`,
  }[filterType];
  const title = label;
  const handleOpenReplay = async () => {
    const start = anchor.getTime();
    const end = Math.min(periodEnd, Date.now());
    const key = `${filterType}-${start}-${end}`;
    setReplayLoading(true);
    try {
      const rows = await getLocationCommitsByPeriod(start - STAY_CONTEXT_MS, end + STAY_CONTEXT_MS);
      setReplayCommits(rows);
      setReplayParams({ start, end, key });
      setReplayOpen(true);
    } finally {
      setReplayLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-terminal-bg overflow-y-auto border-r border-terminal-border p-6 gap-6 relative">
      {replayOpen && replayCommits && replayParams && (
        <ReplayView
          key={replayParams.key}
          commits={replayCommits}
          start={replayParams.start}
          end={replayParams.end}
          periodKey={replayParams.key}
          multiDay={true}
          title={`${label} 이동 리플레이`}
          onClose={() => setReplayOpen(false)}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-b border-terminal-border pb-4 shrink-0">
        <button aria-label="이전" onClick={() => setAnchor(shiftPeriodStart(filterType, anchor, -1))} className="shrink-0 whitespace-nowrap px-3 py-1.5 border border-terminal-border rounded text-terminal-blue font-mono text-xs">←</button>
        <span className="text-terminal-blue text-[13px] font-mono font-bold text-center min-w-0">📊 {title}</span>
        <button aria-label="다음" disabled={!canNext} onClick={() => setAnchor(shiftPeriodStart(filterType, anchor, 1))} className="shrink-0 whitespace-nowrap px-3 py-1.5 border border-terminal-border rounded text-terminal-blue font-mono text-xs disabled:opacity-30">→</button>
      </div>

      {flavor === "full" && (
        <div className="flex justify-end shrink-0 -mt-2">
          <ReplayButton onClick={handleOpenReplay} loading={replayLoading} />
        </div>
      )}

      {filterType !== 'week' && (
      <div className="flex flex-col gap-2">
        <h3 className="text-terminal-white/80 font-mono text-sm tracking-wide">Contributions</h3>
        <ContributionGraph 
          year={anchor.getFullYear()} 
          month={isMonthMode ? anchor.getMonth() + 1 : undefined}
          onDayClick={onDayClick} 
          resumeTick={resumeTick} 
          isReady={isReady}
        />
      </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4 flex flex-col gap-2">
          <span className="text-terminal-gray/60 font-mono text-xs uppercase tracking-wider">Top Branches</span>
          <div className="flex flex-col gap-2 mt-2">
            {topBranches.length === 0 ? (
              <span className="text-terminal-gray/40 text-xs font-mono">데이터 없음</span>
            ) : (
              topBranches.map(b => (
                <div key={b.name} className="flex justify-between items-center text-sm font-mono text-terminal-white/80">
                  <span>{b.name}</span>
                  <span style={{ color: b.color }}>{b.percentage}%</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-terminal-surface border border-terminal-border rounded-lg p-4 flex flex-col gap-2">
          <span className="text-terminal-gray/60 font-mono text-xs uppercase tracking-wider">Top Apps</span>
          <div className="flex flex-col gap-2 mt-2">
            {topApps.length === 0 ? (
              <span className="text-terminal-gray/40 text-xs font-mono">데이터 없음</span>
            ) : (
              topApps.map(app => (
                <div key={app.pkg} className="flex justify-between items-center text-sm font-mono text-terminal-white/80">
                  <span className="truncate pr-2" title={app.pkg}>{app.name}</span>
                  <span className="text-terminal-blue shrink-0">{app.count}회 · {formatDuration(app.durationSec)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
      
      {flavor === "full" && isReady && <PeopleGraph start={anchor.getTime()} end={periodEnd} resumeTick={resumeTick ?? 0}
        periodLabel={filterType === "week" && anchor.getTime() === periodStart("week").getTime() ? "이번 주" : label} />}

      <div className="mt-8 text-center text-terminal-gray/40 text-[10px] font-mono border-t border-terminal-border/30 pt-4">
        ※ 렌더링 부하 방지를 위해 월간/연간 상세 타임라인 그래프는 제공하지 않습니다.
      </div>
    </div>
  );
}
