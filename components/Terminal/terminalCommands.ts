import { getRecentCommits, searchCommitsFTS } from "@/lib/queries";
import { tokenizeCommandLine } from "@/lib/commandToken";
import { parseQueryArgs, resolveQueryArgs } from "@/lib/queryCommand";
import { loadQueryContext, runQuery } from "@/lib/queryRun";
import { summarizeRequest } from "@/lib/query";
import { queryText } from "@/lib/queryText";

export interface TerminalLine {
  type: "command" | "output" | "error" | "success" | "info" | "debug" | "db";
  text: string;
}

/** FTS 검색 공용 실행 헬퍼 (git search 및 git log --grep 공유) */
async function runFtsSearch(query: string, limit = 10): Promise<TerminalLine[]> {
  const lines: TerminalLine[] = [];
  lines.push({ type: "info", text: `Searching commits for "${query}" via SQLite FTS5...` });
  try {
    const results = await searchCommitsFTS(query, limit);
    if (results.length === 0) {
      lines.push({ type: "debug", text: `No commits matched "${query}".` });
    } else {
      lines.push({ type: "success", text: `✓ Found ${results.length} matched commit(s):` });
      results.forEach((c) => {
        const time = new Date(c.startedAt).toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
        });
        lines.push({
          type: "output",
          text: `[${c.id.slice(0, 7)}] (${time}) ${c.subject} ${c.geofenceName ? `@ ${c.geofenceName}` : ""}`,
        });
      });
    }
  } catch (e: any) {
    lines.push({ type: "error", text: `Search error: ${e.message}` });
  }
  return lines;
}

/**
 * 터미널 명령어 실행기
 */
