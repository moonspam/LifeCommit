"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Branch, Commit } from "@/types/commit";
import { getBranches, getBranchOrderIndex, getCommitsByPeriod, getCoverage, getUnclassifiedApps } from "@/lib/queries";
import { coverageGaps, awaitingScreenOff, type Gap } from "@/lib/coverage";
import { getCollectStatus } from "@/lib/usageSync";
import { subscribe, EVENT_COMMITS_UPDATED, EVENT_USAGE_STATUS } from "@/lib/events";
import { createManualCommit, setAppBranchOverride } from "@/lib/commitManager";
import { dateKey, dayRange, formatDuration, memoTimestamp, shiftDate, STAY_CONTEXT_MS, summarizeDay, unregisteredStays, isLatestLoad } from "@/lib/today";
import { loadAppLabels } from "@/lib/appLabels";
import { dongName } from "@/lib/dong";
import ReplayView from "./ReplayView";
import ReplayButton from "./ReplayButton";
import DaySummaryCard from "./DaySummaryCard";
import { replayReady } from "@/lib/replay";
import { getFlavor, type Flavor } from "@/lib/flavor";

interface Props {
  isReady: boolean;
  resumeTick?: number;
  date: string;
  onDateChange: (date: string) => void;
  /** 분류 안 된 앱 목록이 펼쳐졌는지 (펼친 동안 + 버튼을 숨긴다) */
  onUnclassifiedOpenChange?: (open: boolean) => void;
  /** the day's git graph */
  children: ReactNode;
}

