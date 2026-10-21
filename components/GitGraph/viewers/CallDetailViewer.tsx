"use client";

import { CallBody } from "@/types/commit";

interface CallDetailViewerProps {
  body: string | null;
}

export default function CallDetailViewer({ body }: CallDetailViewerProps) {
  let callData: Partial<CallBody> = {};
  try {
    callData = body ? JSON.parse(body) : {};
  } catch {
    callData = {};
  }

  const durationSec = callData.durationSec || 0;
  const isMissed = callData.callType === "MISSED";
  const isRejected = callData.callType === "REJECTED";

  let typeColor = "text-[#50fa7b]";
  let typeBg = "bg-[#50fa7b]/10";
  let typeBorder = "border-[#50fa7b]/30";
  let typeText = "수신 통화";
  let typeIcon = "📞";

  if (callData.callType === "OUTGOING") {
    typeColor = "text-[#8be9fd]";
    typeBg = "bg-[#8be9fd]/10";
    typeBorder = "border-[#8be9fd]/30";
    typeText = "발신 통화";
    typeIcon = "📞";
  } else if (isMissed) {
    typeColor = "text-[#ff5555]";
    typeBg = "bg-[#ff5555]/10";
    typeBorder = "border-[#ff5555]/30";
    typeText = "부재중 전화";
    typeIcon = "☎️";
  } else if (isRejected) {
    typeColor = "text-[#ff5555]/80";
    typeBg = "bg-[#ff5555]/5";
    typeBorder = "border-[#ff5555]/20";
    typeText = "거절된 통화";
    typeIcon = "🚫";
  }

  const displayName = callData.contactName || callData.phoneNumber || "알 수 없는 번호";

  const formatDurationKorean = (sec: number) => {
    if (!sec || sec <= 0) return "연결 안됨";
    if (sec < 60) return `${sec}초`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s > 0 ? `${m}분 ${s}초` : `${m}분`;
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[9px] text-terminal-gray/40 font-mono tracking-wider">
        <span>📞 CALL LOG</span>
        <span className={typeColor}>{callData.callType}</span>
      </div>

      <div className={`flex items-center gap-3 p-2.5 border ${typeBorder} ${typeBg} rounded-xl mt-1`}>
        <div className="text-sm shrink-0 w-7 h-7 rounded-full bg-terminal-surface border border-terminal-border/60 flex items-center justify-center">
          {typeIcon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] text-terminal-white font-semibold truncate">{displayName}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className={`text-[9px] font-mono font-medium ${typeColor}`}>{typeText}</span>
            <span className="text-terminal-gray/40 text-[9px] font-mono">|</span>
            <span className="text-terminal-white/70 text-[9px] font-mono">
              {formatDurationKorean(durationSec)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
