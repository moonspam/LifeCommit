"use client";

import { ReplyBody } from "@/types/commit";

interface ReplyDetailViewerProps {
  body: string | null;
}

export default function ReplyDetailViewer({ body }: ReplyDetailViewerProps) {
  let replyData: Partial<ReplyBody> = {};
  try {
    replyData = body ? JSON.parse(body) : {};
  } catch {
    replyData = {};
  }

  const sender = replyData.sender || "상대방";
  const appName =
    replyData.packageName === "com.kakao.talk"
      ? "카카오톡"
      : replyData.packageName === "com.samsung.android.messaging"
      ? "메시지"
      : "알림 답장";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[9px] text-terminal-gray/40 font-mono tracking-wider">
        <span>💬 {appName} 대화</span>
        <span className="text-[#50fa7b]">REPLY</span>
      </div>
      <div className="flex flex-col gap-2 mt-1">
        <div className="flex flex-col items-start max-w-[90%]">
          <span className="text-[9px] text-terminal-gray/50 mb-0.5 ml-1">{sender}</span>
          <div className="bg-[#21262d] text-terminal-white text-[11px] px-3 py-1.5 rounded-r-xl rounded-bl-xl rounded-tl-none leading-relaxed break-all whitespace-pre-wrap select-text">
            {replyData.receivedMsg || "이전 대화"}
          </div>
        </div>

        <div className="flex items-center justify-center my-[-4px]">
          <div className="w-0.5 h-3 bg-terminal-border/30" />
        </div>

        <div className="flex flex-col items-end max-w-[90%] self-end">
          <span className="text-[9px] text-[#f1e05a]/60 mb-0.5 mr-1">나</span>
          <div className="bg-[#f1e05a] text-terminal-bg text-[11px] px-3 py-1.5 rounded-l-xl rounded-br-xl rounded-tr-none font-semibold leading-relaxed break-all whitespace-pre-wrap select-text">
            {replyData.replyMsg || ""}
          </div>
        </div>
      </div>
    </div>
  );
}
