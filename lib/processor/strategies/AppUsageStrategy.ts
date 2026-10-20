import { SQLiteDBConnection } from "@capacitor-community/sqlite";
import { CommitProcessorStrategy, DBRawEvent, ProcessorContext } from "../types";
import { locationHint } from "@/lib/rematch";
import { 
  generateCommitId, 
  resolveAppName, 
  resolveBranchId,
  IDLE_THRESHOLD_MS,
  MERGE_WINDOW_MS,
  SPLIT_THRESHOLD_MS,
  MICRO_COMMIT_SEC
} from "../utils";

export class AppUsageStrategy implements CommitProcessorStrategy {
  eventType = "APP_USAGE" as const;

  async process(
    db: SQLiteDBConnection,
    event: DBRawEvent,
    lastCommitCache: any,
    context: ProcessorContext
  ) {
    const pkg = event.app_package || "";
    const payloadsToReturn: any[] = [];
    let squashedEvents: any[] = [];
    
    // 네이티브에서 추출한 다국어 앱 이름(label) 우선 적용
    let parsedLabel = null;
    try {
      if (event.raw_data) {
        const raw = JSON.parse(event.raw_data);
        if (raw.label && raw.label !== pkg) {
          parsedLabel = raw.label;
        }
      }
    } catch (e) {}
    const appName = parsedLabel || resolveAppName(pkg);

    // 1. 동일 앱 재접속 또는 연속 사용 (병합 윈도우 5분 이내)
    if (lastCommitCache && lastCommitCache.event_type === "APP_USAGE" && lastCommitCache.app_package === pkg) { // a CALL/SMS/... of the same package is not a re-entry
      const gap = event.started_at - lastCommitCache.ended_at;
      const totalDurationSoFar = event.started_at - lastCommitCache.started_at;
      
      // 5분 이내의 연속 이벤트는 무조건 기존 커밋에 시간 연장 (중복 생성 방지)
      if (gap < MERGE_WINDOW_MS && totalDurationSoFar < SPLIT_THRESHOLD_MS) {
        const newDuration = Math.max(1, Math.floor((event.started_at - lastCommitCache.started_at) / 1000));
        
        await db.run(
          `UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?`,
          [event.started_at, newDuration, lastCommitCache.id],
          false
        );

        return {
          shouldCreateNew: false,
          updatedCommitId: lastCommitCache.id
        };
      }
    }

    // 1b. 직전 커밋이 다른 타입(REPLY/NOTIFICATION/CALL 등)이었더라도, 2분 이내에 동일 앱 커밋이 있었는지 DB에서 확인.
    //     Only if it is still the LATEST app-usage commit: another app used in between (A -> B -> A) means A really
    //     stopped, and extending A over B's time would count that time twice.
    try {
      const recentSameAppRes = await db.query(
        `SELECT * FROM commits c WHERE app_package = ? AND event_type = 'APP_USAGE' AND id NOT LIKE 'us:%'
           AND NOT EXISTS (SELECT 1 FROM commits o WHERE o.event_type = 'APP_USAGE' AND o.started_at > c.started_at AND o.app_package IS NOT c.app_package)
         ORDER BY ended_at DESC LIMIT 1`,
        [pkg]
      );
      if (recentSameAppRes.values && recentSameAppRes.values.length > 0) {
        const recentSame = recentSameAppRes.values[0];
        const gap = event.started_at - recentSame.ended_at;
        if (gap >= 0 && gap < 120000) {
          const newDuration = Math.max(1, Math.floor((event.started_at - recentSame.started_at) / 1000));
          await db.run(
            `UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?`,
            [event.started_at, newDuration, recentSame.id],
            false
          );
          return {
            shouldCreateNew: false,
            updatedCommitId: recentSame.id
          };
        }
      }
    } catch {}

    // 2. 새로운 커밋을 생성해야 하는 경우 (다른 앱이거나, 분할 기준을 초과한 동일 앱)
    let prevBranchId = 1;
    let prevBranchName = "main";
    let isPrevDeleted = false;

    if (lastCommitCache) {
      const gapFromLast = event.started_at - lastCommitCache.ended_at;
      prevBranchId = lastCommitCache.branch_id;
      
      // 이전 커밋 닫기: Idle 공백이면 마지막 이벤트 시점에서 바로 닫음, 연속이면 새 이벤트까지 인정
      const closedEndedAt = gapFromLast > IDLE_THRESHOLD_MS
        ? lastCommitCache.ended_at
        : event.started_at;
        
      const closedDuration = Math.max(1, Math.floor((closedEndedAt - lastCommitCache.started_at) / 1000));
      
      // 2a. 초단기 사용(MICRO_COMMIT_SEC 미만) 마이크로 커밋 스쿼시
      if (closedDuration < MICRO_COMMIT_SEC && lastCommitCache.app_package !== pkg && lastCommitCache.event_type === "APP_USAGE") {
        await db.run(`DELETE FROM commits WHERE id = ?`, [lastCommitCache.id], false);
        isPrevDeleted = true;
        
        squashedEvents.push({
          pkg: lastCommitCache.app_package,
          note: lastCommitCache.subject,
          durationSec: closedDuration
        });

        // 삭제된 이전 커밋이 보유했던 squashed_events도 승계
        if (lastCommitCache.squashed_events) {
          try {
            const oldSquashed = JSON.parse(lastCommitCache.squashed_events);
            if (Array.isArray(oldSquashed)) squashedEvents = [...oldSquashed, ...squashedEvents];
          } catch (e) {}
        }
        
        prevBranchId = 1;
      } else {
        // 정상 커밋 종료 처리 - only an open-ended APP_USAGE commit is extended (a CALL keeps its logged duration,
        // SMS / PHOTO / LOCATION / REPLY / memos keep their own span)
        if (lastCommitCache.event_type === "APP_USAGE") {
          await db.run(
            `UPDATE commits SET ended_at = ?, duration_sec = ? WHERE id = ?`,
            [closedEndedAt, closedDuration, lastCommitCache.id],
            false
          );
        }
        
        if (prevBranchId !== 1) {
          const branchRes = await db.query("SELECT name FROM branches WHERE id = ?", [prevBranchId]);
          prevBranchName = branchRes.values?.[0]?.name || `branch-${prevBranchId}`;
        }
      }

      // 2b. 공백 발생 시 → 의미 있는 브랜치 활동(30초 이상)이었을 때만 merge + Idle state 커밋 삽입
      if (!isPrevDeleted && gapFromLast > IDLE_THRESHOLD_MS) {
        if (prevBranchId !== 1 && closedDuration >= 30) {
          const mergeId = generateCommitId();
          await db.run(
            `INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, created_at)
             VALUES (?, 1, ?, ?, ?, 0, 'MERGE', ?)`,
            [mergeId, `merge: Merge '${prevBranchName}' into main`, closedEndedAt + 1, closedEndedAt + 1, Date.now()],
            false
          );
        }
        
        // Idle state (공백 시간) 커밋 생성
        const idleStartedAt = closedEndedAt + 2;
        const idleEndedAt = event.started_at - 1;
        const idleDuration = Math.max(1, Math.floor((idleEndedAt - idleStartedAt) / 1000));
        
        if (idleDuration >= 300) { // 5분 이상의 실제 공백일 때만 Idle 커밋 생성
          payloadsToReturn.push({
            id: generateCommitId(),
            branch_id: 1,
            subject: "chore: Idle state",
            body: null,
            author_tag: null,
            started_at: idleStartedAt,
            ended_at: idleEndedAt,
            duration_sec: idleDuration,
            app_package: null,
            event_type: "APP_USAGE",
            geofence_name: context.geofenceName,
            lat: context.lat,
            lng: context.lng,
            created_at: Date.now(),
            squashed_events: "[]"
          });
        }
        
        prevBranchId = 1;
      }
    }

    // 3. 새 커밋 생성 준비
    const commitId = generateCommitId();
    const branchId = resolveBranchId(pkg);
    const branchName = (await db.query("SELECT name FROM branches WHERE id = ?", [branchId])).values?.[0]?.name || "main";
    const hint = locationHint(context.geofenceName);
    
    // 브랜치 전환 시 merge 처리 (이전 브랜치 활동이 30초 이상 지속되었을 때만 머지 생성)
    if (prevBranchId !== 1 && prevBranchId !== branchId && !isPrevDeleted) {
      const prevDur = lastCommitCache?.duration_sec || 0;
      if (prevDur >= 30) {
        const mergeId = generateCommitId();
        await db.run(
          `INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, event_type, created_at)
           VALUES (?, 1, ?, ?, ?, 0, 'MERGE', ?)`,
          [mergeId, `merge: Merge '${prevBranchName}' into main`, event.started_at - 1, event.started_at - 1, Date.now()]
        );
      }
    }

    // 4. 스토리텔링 Subject 작성
    let stateVerb = "사용";
    if (branchName === "feature/web") stateVerb = "브라우징";
    else if (branchName === "feature/media" || branchName === "feature/life") stateVerb = "이용";
    else if (branchName === "feature/sns") stateVerb = "확인";
    else if (branchName === "feature/work") stateVerb = "작업";
    else if (branchName === "feature/game") stateVerb = "플레이";
    else if (branchName === "feature/etc" || branchName === "feature/system") stateVerb = "사용";
    
    // 분할 기준을 초과해서 동일 앱이 분할된 경우 → 감성적인 동사로 변경
    if (lastCommitCache && lastCommitCache.event_type === "APP_USAGE" && lastCommitCache.app_package === pkg) { // a CALL/SMS/... of the same package is not a re-entry
      stateVerb = branchName === "feature/media" ? "시청중" : "몰입중";
    }
    
    let subject = (branchName === "feature/sns" || branchName === "feature/system")
      ? `chore: ${appName} ${stateVerb}${hint}`
      : `feat: ${appName} ${stateVerb}${hint}`;

    payloadsToReturn.push({
      id: commitId,
      branch_id: branchId,
      subject,
      body: null,
      author_tag: null,
      started_at: event.started_at,
      ended_at: event.started_at,
      duration_sec: 1,
      app_package: pkg,
      event_type: this.eventType,
      geofence_name: context.geofenceName,
      lat: context.lat,
      lng: context.lng,
      created_at: Date.now(),
      squashed_events: JSON.stringify(squashedEvents)
    });

    return {
      shouldCreateNew: true,
      commitPayloads: payloadsToReturn
    };
  }
}