export async function executeTerminalCommand(
  rawInput: string,
  isReady: boolean
): Promise<TerminalLine[]> {
  const input = rawInput.trim();
  if (!input) return [];

  const lines: TerminalLine[] = [{ type: "command", text: `$ ${input}` }];

  if (!isReady) {
    lines.push({ type: "error", text: "Database daemon is still initializing..." });
    return lines;
  }

  let parts: string[];
  try {
    parts = tokenizeCommandLine(input);
  } catch (e: any) {
    lines.push({ type: "error", text: e.message || "명령행 구문 분석 오류" });
    return lines;
  }

  if (parts.length === 0) return lines;

  const mainCmd = parts[0].toLowerCase();
  const subCmd = parts[1]?.toLowerCase();

  // 1. git search <keyword>
  if (mainCmd === "git" && subCmd === "search") {
    const query = parts.slice(2).join(" ").trim();
    if (!query) {
      lines.push({ type: "error", text: "Usage: git search <keyword>" });
      return lines;
    }
    const searchLines = await runFtsSearch(query, 10);
    return [...lines, ...searchLines];
  }

  // 2. git log
  if (mainCmd === "git" && subCmd === "log") {
    const logArgs = parts.slice(2);
    const parsedArgs = parseQueryArgs(logArgs);
    if (!parsedArgs.ok) {
      lines.push({ type: "error", text: parsedArgs.reason });
      return lines;
    }

    // 2-1. 옵션 없는 git log 또는 -n <N> 단독 - loadQueryContext 불필요
    if (parsedArgs.value.kind === "raw") {
      lines.push({ type: "info", text: "Fetching recent commits..." });
      try {
        const commits = await getRecentCommits(parsedArgs.value.limit);
        if (commits.length === 0) {
          lines.push({ type: "debug", text: "No commit history found." });
        } else {
          commits.forEach((c) => {
            const timeStr = new Date(c.startedAt).toLocaleString("ko-KR", {
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
            });
            lines.push({
              type: "output",
              text: `commit ${c.id.slice(0, 7)} - [${timeStr}]\n  ${c.subject}`,
            });
          });
        }
      } catch (e: any) {
        lines.push({ type: "error", text: `Failed to fetch log: ${e.message}` });
      }
      return lines;
    }

    // 2-2. git log --grep=<kw> - loadQueryContext 불필요
    if (parsedArgs.value.kind === "grep") {
      const searchLines = await runFtsSearch(parsedArgs.value.keyword, parsedArgs.value.limit);
      return [...lines, ...searchLines];
    }

    // 2-3. 구조 질의 (loadQueryContext -> resolveQueryArgs -> runQuery)
    try {
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      const qctx = await loadQueryContext(db);

      const resolved = resolveQueryArgs(parsedArgs.value, qctx.candidates);
      if (!resolved.ok) {
        lines.push({ type: "error", text: resolved.reason });
        return lines;
      }

      const req = resolved.value;
      const res = await runQuery(req, db, qctx);
      if (!res.ok) {
        lines.push({ type: "error", text: res.reason });
        return lines;
      }

      const qResult = res.value;

      // 머리줄
      let targetLabel: string | undefined;
      if (req.target) {
        const t = req.target;
        if (t.type === "app") {
          targetLabel = qctx.candidates.apps.find((a) => a.pkg === t.pkg)?.label || t.pkg;
        } else if (t.type === "person") {
          targetLabel = qctx.candidates.people.find((p) => p.key === t.key)?.name || t.key;
        } else if (t.type === "place") {
          targetLabel = t.name;
        } else if (t.type === "tag") {
          const { normalizeTag } = await import("@/lib/query");
          targetLabel = `#${normalizeTag(t.tag)}`;
        }
      }
      const header = summarizeRequest(req, targetLabel);
      lines.push({ type: "info", text: `✦ ${header}` });

      // 값 및 요약
      const mainVal = qResult.unit ? `${qResult.value} ${qResult.unit}` : qResult.value;
      if (mainVal && mainVal !== qResult.summary) {
        lines.push({ type: "success", text: `${mainVal} (${qResult.summary})` });
      } else {
        lines.push({ type: "success", text: mainVal || qResult.summary });
      }

      // 근거 행
      const displayRows = req.limit ? qResult.rows.slice(0, req.limit) : qResult.rows;
      if (displayRows.length === 0) {
        lines.push({ type: "debug", text: "  (일치하는 기록 없음)" });
      } else {
        displayRows.forEach((r) => {
          const timePart = r.time ? `[${r.time}] ` : "";
          const textPart = r.text ? ` — ${r.text}` : "";
          lines.push({
            type: "output",
            text: `  ${timePart}${r.title}${textPart}`,
          });
        });
        if (qResult.rows.length > displayRows.length) {
          const T = queryText();
          lines.push({
            type: "debug",
            text: `  ... ${T.omitted(qResult.rows.length - displayRows.length)}`,
          });
        }
      }
    } catch (e: any) {
      lines.push({ type: "error", text: `Failed to fetch log: ${e.message}` });
    }
    return lines;
  }

  // 3. git status
  if (mainCmd === "git" && subCmd === "status") {
    try {
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      const rawRes = await db.query("SELECT COUNT(*) as cnt FROM raw_events WHERE is_processed = 0");
      const unprocCnt = rawRes.values?.[0]?.cnt || 0;

      const commitRes = await db.query("SELECT COUNT(*) as cnt FROM commits");
      const totalCommits = commitRes.values?.[0]?.cnt || 0;

      lines.push({ type: "success", text: "On branch main" });
      lines.push({
        type: "info",
        text: `Status: Database connected (SQLCipher + FTS5)\nTotal Commits: ${totalCommits}\nUnprocessed Raw Events: ${unprocCnt}`,
      });
    } catch (e: any) {
      lines.push({ type: "info", text: "Status: Web Demo Mode (Mock SQLite Active)" });
    }
    return lines;
  }

  // 4. git commit -m "<msg>"
  if (mainCmd === "git" && subCmd === "commit") {
    const mIndex = parts.indexOf("-m");
    if (mIndex === -1 || mIndex === parts.length - 1) {
      lines.push({ type: "error", text: 'Usage: git commit -m "<message>"' });
      return lines;
    }
    const message = parts.slice(mIndex + 1).join(" ").trim();
    if (!message) {
      lines.push({ type: "error", text: "Commit message cannot be empty." });
      return lines;
    }

    try {
      const { createManualCommit } = await import("@/lib/commitManager");
      const cid = await createManualCommit({ subject: message });
      lines.push({ type: "success", text: `[main ${cid.slice(0, 7)}] ${message}` });
      lines.push({ type: "info", text: "1 file changed, 1 insertion(+) [manual commit]" });
    } catch (e: any) {
      lines.push({ type: "error", text: `Commit failed: ${e.message}` });
    }
    return lines;
  }

  // 5. git rm <id>
  if (mainCmd === "git" && subCmd === "rm") {
    const targetId = parts[2]?.trim();
    if (!targetId) {
      lines.push({ type: "error", text: "Usage: git rm <commit_id>" });
      return lines;
    }

    try {
      const { deleteCommit } = await import("@/lib/commitManager");
      await deleteCommit(targetId);
      lines.push({ type: "success", text: `✓ Removed commit '${targetId}'` });
    } catch (e: any) {
      lines.push({ type: "error", text: `Delete failed: ${e.message}` });
    }
    return lines;
  }

  // 6. git branch
  if (mainCmd === "git" && subCmd === "branch") {
    try {
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      const res = await db.query("SELECT * FROM branches ORDER BY id ASC");
      lines.push({ type: "info", text: "Registered Branches:" });
      res.values?.forEach((b: any) => {
        lines.push({
          type: "output",
          text: `  * ${b.name.padEnd(16)} (id: ${b.id}, color: ${b.color})`,
        });
      });
    } catch (e: any) {
      lines.push({ type: "error", text: `Branch error: ${e.message}` });
    }
    return lines;
  }

  // 7. geofence list (list 외 하위 명령 차단)
  if (mainCmd === "geofence" || mainCmd === "geo") {
    const isList = parts.length === 1 || (parts.length === 2 && subCmd === "list");
    if (!isList) {
      lines.push({
        type: "error",
        text: "지원하지 않는 명령입니다. geofence는 'geofence list'만 지원하며, 장소 추가·수정·삭제는 설정 모달을 이용해 주세요.",
      });
      return lines;
    }

    try {
      const { fetchGeofences } = await import("@/lib/geofenceManager");
      const gfs = await fetchGeofences();
      lines.push({ type: "info", text: `Registered Geofences (${gfs.length}):` });
      gfs.forEach((g) => {
        lines.push({
          type: "output",
          text: `  📍 ${g.name.padEnd(12)} -> [${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}] (radius: ${g.radius_m}m, branch: ${g.branch_trigger})`,
        });
      });
    } catch (e: any) {
      lines.push({ type: "error", text: `Geofence error: ${e.message}` });
    }
    return lines;
  }

  // 8. tag list (list 외 하위 명령 차단)
  if (mainCmd === "tag" || mainCmd === "tags") {
    const isList = parts.length === 1 || (parts.length === 2 && subCmd === "list");
    if (!isList) {
      lines.push({
        type: "error",
        text: "지원하지 않는 명령입니다. tag는 'tag list'만 지원하며, 태그 추가·수정·삭제는 설정 모달을 이용해 주세요.",
      });
      return lines;
    }

    try {
      const { fetchContactTags, formatContactTagDisplayName } = await import("@/lib/tagManager");
      const tagList = await fetchContactTags();
      lines.push({ type: "info", text: `Contact Tags (${tagList.length}):` });
      tagList.forEach((t) => {
        const displayTag = `#${t.tag.replace(/^[#@]+/, "")}`;
        const displayName = formatContactTagDisplayName(t, tagList);
        lines.push({
          type: "output",
          text: `  🏷️  ${displayName.padEnd(14)} -> ${displayTag}`,
        });
      });
    } catch (e: any) {
      lines.push({ type: "error", text: `Tag error: ${e.message}` });
    }
    return lines;
  }

  // 9. backup export
  if (mainCmd === "backup" && subCmd === "export") {
    lines.push({ type: "info", text: "Generating JSON backup package..." });
    try {
      const { exportDatabaseBackup } = await import("@/lib/backup");
      const res = await exportDatabaseBackup();
      lines.push({ type: "success", text: `✓ Backup successful: ${res.count} commits exported to ${res.filename}` });
    } catch (e: any) {
      lines.push({ type: "error", text: `Export failed: ${e.message}` });
    }
    return lines;
  }

  // 10. reset db (destructive -- requires explicit "reset db confirm" follow-up)
  if (input.toLowerCase() === "reset db") {
    lines.push({
      type: "error",
      text: "This will permanently wipe ALL commits and raw events. Type 'reset db confirm' to proceed.",
    });
    return lines;
  }

  if (input.toLowerCase() === "reset db confirm") {
    lines.push({ type: "error", text: "Wiping all DB records (commits, raw_events)..." });
    try {
      const { executeInTransaction } = await import("@/lib/db");
      const { wipeRecordsToNewEpoch } = await import("@/lib/usageDrain");
      const { Capacitor } = await import("@capacitor/core");
      const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
      const native = Capacitor.isNativePlatform();
      const nativeEpoch = native ? (await LifeCommitPlugin.usageEpoch()).epoch : 0;
      const target = await executeInTransaction((d) => wipeRecordsToNewEpoch(d, nativeEpoch), { requireTransaction: true });
      if (native) await LifeCommitPlugin.resetUsage({ target }).catch((e) => console.warn("[reset db] native reset failed:", e));
      lines.push({ type: "success", text: "✓ DB successfully wiped. Ready for fresh events!" });
    } catch (e: any) {
      lines.push({ type: "error", text: `Reset error: ${e.message}` });
    }
    return lines;
  }

  // 11. help
  if (mainCmd === "help") {
    lines.push({
      type: "info",
      text: [
        "Available LifeCommit terminal commands (git 호환 아님, LifeCommit 조회 문법):",
        "  git log               - 최근 커밋 기록 5개 조회",
        "  git log [--since=<날짜>] [--until=<날짜>] [--time=any|morning|lunch|afternoon|evening|night]",
        "          [--type=app|call|sms|reply|location] [--app=<앱>] [--author=<사람>|--author=@<태그>]",
        "          [--place=<장소>] [--count|--duration] [-n <N>]",
        "          (날짜: today, yesterday, N.days.ago, N.weeks.ago, YYYY-MM-DD)",
        "          (--author=@태그 형태로 태그 지정, 직접 키 지정: --author=tel:... 또는 --author=msg:...)",
        "          (-n: 근거 행 표시 수, 1~50, 집계값은 불변)",
        "  git log --grep=<kw>   - 키워드 전체 텍스트 검색 (FTS5)",
        "  git search <kw>       - git log --grep=<kw> 와 동일",
        "",
        "조회 예시:",
        "  git log --type=app --since=7.days.ago --duration",
        "  git log --type=call --author=@친구 --count",
        '  git log --place="geofence:회사"',
        "",
        "기타 관리 명령:",
        '  git commit -m "<msg>" - Create a manual life commit',
        "  git rm <commit_id>    - Delete a specific commit",
        "  git branch            - List all branches",
        "  git status            - Show database & sync status",
        "  geofence list         - View registered places (별칭: geo list, 반경 허용: 10~5000m)",
        "                          (범위 밖 기존 장소는 수정 시 10~5000m 범위로 변경 필요)",
        "  tag list              - View contact tag mappings (별칭: tags list)",
        "  backup export         - Export entire DB to JSON backup file",
        "  clear                 - Clear terminal screen",
        "  reset db              - Wipe all commit records (requires 'reset db confirm')",
        "  help                  - Show this help menu",
      ].join("\n"),
    });
    return lines;
  }

  lines.push({ type: "error", text: `Command not found: ${input}. Type 'help' for available commands.` });
  return lines;
}
