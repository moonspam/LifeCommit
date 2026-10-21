"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { getRecentRawEvents } from "@/lib/queries";
import { executeTerminalCommand, TerminalLine } from "./terminalCommands";

interface TerminalPanelProps {
  isReady: boolean;
  dbStatus: "initializing" | "ready" | "error";
  autoCommand: string | null;
  onAutoCommandClear: () => void;
}

const INITIAL_LINES: TerminalLine[] = [
  { type: "info", text: "Starting LifeCommit DB daemon..." },
];

function getLineColor(type: TerminalLine["type"]): string {
  switch (type) {
    case "command":
      return "text-terminal-green";
    case "success":
      return "text-terminal-blue font-bold";
    case "error":
      return "text-terminal-red";
    case "info":
      return "text-terminal-gray";
    case "debug":
      return "text-terminal-gray opacity-50 italic";
    case "db":
      return "text-terminal-purple opacity-90";
    case "output":
      return "text-terminal-white font-bold";
    default:
      return "text-terminal-white";
  }
}

export default function TerminalPanel({
  isReady,
  dbStatus,
  autoCommand,
  onAutoCommandClear,
}: TerminalPanelProps) {
  const [lines, setLines] = useState<TerminalLine[]>(INITIAL_LINES);
  const [inputValue, setInputValue] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  const lastEventIdRef = useRef<number>(0);
  const lastCommitIdRef = useRef<string>("");
  const isPollingRef = useRef<boolean>(false);

  // 실시간 DB 폴링 및 처리 데몬
  useEffect(() => {
    if (!isReady || dbStatus !== "ready") return;

    setLines((prev) => [...prev, { type: "success", text: "✓ LifeCommit DB Ready. Monitoring events..." }]);

    const interval = setInterval(async () => {
      if (document.visibilityState !== "visible") return;
      if (isPollingRef.current) return;
      isPollingRef.current = true;

      try {
        const { Capacitor } = await import("@capacitor/core");
        if (Capacitor.getPlatform() === "web") {
          isPollingRef.current = false;
          return;
        }

        const { getDB } = await import("@/lib/db");
        const db = getDB();

        // 1. 최신 이벤트 20개 가져오기
        const events = await getRecentRawEvents(20);
        const newEvents = events.filter((e) => e.id > lastEventIdRef.current);

        if (newEvents.length > 0) {
          newEvents.reverse();

          if (lastEventIdRef.current === 0) {
            lastEventIdRef.current = newEvents[newEvents.length - 1].id;
          } else {
            lastEventIdRef.current = newEvents[newEvents.length - 1].id;

            const newLines: TerminalLine[] = newEvents.map((e) => {
              const timeStr = new Date(e.started_at).toLocaleTimeString();
              let text = `[${timeStr}] ${e.event_type}`;
              if (e.app_package) text += ` -> ${e.app_package}`;

              return {
                type: e.event_type === "LOCATION" || e.event_type === "GPS" ? "db" : "debug",
                text: text,
              };
            });

            setLines((prev) => [...prev.slice(-100), ...newLines]);
          }
        }

        // 2. 최근 커밋 상태 감시 및 터미널 출력
        const lastCommitRes = await db.query("SELECT id, subject FROM commits ORDER BY started_at DESC LIMIT 1");
        if (lastCommitRes.values && lastCommitRes.values.length > 0) {
          const lastCommit = lastCommitRes.values[0];
          if (lastCommitIdRef.current && lastCommit.id !== lastCommitIdRef.current) {
            setLines((prev) => [
              ...prev.slice(-100),
              { type: "success", text: `✓ New commit matched: ${lastCommit.subject}` },
            ]);
          }
          lastCommitIdRef.current = lastCommit.id;
        }
      } catch (err) {
        console.error("Polling error:", err);
      } finally {
        isPollingRef.current = false;
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isReady, dbStatus]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  // 자동 완성 타이핑 이펙트
  useEffect(() => {
    if (autoCommand) {
      let i = 0;
      setInputValue("");
      const timer = setInterval(() => {
        setInputValue(autoCommand.substring(0, i + 1));
        i++;
        if (i >= autoCommand.length) {
          clearInterval(timer);
          setTimeout(async () => {
            setLines((prev) => [
              ...prev.slice(-100),
              { type: "command", text: `$ ${autoCommand}` },
              { type: "output", text: "Fetching commits from DB for the selected period..." },
            ]);
            setInputValue("");
            onAutoCommandClear();
          }, 400);
        }
      }, 40);
      return () => clearInterval(timer);
    }
  }, [autoCommand, onAutoCommandClear]);

  const handleCommand = useCallback(
    async (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== "Enter" || !inputValue.trim()) return;

      const cmd = inputValue.trim();
      if (cmd.toLowerCase() === "clear") {
        setLines([]);
        setInputValue("");
        return;
      }

      setInputValue("");
      const resultLines = await executeTerminalCommand(cmd, isReady);
      setLines((prev) => [...prev.slice(-100), ...resultLines]);
    },
    [inputValue, isReady]
  );

  return (
    <div className="flex flex-col h-full font-mono text-[10px]">
      {/* 터미널 출력 영역 */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1 scrollbar-hide text-terminal-white">
        {lines.map((line, i) => {
          if (!line) return null;
          return (
            <div key={i} className={`${getLineColor(line.type)} leading-normal animate-fade-in flex gap-2`}>
              {line.type === "command" && <span className="opacity-40">❯</span>}
              <span className="whitespace-pre-wrap break-all">{line.text}</span>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* 명령어 입력 영역 */}
      <div className="flex items-center gap-2 px-4 py-2 bg-terminal-surface border-t border-terminal-border">
        <span className="text-terminal-green shrink-0">❯</span>
        <input
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleCommand}
          placeholder="git log [--type/--since/--grep] | git status | help"
          className="flex-1 bg-transparent text-terminal-white placeholder-terminal-gray outline-hidden caret-terminal-green font-mono text-[11px]"
          autoComplete="off"
          spellCheck={false}
        />
        <span className="text-terminal-green animate-blink text-sm">█</span>
      </div>
    </div>
  );
}
