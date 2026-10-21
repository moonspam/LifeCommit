"use client";

import { useEffect, useState } from "react";
import { getFlavor } from "@/lib/flavor";

interface StatusBarProps {
  dbStatus: "initializing" | "ready" | "error";
  isSyncing?: boolean;
  pendingCount?: number;
  onSyncClick?: () => void;
  onToggleTerminal: () => void;
  isTerminalVisible: boolean;
  onToggleAsk?: () => void;
  isAskVisible?: boolean;
  filterType: 'today' | 'week' | 'month' | 'year';
  onFilterChange: (type: 'today' | 'week' | 'month' | 'year') => void;
  onOpenFilterSettings: () => void;
}

const STATUS_CONFIG = {
  initializing: { dot: "animate-pulse text-terminal-yellow", text: "DB 초기화 중...", symbol: "◌" },
  ready:        { dot: "text-terminal-green",                text: "DB 정상",          symbol: "●" },
  error:        { dot: "text-terminal-red",                  text: "DB 오류",           symbol: "✗" },
};

export default function StatusBar({
  dbStatus,
  isSyncing = false,
  pendingCount = 0,
  onSyncClick,
  onToggleTerminal,
  isTerminalVisible,
  onToggleAsk,
  isAskVisible = false,
  filterType,
  onFilterChange,
  onOpenFilterSettings,
}: StatusBarProps) {
  const cfg = STATUS_CONFIG[dbStatus];
  const [now, setNow] = useState<string>("");
  const [isMounted, setIsMounted] = useState(false);
  const [flavor, setFlavor] = useState<string>("oss");
  useEffect(() => { void getFlavor().then(setFlavor); }, []);

  useEffect(() => {
    setIsMounted(true);
    const updateTime = () => {
      setNow(new Date().toLocaleString("ko-KR", {
        month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      }));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000 * 60);
    return () => clearInterval(timer);
  }, []);

  return (
    <header className="flex flex-col bg-terminal-surface border-b border-terminal-border font-mono select-none">
      {/* ── 1단: 메인 헤더 (앱 타이틀, DB/동기화 상태, 시간, 터미널/설정) ── */}
      <div className="flex items-center justify-between px-3.5 py-2 border-b border-terminal-border/40 text-xs">
        {/* 좌측: 로고 + DB 상태 + 대기 큐 뱃지 */}
        <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
          <span className="text-terminal-green font-bold tracking-wider text-xs sm:text-sm shrink-0">
            {flavor === "full" ? "LifeCommit+" : "LifeCommit"}
          </span>

          <span className="text-terminal-border shrink-0">|</span>

          {/* DB 상태 표시 및 번개 동기화 뱃지 (항상 나란히 고정 배치) */}
          <div className="flex items-center gap-2 shrink-0 text-[11px]">
            {/* 1. DB 상태 동그라미 */}
            <div className="flex items-center gap-1">
              <span className={cfg.dot}>{cfg.symbol}</span>
              <span className="text-terminal-gray">{cfg.text}</span>
            </div>

            {/* 2. 번개 동기화/대기 뱃지 (항상 나란히 존재하며 활성/비활성 전환) */}
            <button
              onClick={onSyncClick}
              className={`flex items-center justify-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono font-bold transition-all duration-150 border ${
                isSyncing
                  ? "bg-terminal-yellow/20 text-terminal-yellow border-terminal-yellow/40 cursor-pointer"
                  : pendingCount > 0
                  ? "bg-terminal-blue/20 text-terminal-blue hover:bg-terminal-blue/30 border-terminal-blue/40 cursor-pointer"
                  : "bg-transparent text-terminal-gray/30 border-terminal-border/20 cursor-default hover:text-terminal-gray/60"
              }`}
              title={
                isSyncing
                  ? "동기화 처리 중..."
                  : pendingCount > 0
                  ? `${pendingCount}개 이벤트 대기 중 (클릭 시 즉시 변환)`
                  : "대기 이벤트 없음 (동기화 완료)"
              }
            >
              <span className={`inline-block ${isSyncing ? "animate-spin text-[10px]" : "text-[9px]"}`}>
                {isSyncing ? "◌" : "⚡"}
              </span>
              <span>{pendingCount}</span>
            </button>
          </div>
        </div>

        {/* 우측: 시간 + 터미널 토글 + 설정 */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0 pl-2">
          <span className="text-terminal-gray text-[11px] hidden xs:inline shrink-0">
            {isMounted ? now : ""}
          </span>

          {/* 터미널 토글 버튼 */}
          <button
            onClick={onToggleTerminal}
            className={`flex items-center justify-center px-2 py-1 rounded border text-xs font-bold transition-colors ${
              isTerminalVisible
                ? "text-terminal-green bg-terminal-green/15 border-terminal-green/40"
                : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
            }`}
            title="Terminal Toggle"
          >
            <span className="leading-none">&gt;_</span>
          </button>

          {/* 기록 조회 토글 버튼 (oss·full 공통) */}
          <button
            onClick={onToggleAsk}
            className={`flex items-center justify-center px-2 py-1 rounded border text-xs font-bold transition-colors ${
              isAskVisible
                ? "text-terminal-yellow bg-terminal-yellow/15 border-terminal-yellow/40"
                : "text-terminal-gray border-terminal-border/60 hover:text-terminal-white hover:bg-terminal-surface"
            }`}
            title="기록 조회"
            aria-label="기록 조회"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>

          {/* 설정 버튼 */}
          <button
            onClick={onOpenFilterSettings}
            className="p-1 rounded-sm text-terminal-gray hover:text-terminal-white border border-terminal-border/60 hover:bg-terminal-surface transition-colors"
            title="설정 및 백업/복원"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── 2단: 서브 컨트롤 바 (기간 필터 탭 + 보안 뱃지 + DB Export) ── */}
      <div className="flex items-center justify-between px-3.5 py-1.5 bg-[#090b10] text-[10px] sm:text-xs">
        {/* 좌측: 기간 필터 탭 바 (모바일 터치 최적화) */}
        <div className="flex items-center gap-1 bg-[#12151c] p-0.5 rounded-sm border border-terminal-border/40">
          {(["today", "week", "month", "year"] as const).map((type) => (
            <button
              key={type}
              onClick={() => onFilterChange(type)}
              className={`px-2.5 py-1 rounded text-[10px] uppercase font-bold tracking-wider transition-all ${
                filterType === type
                  ? "bg-terminal-green/20 text-terminal-green border border-terminal-green/40 shadow-xs"
                  : "text-terminal-gray hover:text-terminal-white hover:bg-terminal-surface/40"
              }`}
            >
              {type}
            </button>
          ))}
        </div>

        {/* 우측: 보안 암호화 뱃지 */}
        <div className="flex items-center gap-1.5 text-terminal-gray text-[10px]">
          <span className="text-terminal-yellow" title="SQLCipher 256-bit AES 암호화">🔒 SQLCipher</span>
          <span>•</span>
          <span className="text-terminal-blue" title="FTS5 고속 전문 검색">⚡ FTS5</span>
        </div>
      </div>
    </header>
  );
}
