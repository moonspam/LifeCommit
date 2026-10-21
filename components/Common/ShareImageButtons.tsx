"use client";

import { useState } from "react";

interface ShareImageButtonsProps {
  onShare: () => Promise<void> | void;
  onSave: () => Promise<void> | void;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "xs";
}

export default function ShareImageButtons({
  onShare,
  onSave,
  disabled = false,
  className = "",
  size = "xs",
}: ShareImageButtonsProps) {
  const [isSharing, setIsSharing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const handleShare = async () => {
    if (disabled || isSharing || isSaving) return;
    setIsSharing(true);
    try {
      await onShare();
    } finally {
      setIsSharing(false);
    }
  };

  const handleSave = async () => {
    if (disabled || isSharing || isSaving) return;
    setIsSaving(true);
    try {
      await onSave();
    } finally {
      setIsSaving(false);
    }
  };

  const btnPadding = size === "xs" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs";

  return (
    <div className={`flex items-center gap-1 font-mono select-none ${className}`}>
      <button
        type="button"
        disabled={disabled || isSharing || isSaving}
        onClick={handleShare}
        className={`${btnPadding} rounded-sm bg-terminal-surface hover:bg-[#21262d] border border-terminal-border text-terminal-white hover:text-white transition-all disabled:opacity-40 flex items-center gap-1 cursor-pointer`}
        title="이미지 공유"
      >
        <span>{isSharing ? "..." : "공유"}</span>
      </button>
      <button
        type="button"
        disabled={disabled || isSharing || isSaving}
        onClick={handleSave}
        className={`${btnPadding} rounded-sm bg-terminal-surface hover:bg-[#21262d] border border-terminal-border text-terminal-white hover:text-white transition-all disabled:opacity-40 flex items-center gap-1 cursor-pointer`}
        title="사진(갤러리)에 저장"
      >
        <span>{isSaving ? "..." : "저장"}</span>
      </button>
    </div>
  );
}
