"use client";

import { useState } from "react";
import { createManualCommit } from "@/lib/commitManager";

interface QuickCommitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

const QUICK_BRANCHES = ["main", "feature/life", "feature/work", "feature/etc", "feature/system", "feature/health", "feature/study"];
const QUICK_DURATIONS = [15, 30, 45, 60, 90, 120];
const QUICK_TAGS = ["#manual", "#study", "#work", "#health", "#hobby", "#rest"];

export default function QuickCommitModal({ isOpen, onClose, onSuccess }: QuickCommitModalProps) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [branchName, setBranchName] = useState("main");
  const [duration, setDuration] = useState<number>(30);
  const [selectedTag, setSelectedTag] = useState("#manual");
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;

    setIsSubmitting(true);
    try {
      await createManualCommit({
        subject: subject.trim(),
        body: body.trim() || undefined,
        branchName: branchName.trim() || "main",
        authorTag: selectedTag,
        durationMinutes: duration,
      });

      setSubject("");
      setBody("");
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      alert("커밋 생성 실패: " + err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-[#0f1218] border border-terminal-border rounded-xl w-full max-w-md shadow-2xl p-5 flex flex-col gap-4 font-mono text-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 모달 헤더 */}
        <div className="flex items-center justify-between border-b border-terminal-border/60 pb-3">
          <div className="flex items-center gap-2">
            <span className="text-terminal-green text-base">✍️</span>
            <span className="text-terminal-white font-bold text-sm tracking-wide">
              수동 커밋 작성 (Manual Commit)
            </span>
          </div>
          <button
            onClick={onClose}
            className="text-terminal-gray hover:text-terminal-white p-1 rounded hover:bg-terminal-surface transition-colors"
          >
            ✕
          </button>
        </div>

        {/* 폼 */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          {/* 브랜치 선택 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-terminal-gray font-semibold">브랜치 (Branch)</label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUICK_BRANCHES.map((b) => (
                <button
                  type="button"
                  key={b}
                  onClick={() => setBranchName(b)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    branchName === b
                      ? "bg-terminal-green/20 text-terminal-green border border-terminal-green/50 font-bold"
                      : "bg-terminal-surface text-terminal-gray hover:text-terminal-white border border-terminal-border/40"
                  }`}
                >
                  {b}
                </button>
              ))}
            </div>
          </div>

          {/* 커밋 메시지 (Subject) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-terminal-gray font-semibold">
              커밋 메시지 (Subject) <span className="text-terminal-green">*</span>
            </label>
            <div className="flex items-center bg-[#181d26] border border-terminal-border rounded px-3 py-2 focus-within:border-terminal-green transition-colors">
              <span className="text-terminal-green mr-2 text-xs font-bold">$</span>
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="feat: 클린코드 3장 독서 완료"
                required
                autoFocus
                className="bg-transparent text-terminal-white text-xs w-full outline-none placeholder:text-terminal-gray/40 font-mono"
              />
            </div>
          </div>

          {/* 소요 시간 (Duration) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-terminal-gray font-semibold">
              소요 시간 ({duration}분)
            </label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUICK_DURATIONS.map((m) => (
                <button
                  type="button"
                  key={m}
                  onClick={() => setDuration(m)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    duration === m
                      ? "bg-terminal-blue/20 text-terminal-blue border border-terminal-blue/50 font-bold"
                      : "bg-terminal-surface text-terminal-gray hover:text-terminal-white border border-terminal-border/40"
                  }`}
                >
                  {m >= 60 ? `${m / 60}시간` : `${m}분`}
                </button>
              ))}
            </div>
          </div>

          {/* 태그 선택 */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-terminal-gray font-semibold">태그 (Tag)</label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {QUICK_TAGS.map((t) => (
                <button
                  type="button"
                  key={t}
                  onClick={() => setSelectedTag(t)}
                  className={`px-2 py-1 rounded text-xs transition-colors ${
                    selectedTag === t
                      ? "bg-terminal-yellow/20 text-terminal-yellow border border-terminal-yellow/50 font-bold"
                      : "bg-terminal-surface text-terminal-gray hover:text-terminal-white border border-terminal-border/40"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* 메모 본문 (Body) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[11px] text-terminal-gray font-semibold">추가 메모 (선택)</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="상세한 내용이나 느낀 점을 기록하세요..."
              rows={3}
              className="bg-[#181d26] border border-terminal-border rounded p-2.5 text-terminal-white text-xs outline-none focus:border-terminal-green transition-colors resize-none placeholder:text-terminal-gray/40 font-mono"
            />
          </div>

          {/* 제출 버튼 */}
          <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-terminal-border/60 mt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded text-xs text-terminal-gray hover:text-terminal-white hover:bg-terminal-surface transition-colors"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !subject.trim()}
              className="px-4 py-1.5 rounded bg-terminal-green/20 text-terminal-green hover:bg-terminal-green/30 border border-terminal-green/50 text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {isSubmitting ? "커밋 중..." : "git commit ✓"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
