export interface ReplayButtonProps {
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

export default function ReplayButton({ onClick, loading = false, disabled = false }: ReplayButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      className="px-2.5 py-1 text-xs border border-terminal-green/50 rounded-sm text-terminal-green hover:bg-terminal-green/10 font-mono disabled:opacity-50"
    >
      {loading ? "불러오는 중..." : "▶ 이동 리플레이"}
    </button>
  );
}
