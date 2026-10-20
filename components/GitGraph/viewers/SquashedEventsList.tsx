"use client";

import { SquashedEvent } from "@/types/commit";

interface SquashedEventsListProps {
  events: SquashedEvent[];
}

export default function SquashedEventsList({ events }: SquashedEventsListProps) {
  if (!events || events.length === 0) {
    return <div className="text-[9px] text-terminal-gray/40 font-mono">단일 이벤트입니다.</div>;
  }

  return (
    <div className="flex flex-col">
      <div className="space-y-1">
        <div className="text-[9px] text-terminal-gray/50 font-bold mb-1 tracking-wider uppercase font-mono">
          Squashed Events ({events.length})
        </div>
        {events.map((ev, si) => (
          <div
            key={si}
            className="flex items-center justify-between text-[10px] text-terminal-white/80 font-mono bg-terminal-surface/30 px-1.5 py-0.5 rounded"
          >
            <span className="truncate pr-2">{ev.note || ev.pkg}</span>
            <span className="text-terminal-gray/50 shrink-0">{ev.durationSec}s</span>
          </div>
        ))}
      </div>
    </div>
  );
}
