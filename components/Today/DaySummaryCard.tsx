import type { Flavor } from "@/lib/flavor";
import { formatDuration } from "@/lib/today";
import { reasonLabel, type Gap } from "@/lib/coverage";

export interface DaySummaryCardProps {
  date: string;
  todayKey: string;
  summary: {
    activitySec: number;
    topApps: { name: string; durationSec: number }[];
    longestSession: { name: string; durationSec: number } | null;
    places: string[];
    calls: number;
    sms: number;
    photos: number;
  };
  flavor?: Flavor;
  gaps?: Gap[];
  /** 수집이 아직 첫 화면 꺼짐을 기다리는 중 (설치 직후 1회) */
  screenOffHint?: boolean;
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

export default function DaySummaryCard({ date, todayKey, summary, flavor = "full", gaps = [], screenOffHint = false }: DaySummaryCardProps) {
  return (
    <div className="rounded-xl border border-terminal-border bg-terminal-surface p-3 space-y-2 font-mono">
      {/* 카드 제목 줄 */}
      <div className="text-terminal-green font-bold text-xs">
        {date === todayKey ? "오늘의" : "이날의"} 요약 · {formatDuration(summary.activitySec)}
      </div>

      {/* 라벨/값 2열 격자 */}
      <div className="grid grid-cols-[4.5em_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs items-baseline">
        {/* 상위 앱 */}
        <span className="text-terminal-gray text-[11px]">상위 앱</span>
        <div className="text-terminal-white flex flex-wrap gap-1 min-w-0 wrap-anywhere">
          {summary.topApps.length > 0 ? (
            summary.topApps.map((app, i) => (
              <span key={i} className="inline-block bg-terminal-bg/60 border border-terminal-border/50 rounded-sm px-1.5 py-0.5 text-[11px] text-terminal-white max-w-full">
                {app.name} {formatDuration(app.durationSec)}
              </span>
            ))
          ) : (
            <span className="text-terminal-gray text-[11px]">기록 없음</span>
          )}
        </div>

        {/* 최장 (있을 때만 표시) */}
        {summary.longestSession && (
          <>
            <span className="text-terminal-gray text-[11px]">최장</span>
            <div className="text-terminal-white text-[11px] min-w-0 wrap-anywhere">
              {summary.longestSession.name} {formatDuration(summary.longestSession.durationSec)}
            </div>
          </>
        )}

        {/* 장소 (full 전용) */}
        {flavor === "full" && (
          <>
            <span className="text-terminal-gray text-[11px]">장소</span>
            <div className="text-terminal-white text-[11px] min-w-0 wrap-anywhere">
              {summary.places.length > 0 ? summary.places.join(" · ") : "기록 없음"}
            </div>
          </>
        )}
      </div>

      {/* 통화·SMS·사진 (full 전용, 3칸 타일) */}
      {flavor === "full" && (
        <div className="grid grid-cols-3 gap-2 pt-1 border-t border-terminal-border/40 text-center">
          <div className={`rounded-sm bg-terminal-bg/40 p-1.5 ${summary.calls === 0 ? "opacity-40" : ""}`}>
            <div className="text-[10px] text-terminal-gray">통화</div>
            <div className="text-sm font-bold text-terminal-white">{summary.calls}</div>
          </div>
          <div className={`rounded-sm bg-terminal-bg/40 p-1.5 ${summary.sms === 0 ? "opacity-40" : ""}`}>
            <div className="text-[10px] text-terminal-gray">SMS</div>
            <div className="text-sm font-bold text-terminal-white">{summary.sms}</div>
          </div>
          <div className={`rounded-sm bg-terminal-bg/40 p-1.5 ${summary.photos === 0 ? "opacity-40" : ""}`}>
            <div className="text-[10px] text-terminal-gray">사진</div>
            <div className="text-sm font-bold text-terminal-white">{summary.photos}</div>
          </div>
        </div>
      )}

      {screenOffHint && (
        <div className="text-terminal-blue text-[11px] pt-1 border-t border-terminal-border/60">
          📱 화면을 한 번 껐다 켜 주세요. 그때부터 앱 사용 기록이 쌓입니다.
        </div>
      )}

      {/* 수집 확인 불가 줄: 맨 아래 노란 글씨 */}
      {gaps.length > 0 && (
        <div className="text-terminal-yellow text-[11px] pt-1 wrap-anywhere">
          수집 확인 불가 {gaps.map((g) => `${hhmm(g.from)}–${hhmm(g.to)} (${reasonLabel(g.reason)})`).join(" · ")}
        </div>
      )}
    </div>
  );
}
