"use client";

import { displayHash } from "@/lib/commitHash";
import { Commit, Branch } from "@/types/commit";
import CommitDetailPopover from "./CommitDetailPopover";

interface CommitNodeProps {
  commit: Commit;
  branch: Branch;
  isSelected: boolean;
  graphWidth: number;
  rowHeight: number;
  onClick: () => void;
  onCopy: (text: string) => void;
  onToast: (msg: string) => void;
}

export default function CommitNode({
  commit,
  branch,
  isSelected,
  graphWidth,
  rowHeight,
  onClick,
  onCopy,
  onToast,
}: CommitNodeProps) {
  const color = branch.color;
  const isMerge = commit.subject.startsWith("merge:");

  const formatTime = (ts: number) =>
    new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  };

  return (
    <div
      onClick={onClick}
      className={`
        flex items-center cursor-pointer transition-colors duration-100 relative
        ${isSelected ? "bg-terminal-surface" : "hover:bg-terminal-surface/30"}
      `}
      style={{ height: rowHeight, paddingLeft: graphWidth + 4 }}
    >
      <div className="flex-1 min-w-0 pr-3">
        {/* 커밋 해시 + 메시지 */}
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-mono text-terminal-gray/40 shrink-0">
            {displayHash(commit.id)}
          </span>
          <span
            className={`text-[12px] font-mono whitespace-nowrap leading-tight truncate
            ${isMerge ? "italic text-terminal-gray/50" : ""}
            ${isSelected ? "text-terminal-white font-semibold" : !isMerge ? "text-terminal-white/80" : ""}
          `}
          >
            {commit.subject}
          </span>
        </div>

        {/* 메타 정보 (브랜치명 배지, 시간, 소요시간) */}
        <div className="flex items-center gap-2 mt-px">
          <span
            className="text-[8px] font-mono font-bold px-[4px] py-[0.5px] rounded-sm uppercase tracking-tight shrink-0"
            style={{ color, backgroundColor: `${color}12`, border: `1px solid ${color}30` }}
          >
            {branch.name}
          </span>
          <span className="text-[9px] font-mono text-terminal-gray/40">{formatTime(commit.startedAt)}</span>
          {commit.durationSec > 0 && (
            <span className="text-[9px] font-mono text-terminal-gray/30">
              {formatDuration(commit.durationSec)}
            </span>
          )}
        </div>

        {/* 선택 시 팝오버 상세 */}
        {isSelected && (
          <CommitDetailPopover
            commit={commit}
            leftOffset={graphWidth + 4}
            onCopy={onCopy}
            onToast={onToast}
          />
        )}
      </div>
    </div>
  );
}
