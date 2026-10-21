"use client";

import { SmsBody } from "@/types/commit";

interface SmsDetailViewerProps {
  body: string | null;
}

export default function SmsDetailViewer({ body }: SmsDetailViewerProps) {
  let smsData: Partial<SmsBody> = {};
  try {
    smsData = body ? JSON.parse(body) : {};
  } catch {
    smsData = { body: body || "" };
  }

  const isIncoming = smsData.callType === "INCOMING";
  const senderName = smsData.contactName || smsData.phoneNumber || "알 수 없는 번호";

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[9px] text-terminal-gray/40 font-mono tracking-wider">
        <span>✉️ SMS MESSAGE</span>
        <span className={isIncoming ? "text-[#8be9fd]" : "text-[#50fa7b]"}>
          {isIncoming ? "수신" : "발신"}
        </span>
      </div>
      <div className="flex flex-col gap-1 mt-1">
        {isIncoming ? (
          <div className="flex flex-col items-start max-w-[90%]">
            <span className="text-[9px] text-terminal-gray/50 mb-0.5 ml-1">{senderName}</span>
            <div className="bg-[#21262d] text-terminal-white text-[11px] px-3 py-1.5 rounded-r-xl rounded-bl-xl rounded-tl-none leading-relaxed break-all whitespace-pre-wrap select-text">
              {smsData.body || ""}
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-end max-w-[90%] self-end">
            <span className="text-[9px] text-[#f1e05a]/60 mb-0.5 mr-1">나 → {senderName}</span>
            <div className="bg-[#f1e05a] text-terminal-bg text-[11px] px-3 py-1.5 rounded-l-xl rounded-br-xl rounded-tr-none font-semibold leading-relaxed break-all whitespace-pre-wrap select-text">
              {smsData.body || ""}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
