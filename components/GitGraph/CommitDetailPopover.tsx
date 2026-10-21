"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Commit } from "@/types/commit";
import SmsDetailViewer from "./viewers/SmsDetailViewer";
import ReplyDetailViewer from "./viewers/ReplyDetailViewer";
import CallDetailViewer from "./viewers/CallDetailViewer";
import PhotoDetailViewer from "./viewers/PhotoDetailViewer";
import SquashedEventsList from "./viewers/SquashedEventsList";
import { useBackClose } from "@/lib/back";

export const APP_BRANCH_NAMES = new Set(["feature/web", "feature/media", "feature/sns", "feature/work", "feature/life", "feature/etc", "feature/system", "feature/game"]);

interface CommitDetailPopoverProps {
  commit: Commit;
  leftOffset: number;
  onCopy: (text: string) => void;
  onToast: (msg: string) => void;
}

export default function CommitDetailPopover({
  commit,
  leftOffset,
  onCopy,
  onToast,
}: CommitDetailPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [positionClass, setPositionClass] = useState("top-[38px]");
  const [isChangingCategory, setIsChangingCategory] = useState(false);
  useBackClose(isChangingCategory, () => setIsChangingCategory(false));
  const [appBranches, setAppBranches] = useState<{ id: number; name: string }[]>([]);

  // 뷰포트 바운더리 체크 (화면 하단에서 잘림 방지) — 페인트 전에 재서 위/아래가 튀지 않게
  useLayoutEffect(() => {
    if (popoverRef.current) {
      const rect = popoverRef.current.getBoundingClientRect();
      const windowHeight = window.innerHeight;
      if (rect.bottom > windowHeight - 20) {
        // 화면 아래로 넘치면 위쪽으로 배치
        setPositionClass("bottom-[38px]");
      } else {
        setPositionClass("top-[38px]");
      }
    }
  }, [commit.id]);

  useEffect(() => {
    if (!isChangingCategory) return;
    import("@/lib/queries").then(({ getBranches }) => getBranches().then((rows) => setAppBranches(rows.filter((row) => APP_BRANCH_NAMES.has(row.name)))));
  }, [isChangingCategory]);

  const handleLongPressStart = (text: string) => {
    longPressTimerRef.current = setTimeout(() => {
      onCopy(text);
    }, 500);
  };

  const handleLongPressEnd = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  return (
    <div
      ref={popoverRef}
      onClick={(e) => e.stopPropagation()}
      className={`absolute ${positionClass} z-50 bg-terminal-surface/95 backdrop-blur-md border border-terminal-border/80 rounded-xl shadow-[0_12px_32px_rgba(0,0,0,0.7)] p-3 w-[290px] max-w-[calc(100vw-32px)] flex flex-col gap-2.5 transition-all duration-200 animate-fade-in`}
      style={{ left: Math.max(8, leftOffset) }}
    >
      {/* 1. SMS 상세 */}
      {commit.eventType === "SMS" && <SmsDetailViewer body={commit.body} />}

      {/* 2. REPLY 상세 */}
      {commit.eventType === "REPLY" && <ReplyDetailViewer body={commit.body} />}

      {/* 3. CALL 상세 */}
      {commit.eventType === "CALL" && <CallDetailViewer body={commit.body} />}

      {/* 4. PHOTO 상세 */}
      {commit.eventType === "PHOTO" && <PhotoDetailViewer body={commit.body} onToast={onToast} />}

      {/* 5. MANUAL (수동 커밋) 메모 상세 */}
      {(commit.eventType === "manual" || commit.eventType === "MANUAL") && commit.body && (
        <div className="bg-[#0e1117] border border-terminal-border/60 rounded-sm p-2 text-xs text-terminal-white/90 whitespace-pre-wrap font-mono">
          {commit.body}
        </div>
      )}

      {/* 6. 공통 메타데이터 (패키지명, 위치, 지오펜스) */}
      {(commit.appPackage || commit.geofenceName || commit.lat != null) && (
        <div className="flex flex-col gap-1 pb-1.5 border-b border-terminal-border/40 text-[9px] font-mono">
          {commit.appPackage && (
            <div
              className="text-terminal-blue cursor-pointer select-text active:bg-terminal-blue/20 rounded-sm px-1 -mx-1 py-0.5 transition-colors truncate flex items-center justify-between"
              onTouchStart={() => handleLongPressStart(commit.appPackage!)}
              onTouchEnd={handleLongPressEnd}
              onTouchCancel={handleLongPressEnd}
              onMouseDown={() => handleLongPressStart(commit.appPackage!)}
              onMouseUp={handleLongPressEnd}
              onMouseLeave={handleLongPressEnd}
              onClick={() => onCopy(commit.appPackage!)}
              title="클릭 또는 꾹 눌러 복사"
            >
              <span className="truncate">📦 {commit.appPackage}</span>
              <span className="text-terminal-gray/30 ml-1 text-[8px] shrink-0">(복사)</span>
            </div>
          )}

          {commit.geofenceName && (
            <div className="text-[#50fa7b] px-1 -mx-1 py-0.5 truncate">📍 {commit.geofenceName}</div>
          )}

          {commit.lat != null && commit.lng != null && !commit.geofenceName && (
            <div
              className="text-[#8be9fd] cursor-pointer active:bg-[#8be9fd]/20 rounded-sm px-1 -mx-1 py-0.5 transition-colors flex items-center justify-between"
              onTouchStart={() => handleLongPressStart(`${commit.lat}, ${commit.lng}`)}
              onTouchEnd={handleLongPressEnd}
              onTouchCancel={handleLongPressEnd}
              onMouseDown={() => handleLongPressStart(`${commit.lat}, ${commit.lng}`)}
              onMouseUp={handleLongPressEnd}
              onMouseLeave={handleLongPressEnd}
              onClick={() => onCopy(`${commit.lat}, ${commit.lng}`)}
              title="클릭 또는 꾹 눌러 복사"
            >
              <span>
                📍 {commit.lat.toFixed(4)}, {commit.lng.toFixed(4)}
              </span>
              <span className="text-terminal-gray/30 ml-1 text-[8px] shrink-0">(복사)</span>
            </div>
          )}
        </div>
      )}

      {/* 7. 병합된 내부 이벤트 리스트 */}
      <SquashedEventsList events={commit.squashedEvents} />

      {commit.appPackage && commit.eventType === "APP_USAGE" && (
        <div className="border-t border-terminal-border/40 pt-2">
          <button onClick={() => setIsChangingCategory(!isChangingCategory)} className="text-[10px] text-terminal-yellow hover:text-terminal-white">이 앱 분류 바꾸기</button>
          {isChangingCategory && <div className="flex flex-wrap gap-1 mt-2">{appBranches.map((branch) => <button key={branch.id} onClick={async () => {
            try { const { setAppBranchOverride } = await import("@/lib/commitManager"); await setAppBranchOverride(commit.appPackage!, branch.id); onToast("앱 분류와 과거 기록을 변경했습니다."); setIsChangingCategory(false); }
            catch (err: any) { alert("분류 변경 실패: " + err.message); }
          }} className="px-1.5 py-1 border border-terminal-border rounded-sm text-[9px] text-terminal-blue">{branch.name}</button>)}</div>}
        </div>
      )}

      {/* 8. 커밋 삭제 버튼 */}
      <div className="pt-1 border-t border-terminal-border/40 flex justify-end">
        <button
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirm(`이 커밋 [${commit.subject}]을 삭제하시겠습니까?`)) return;
            try {
              const { deleteCommit } = await import("@/lib/commitManager");
              await deleteCommit(commit.id);
              onToast("커밋이 삭제되었습니다.");
            } catch (err: any) {
              alert("삭제 실패: " + err.message);
            }
          }}
          className="text-terminal-red/70 hover:text-terminal-red text-[10px] font-mono px-1.5 py-0.5 rounded-sm hover:bg-terminal-red/10 transition-colors flex items-center gap-1"
          title="커밋 삭제"
        >
          <span>🗑️</span>
          <span>커밋 삭제</span>
        </button>
      </div>
    </div>
  );
}
