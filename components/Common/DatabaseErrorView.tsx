"use client";

interface DatabaseErrorViewProps {
  errorMessage?: string | null;
  onResetDB: () => Promise<void> | void;
  onRetry: () => void;
}

export default function DatabaseErrorView({ errorMessage, onResetDB, onRetry }: DatabaseErrorViewProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6 bg-[#0c0d12] text-terminal-white font-mono select-text">
      <div className="w-full max-w-lg border border-red-500/30 rounded-lg p-6 bg-[#161216] shadow-2xl relative overflow-hidden">
        {/* 에러 헤더 */}
        <div className="flex items-center gap-3 border-b border-red-500/20 pb-4 mb-4">
          <span className="animate-ping w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
          <span className="text-red-500 font-bold uppercase tracking-wider text-sm">
            [FATAL ERROR: SYSTEM DATABASE NOT READY]
          </span>
        </div>

        {/* 설명 및 디버그 가이드 */}
        <div className="flex flex-col gap-3 text-xs text-terminal-gray/80 leading-relaxed mb-6">
          <p className="text-terminal-white font-semibold">데이터베이스 마운트 실패 알림:</p>
          <p>
            SQLite 암호화 브릿지 바인딩 또는 스키마 초기화 도중 에러가 발생했습니다.
          </p>
          <div className="bg-[#0b0c0f] border border-terminal-border/40 rounded p-3 text-[11px] text-red-400 font-mono break-all whitespace-pre-wrap">
            {errorMessage || "Error: sqlite.setEncryptionSecret or sqlite.createConnection failed."}
          </div>
          <p>아래 버튼을 사용하여 캐시된 DB 연결과 비밀키를 완전히 초기화하고 새롭게 마운트해 보세요.</p>
        </div>

        {/* 제어 버튼들 */}
        <div className="flex flex-col gap-2">
          <button
            onClick={onResetDB}
            className="w-full py-3 px-4 bg-red-600 hover:bg-red-500 text-white font-bold text-xs uppercase tracking-widest rounded shadow transition-all duration-200"
          >
            ⚡ RESET & REBUILD DATABASE (추천)
          </button>
          <button
            onClick={onRetry}
            className="w-full py-3 px-4 bg-transparent hover:bg-terminal-border/20 text-terminal-green border border-terminal-green/50 font-bold text-xs uppercase tracking-widest rounded transition-all duration-200"
          >
            🔄 RETRY INITIALIZATION
          </button>
        </div>
      </div>
    </div>
  );
}