export default function TodayPanel({ isReady, resumeTick, date, onDateChange, onUnclassifiedOpenChange, children }: Props) {
  const [commits, setCommits] = useState<Commit[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [unclassified, setUnclassified] = useState<{ pkg: string; name: string; durationSec: number }[]>([]);
  const [memo, setMemo] = useState("");
  const [flavor, setFlavor] = useState<Flavor>("full");
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [screenOffHint, setScreenOffHint] = useState(false);
  const [stayPlaces, setStayPlaces] = useState<string[]>([]);
  useEffect(() => () => onUnclassifiedOpenChange?.(false), [onUnclassifiedOpenChange]);
  const [around, setAround] = useState<Commit[]>([]); // location context +-12 h (stays, replay)
  const [aroundDate, setAroundDate] = useState<string | null>(null);
  const [replayOpen, setReplayOpen] = useState(false);
  const genRef = useRef(0);
  const today = dateKey();

  useEffect(() => { void getFlavor().then(setFlavor); }, []);

  const load = useCallback(async () => {
    if (!isReady) return;
    const gen = ++genRef.current;
    const queryDate = date;
    const { start, end } = dayRange(queryDate);
    const [rows, branchRows, unknown] = await Promise.all([getCommitsByPeriod(start, end), getBranches(), getUnclassifiedApps()]);
    await loadAppLabels(rows.map((c) => c.appPackage)); // before the first render, so the summary shows device labels
    // stays are judged whole: a stay split by an SMS across midnight has pieces outside the day
    const around = await getCommitsByPeriod(start - STAY_CONTEXT_MS, end + STAY_CONTEXT_MS);
    const stays = unregisteredStays(around, start, end);
    const dongs = (await Promise.all(stays.map((c) => dongName(c.lat!, c.lng!)))).filter((n): n is string => !!n);

    if (!isLatestLoad(gen, genRef.current)) return;
    setCommits(rows); setStayPlaces(dongs); setAround(around); setAroundDate(queryDate); setBranches(branchRows.map((b) => ({ ...b, createdAt: 0 }))); setUnclassified(unknown);
    if (unknown.length === 0) onUnclassifiedOpenChange?.(false); // <details>가 사라지면 onToggle이 오지 않는다
    const cov = await getCoverage(start, end);

    if (!isLatestLoad(gen, genRef.current)) return;
    setGaps(coverageGaps({ day: { start, end }, now: Date.now(), ...cov, status: getCollectStatus() }));
    setScreenOffHint(queryDate === dateKey() && awaitingScreenOff(cov.rows, cov.lastEnd));
  }, [date, isReady, onUnclassifiedOpenChange]);
  useEffect(() => {
    void Promise.resolve().then(load);
    const offs = [subscribe(EVENT_COMMITS_UPDATED, load), subscribe(EVENT_USAGE_STATUS, load)];
    return () => {
      offs.forEach((off) => off());
      genRef.current++; // 진행 중인 조회 무효화: 언마운트 후 끝난 조회가 부모의 펼침 상태를 덮어쓰지 않게
    };
  }, [load, resumeTick]);

  const summary = summarizeDay(commits, dayRange(date), stayPlaces);
  const shift = (days: number) => onDateChange(shiftDate(date, days));
  const saveMemo = async () => {
    if (!memo.trim()) return;
    const timestamp = memoTimestamp(date);
    await createManualCommit({ subject: memo.trim(), branchName: "main", durationMinutes: 0, startedAt: timestamp, endedAt: timestamp });
    setMemo("");
  };
  const classify = async (pkg: string, branchId: number) => { await setAppBranchOverride(pkg, branchId); };

  const { start: dayStart, end: dayEnd } = dayRange(date);
  return <section className="flex flex-col h-full min-h-0 bg-terminal-bg font-mono text-xs">
    {replayOpen && replayReady(aroundDate, date) && <ReplayView key={date} commits={around} start={dayStart} end={dayEnd} periodKey={date} multiDay={false} title={`${date.replaceAll("-", ". ")} 이동 리플레이`} onClose={() => setReplayOpen(false)} />}
    <div className="shrink-0 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <button aria-label="이전" onClick={() => shift(-1)} className="shrink-0 whitespace-nowrap px-3 py-1.5 border border-terminal-border rounded text-terminal-blue font-mono text-xs">←</button>
        <strong className="text-terminal-white">{date.replaceAll("-", ". ")}</strong>
        <button aria-label="다음" disabled={date >= today} onClick={() => shift(1)} className="shrink-0 whitespace-nowrap px-3 py-1.5 border border-terminal-border rounded text-terminal-blue font-mono text-xs disabled:opacity-30">→</button>
      </div>
      {flavor === "full" && commits.some((c) => c.eventType === "LOCATION") && (
        <div className="flex justify-end shrink-0">
          <ReplayButton onClick={() => setReplayOpen(true)} />
        </div>
      )}
      <DaySummaryCard date={date} todayKey={today} summary={summary} flavor={flavor} gaps={gaps} screenOffHint={screenOffHint && date === today} />
    </div>
    <div className="flex-1 min-h-0 relative">{children}</div>
    {unclassified.length > 0 && <details className="shrink-0 border-t border-terminal-border px-3 py-2" onToggle={(e) => onUnclassifiedOpenChange?.(e.currentTarget.open)}>
      <summary className="text-terminal-yellow font-bold cursor-pointer">분류 안 된 앱 {unclassified.length}개 <span className="text-terminal-gray font-normal">· 전체 기간</span></summary>
      <div className="mt-2 max-h-40 overflow-y-auto space-y-2">
        {unclassified.map((app) => (
          <div key={app.pkg} className="rounded border border-terminal-border p-2 flex flex-col gap-1.5">
            <div className="text-terminal-white">{app.name} · {formatDuration(app.durationSec)}</div>
            <div className="flex flex-wrap gap-1.5">
              {branches.filter((b) => b.id !== 1 && b.name !== "main").sort((x, y) => getBranchOrderIndex(x.name) - getBranchOrderIndex(y.name)).map((branch) => (
                <button
                  key={branch.id}
                  onClick={() => classify(app.pkg, branch.id)}
                  className="px-2 py-1 border rounded"
                  style={{ color: branch.color, borderColor: branch.color }}
                >
                  {branch.name.replace("feature/", "")}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </details>}
    <div className="shrink-0 p-3 bg-terminal-bg border-t border-terminal-border flex gap-2">
      <input value={memo} onChange={(e) => setMemo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && saveMemo()} placeholder="오늘의 한 줄" className="min-w-0 flex-1 bg-terminal-surface border border-terminal-border rounded px-3 py-2 text-terminal-white outline-none"/>
      <button onClick={saveMemo} className="px-3 rounded bg-terminal-green text-black font-bold">저장</button>
    </div>
  </section>;
}
