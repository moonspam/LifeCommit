"use client";

import { useEffect, useState, useCallback } from "react";
import GitGraphPanel from "@/components/GitGraph/GitGraphPanel";
import TerminalPanel from "@/components/Terminal/TerminalPanel";
import StatusBar from "@/components/Terminal/StatusBar";
import { periodStart, type Period } from "@/lib/period";
import { dateKey } from "@/lib/today";
import StatsPanel from "@/components/Stats/StatsPanel";
import FilterSettingsModal from "@/components/Common/FilterSettingsModal";
import DatabaseErrorView from "@/components/Common/DatabaseErrorView";
import QuickCommitModal from "@/components/Common/QuickCommitModal";
import PermissionOnboarding from "@/components/Common/PermissionOnboarding";
import TodayPanel from "@/components/Today/TodayPanel";
import dynamic from "next/dynamic";

const AskPanel = dynamic(() => import("@/components/Ask/AskPanel"), {
  ssr: false,
});

import { useAppInit } from "@/app/hooks/useAppInit";
import { useAppSync } from "@/app/hooks/useAppSync";
import { useResizable } from "@/app/hooks/useResizable";
import { popBack, useBackClose } from "@/lib/back";

export default function HomePage() {
  // 1. 앱 초기화 및 권한 훅
  const {
    isReady,
    dbStatus,
    dbError,
    customFiltersText,
    saveFilters,
  } = useAppInit();

  // 2. 데이터 동기화 및 백그라운드 폴링 훅
  const { resumeTick, isSyncing, pendingCount, triggerManualSync } = useAppSync({ isReady, dbStatus });

  // 3. UI 및 필터 상태
  const [filterType, setFilterType] = useState<Period>("today");
  const [autoCommand, setAutoCommand] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string>(dateKey());
  const [isTerminalVisible, setIsTerminalVisible] = useState(false);
  const [isAskVisible, setIsAskVisible] = useState(false);
  const [isNative, setIsNative] = useState<boolean | null>(null);
  const [permissionsReady, setPermissionsReady] = useState(false);

  const handleToggleTerminal = useCallback(() => {
    setIsTerminalVisible((prev) => {
      const next = !prev;
      if (next) setIsAskVisible(false);
      return next;
    });
  }, []);

  const handleToggleAsk = useCallback(() => {
    setIsAskVisible((prev) => {
      const next = !prev;
      if (next) setIsTerminalVisible(false);
      return next;
    });
  }, []);

  useEffect(() => {
    (async () => {
      const { Capacitor } = await import("@capacitor/core");
      setIsNative(Capacitor.isNativePlatform());
    })();
  }, []);

  // 권한 온보딩 통과 후(또는 온보딩 불필요 시) 매일 알림 권한 1회 자동 요청 (Android 13+)
  useEffect(() => {
    if (!isReady || dbStatus !== "ready") return;
    if (isNative && !permissionsReady) return;

    let active = true;
    (async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
        const reminder = await LifeCommitPlugin.getDailyReminderSettings();
        if (reminder.enabled && !reminder.hasPermission && !reminder.asked && active) {
          await LifeCommitPlugin.requestNotificationPermission();
        }
      } catch (e) {
        // ignore errors
      }
    })();
    return () => {
      active = false;
    };
  }, [isReady, dbStatus, isNative, permissionsReady]);

  const [isFilterSettingsOpen, setIsFilterSettingsOpen] = useState(false);
  const [isQuickCommitOpen, setIsQuickCommitOpen] = useState(false);
  const [unclassifiedOpen, setUnclassifiedOpen] = useState(false);

  // 뒤로가기 스택에 모달 등록 (스택 순서 = 열린 순서)
  useBackClose(isFilterSettingsOpen, () => setIsFilterSettingsOpen(false));
  useBackClose(isQuickCommitOpen, () => setIsQuickCommitOpen(false));
  useBackClose(isAskVisible, () => setIsAskVisible(false));
  useBackClose(isTerminalVisible, () => setIsTerminalVisible(false));

  // 4. 패널 리사이징 훅
  const { leftWidth, isDragging, startDragging } = useResizable({
    initialWidth: 50,
    minWidth: 20,
    maxWidth: 80,
    isEnabled: isTerminalVisible || isAskVisible,
  });

  const handleFilterChange = useCallback((type: Period) => {
    setFilterType(type);
    if (type === "today") setSelectedDate(dateKey());
    const start = periodStart(type).toLocaleDateString("sv-SE"); // local YYYY-MM-DD; toISOString shifts a day in KST
    setAutoCommand(`git log --since="${start}"`);
  }, []);

  // 5. 네이티브 백버튼 리스너
  useEffect(() => {
    let listener: any;
    const setupBackButton = async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;
        const { App: CapApp } = await import("@capacitor/app");
        listener = await CapApp.addListener("backButton", () => {
          // 1. 등록된 닫기 핸들러 스택 (모달, 오버레이, 상세 상태 등)
          if (popBack()) return;

          // 2. 남는 체인: 통계 화면이면 today -> 과거 날짜면 오늘 -> exitApp()
          if (filterType !== "today") {
            setFilterType("today");
            setSelectedDate(dateKey());
          } else if (selectedDate !== dateKey()) {
            setSelectedDate(dateKey()); // back from a past day -> today
          } else {
            CapApp.exitApp();
          }
        });
      } catch (e) {
        // web mode
      }
    };
    setupBackButton();
    return () => {
      if (listener) listener.remove();
    };
  }, [filterType, selectedDate]);

  // 6. DB 완전 리셋 핸들러
  const handleResetDB = useCallback(async () => {
    if (
      confirm(
        "데이터베이스 연결 및 암호화 키를 완전히 초기화하고 다시 마운트하시겠습니까?\n(기존 앱 데이터 및 캐시가 처음부터 새롭게 구축됩니다.)"
      )
    ) {
      try {
        const { resetDatabase } = await import("@/lib/db");
        await resetDatabase();
        alert("데이터베이스 및 보안 키가 완전히 초기화되었습니다. 앱을 다시 시작합니다.");
        window.location.reload();
      } catch (err) {
        alert("데이터베이스 리셋 실패: " + String(err));
      }
    }
  }, []);

  return (
    <main className="flex flex-col h-dvh bg-terminal-bg overflow-hidden select-none relative">
      {dbStatus === "ready" && isNative && !permissionsReady && (
        <PermissionOnboarding onAllGranted={() => setPermissionsReady(true)} />
      )}
      {/* 상단 상태바 */}
      <StatusBar
        dbStatus={dbStatus}
        isSyncing={isSyncing}
        pendingCount={pendingCount}
        onSyncClick={triggerManualSync}
        onToggleTerminal={handleToggleTerminal}
        isTerminalVisible={isTerminalVisible}
        onToggleAsk={handleToggleAsk}
        isAskVisible={isAskVisible}
        filterType={filterType}
        onFilterChange={handleFilterChange}
        onOpenFilterSettings={() => setIsFilterSettingsOpen(true)}
      />

      {/* 본문 화면 */}
      {dbStatus === "error" ? (
        <DatabaseErrorView errorMessage={dbError} onResetDB={handleResetDB} onRetry={() => window.location.reload()} />
      ) : (
        <div className="split-layout flex-1 min-h-0">
          {/* 좌측: GitGraph 또는 통계 패널 */}
          <div
            className="git-graph-panel relative"
            style={{
              flex: (isTerminalVisible || isAskVisible) ? `0 0 ${leftWidth}%` : "1 1 100%",
              minWidth: 0,
            }}
          >
            {filterType === "today" ? (
              <TodayPanel
                isReady={isReady && dbStatus === "ready"}
                resumeTick={resumeTick}
                date={selectedDate}
                onDateChange={setSelectedDate}
                onUnclassifiedOpenChange={setUnclassifiedOpen}
              >
                <GitGraphPanel
                  isReady={isReady && dbStatus === "ready"}
                  filterType="today"
                  targetDate={selectedDate}
                  onCloseDate={selectedDate !== dateKey() ? () => setSelectedDate(dateKey()) : undefined}
                  resumeTick={resumeTick}
                />
              </TodayPanel>
            ) : (
              <StatsPanel
                key={filterType}
                filterType={filterType}
                onDayClick={(d) => { setSelectedDate(d); setFilterType("today"); }}
                resumeTick={resumeTick}
                isReady={isReady && dbStatus === "ready"}
              />
            )}
          </div>

          {/* 리사이즈 구분선 */}
          {(isTerminalVisible || isAskVisible) && (
            <div
              className={`resize-divider ${isDragging ? "is-dragging" : ""}`}
              onMouseDown={startDragging}
              onTouchStart={startDragging}
            />
          )}

          {/* 우측: 터미널 패널 */}
          {isTerminalVisible && (
            <div className="terminal-panel flex-1 min-w-0">
              <TerminalPanel
                isReady={isReady && dbStatus === "ready"}
                dbStatus={dbStatus}
                autoCommand={autoCommand}
                onAutoCommandClear={() => setAutoCommand(null)}
              />
            </div>
          )}

          {/* 우측: AI 검색 패널 */}
          {isAskVisible && (
            <div className="terminal-panel ask-panel flex-1 min-w-0">
              <AskPanel
                isReady={isReady && dbStatus === "ready"}
                onClose={() => setIsAskVisible(false)}
              />
            </div>
          )}
        </div>
      )}

      {/* 우측 하단 플로팅 빠른 커밋 작성 버튼 (+) - AI 창이 열려 있을 때(모바일 전체 높이) 숨김 (#11) */}
      {/* 오늘 화면에서 '분류 안 된 앱'을 펼친 동안에도 숨김 (분류 버튼과 겹침) */}
      {dbStatus === "ready" && !isAskVisible && !(filterType === "today" && unclassifiedOpen) && (
        <button
          onClick={() => setIsQuickCommitOpen(true)}
          className={`absolute ${filterType === "today" ? "bottom-20" : "bottom-5"} right-5 z-40 bg-terminal-green text-black font-bold text-lg w-11 h-11 rounded-full shadow-[0_4px_16px_rgba(80,250,123,0.4)] flex items-center justify-center hover:scale-105 active:scale-95 transition-all`}
          title="수동 커밋 작성 (Quick Commit)"
        >
          +
        </button>
      )}

      {/* 설정 모달 (5대 탭) */}
      <FilterSettingsModal
        isOpen={isFilterSettingsOpen}
        initialFiltersText={customFiltersText}
        onClose={() => setIsFilterSettingsOpen(false)}
        onSave={saveFilters}
      />

      {/* 수동 커밋 작성 모달 */}
      <QuickCommitModal
        isOpen={isQuickCommitOpen}
        onClose={() => setIsQuickCommitOpen(false)}
      />
    </main>
  );
}
