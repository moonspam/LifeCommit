"use client";

import { getFlavor } from "@/lib/flavor";
import { syncUsageSessions } from "@/lib/usageSync";
import { useState, useEffect, useRef, useCallback } from "react";
import { NOISE_PACKAGES } from "@/lib/constants";
import { emit, EVENT_COMMITS_UPDATED } from "@/lib/events";

interface UseAppSyncProps {
  isReady: boolean;
  dbStatus: "initializing" | "ready" | "error";
}

// CALL/SMS/PHOTO 페이지네이션 루프의 안전장치. 이 값에 도달하면(경고 로그만
// 남기고 그 사이클은 멈춘다) 다음 동기화의 floor가 이미 앞으로 전진해 있어
// 그 뒤 남은 과거 기록은 사실상 복구되지 않는다 -- 즉 진짜 무제한 백필을
// 보장하지는 못한다. 다만 개인용 단일 사용자 앱에서 최초 동기화 한 번에
// 20,000페이지(= 페이지 크기 기준 CALL/SMS 200만 건, PHOTO 100만 건)를 넘는
// 기기 이력이 있는 경우는 사실상 없다고 보고, "절대 도달하지 않을" 값으로
// 크게 잡아 무한루프만 막는 순수 안전장치로 쓴다. 이 값에 실제로 도달하는
// 사례가 나온다면, 그때는 이 상수를 더 올리는 게 아니라 재개 가능한(resumable)
// 백필 커서를 제대로 구현하는 것이 맞는 해법이다.
const MAX_SYNC_PAGES = 20000;

/**
 * raw_events에 해당 이벤트 타입의 기록이 아직 없을 때(최초 설치 또는 삭제 후
 * 재설치) 동기화 커서의 하한선(floor)을 구한다. 0을 쓰면 기기에 남아있는
 * 설치 이전 전체 통화/문자/사진 이력이 유입되므로, 앱의 실제 설치 시각을
 * floor로 사용한다. 네이티브 조회가 실패하면 절대 0으로 폴백하지 않고 null을
 * 반환해 이번 동기화 시도를 건너뛰게 한다 (다음 주기에 재시도).
 */
async function getSyncFloorTimestamp(lastTs: number | null | undefined): Promise<number | null> {
  if (lastTs != null) return lastTs;
  try {
    const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
    const { installTime } = await LifeCommitPlugin.getInstallTime();
    // Capacitor 브릿지는 { installTime: undefined } 같은 기형 payload를 resolve할 수
    // 있다. 유효한 양수가 아니면 네이티브 쪽에서 0으로 취급되어(afterTimestamp=0)
    // 설치 이전 전체 이력이 유입되는 버그가 재발하므로, 검증 실패 시 절대 통과시키지
    // 않고 null을 반환해 이번 동기화 시도를 건너뛴다.
    if (!Number.isFinite(installTime) || installTime <= 0) {
      console.warn("[useAppSync] Native getInstallTime() returned an invalid value; skipping this sync attempt:", installTime);
      return null;
    }
    return installTime;
  } catch (e) {
    console.warn("[useAppSync] Failed to get install time; skipping this sync attempt to avoid leaking pre-install history:", e);
    return null;
  }
}

export function useAppSync({ isReady, dbStatus }: UseAppSyncProps) {
  const [resumeTick, setResumeTick] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const isSyncingCallLogsRef = useRef(false);
  const isSyncingPhotosRef = useRef(false);
  const isFlushingRef = useRef(false);
  const pendingCountRef = useRef(0);

  // useAppInit이 순차 안내 중인 접근성/알림/배터리 특수 권한이 아직 안 끝났으면
  // 통화/SMS/사진의 표준 런타임 권한 다이얼로그를 지금 띄우지 않는다. 두 흐름이
  // 동시에 돌면 설정 화면 이동과 시스템 권한 다이얼로그가 뒤섞여 순서가 꼬인
  // 것처럼 보인다 (예: 알림 확인 → 전화 권한 → 다시 알림 → SMS 권한...).
  // 여기서 걸러도 10초 폴링이 있어 다음 주기에 자동으로 다시 시도된다.
  const arePrerequisitePermissionsResolved = useCallback(async (): Promise<boolean> => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return true;

      const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
      const status = await LifeCommitPlugin.checkSystemPermissions();
      return status.accessibility && status.notification && status.battery;
    } catch {
      return true; // 확인 자체가 실패하면 기존 동작(막지 않음)으로 폴백
    }
  }, []);

  // 미처리 이벤트 수 조회
  const checkPendingCount = useCallback(async () => {
    try {
      const { getDB } = await import("@/lib/db");
      const db = getDB();
      const res = await db.query("SELECT COUNT(*) as cnt FROM raw_events WHERE is_processed = 0");
      const count = res.values?.[0]?.cnt || 0;
      setPendingCount(count);
      pendingCountRef.current = count;
      return count;
    } catch {
      return 0;
    }
  }, []);

  // 1. 네이티브 백그라운드 버퍼 플러시
  const flushPendingNativeEvents = useCallback(async () => {
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;

      const AccessibilityPlugin = (await import("@/plugins/AccessibilityPlugin")).default;
      const { executeInTransaction } = await import("@/lib/db");

      const res = await AccessibilityPlugin.flushBufferedEvents();
      if (res && res.events) {
        const events = JSON.parse(res.events);
        if (Array.isArray(events) && events.length > 0) {
          console.log(`[useAppSync] Flushing ${events.length} pending native events to SQLite.`);
          const FLUSH_NOISE = NOISE_PACKAGES;

          // db.execute("BEGIN/COMMIT/ROLLBACK")를 직접 쓰지 않고 executeInTransaction의
          // dbLockChain을 거친다 -- 안 그러면 이 트랜잭션이 processor.ts의 executeInTransaction
          // 트랜잭션과 같은 커넥션 위에서 겹쳐서, 서로의 트랜잭션을 가로채 "Cannot perform
          // this operation because there is no current transaction" 에러로 전체 배치가
          // 실패하는 레이스가 발생한다 (실사용 중 발견됨: 오버나이트 백로그를 한 번에
          // 플러시할 때 재현됨).
          try {
            await executeInTransaction(async (d) => {
            for (const event of events) {
              const nativeType = event.eventType || "";
              if (
                nativeType !== "LOCATION" &&
                nativeType !== "REPLY" &&
                FLUSH_NOISE.has(event.packageName || "")
              ) {
                continue;
              }

              let mappedEventType: string;
              let rawData: string;

              if (nativeType === "LOCATION") {
                mappedEventType = "LOCATION";
                try {
                  const locObj = JSON.parse(event.extractedText);
                  rawData = JSON.stringify({
                    lat: locObj.lat,
                    lng: locObj.lng,
                    accuracy: locObj.accuracy,
                    activityType: locObj.activityType || "UNKNOWN",
                  });
                } catch {
                  rawData = event.extractedText;
                }
              } else if (nativeType === "REPLY") {
                mappedEventType = "REPLY";
                try {
                  const replyObj = JSON.parse(event.extractedText);
                  rawData = JSON.stringify({
                    sender: replyObj.sender,
                    receivedMsg: replyObj.receivedMsg,
                    replyMsg: replyObj.replyMsg,
                  });
                } catch {
                  rawData = event.extractedText;
                }
              } else {
                mappedEventType = "APP_USAGE";
                rawData = JSON.stringify({
                  text: event.extractedText,
                  desc: event.contentDescription,
                  label: event.appLabel,
                });
              }

              const dupCheck = await d.query(
                "SELECT id FROM raw_events WHERE event_type = ? AND started_at = ? AND app_package = ?",
                [mappedEventType, event.timestamp, event.packageName]
              );
              if (dupCheck.values && dupCheck.values.length > 0) continue;

              await d.run(
                "INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)",
                [mappedEventType, event.packageName, rawData, event.timestamp]
              );
            }
            });
            console.log("[useAppSync] Successfully flushed native events.");
            // SQLite 커밋이 확실히 성공한 뒤에만 네이티브 버퍼에서 이 이벤트들을
            // 제거한다. 커밋 실패 시 confirmFlush를 호출하지 않으면 다음 플러시
            // 주기에 동일 이벤트가 그대로 재시도되어 유실을 막는다. peek 시점의
            // upToSeq를 그대로 되돌려줘야 그 사이 네이티브 쪽에서 새로 추가된
            // 이벤트가 함께 지워지지 않는다.
            try {
              await AccessibilityPlugin.confirmFlush({ upToSeq: res.upToSeq });
            } catch (confirmErr) {
              console.error("[useAppSync] Failed to confirm native buffer flush:", confirmErr);
            }
          } catch (txErr) {
            // executeInTransaction이 실패 시 내부적으로 이미 rollback을 수행한다.
            console.error("[useAppSync] Transaction failed, rolled back:", txErr);
          }
        }
      }
    } catch (err) {
      console.error("[useAppSync] Failed to flush pending native events:", err);
    } finally {
      isFlushingRef.current = false;
    }
  }, []);

  // 2. 통화 및 SMS 동기화
  const syncCallLogsAndSms = useCallback(async () => {
    if (isSyncingCallLogsRef.current) return;
    isSyncingCallLogsRef.current = true;
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;
      if ((await getFlavor()) === "oss") return; // oss has no call/SMS/photo collectors
      if (!(await arePrerequisitePermissionsResolved())) return;

      const CallLogPlugin = (await import("@/plugins/CallLogPlugin")).default;
      const { getDB, executeInTransaction } = await import("@/lib/db");
      const db = getDB();

      const lastCallRes = await db.query(
        "SELECT MAX(started_at) as last_ts FROM raw_events WHERE event_type = 'CALL'"
      );
      const lastCallTs = await getSyncFloorTimestamp(lastCallRes.values?.[0]?.last_ts);

      const lastSmsRes = await db.query(
        "SELECT MAX(started_at) as last_ts FROM raw_events WHERE event_type = 'SMS'"
      );
      const lastSmsTs = await getSyncFloorTimestamp(lastSmsRes.values?.[0]?.last_ts);

      // 통화 기록 동기화
      let callPerm = await CallLogPlugin.hasCallLogPermission();
      if (!callPerm.granted) {
        try {
          const req = await CallLogPlugin.requestPermissions({ permissions: ["callLog"] });
          callPerm = { granted: req.callLog === "granted" };
        } catch (e) {
          console.warn("[useAppSync] Request callLog permission failed:", e);
        }
      }

      if (callPerm.granted && lastCallTs !== null) {
        const CALL_PAGE_LIMIT = 100;
        let offset = 0;
        // afterTimestamp 이후 전체 통화 기록을 페이지가 다 소진될 때까지 순회한다.
        // 페이지 개수 자체에는 상한을 두지 않는다 (더 많은 기록이 있는데 임의 개수의
        // 페이지만 가져오고 끝내면 그 뒤 기록이 영구히 누락된다). MAX_SYNC_PAGES는
        // 정상적인 데이터량에서는 절대 도달하지 않는, 진짜 무한루프만 막기 위한
        // 안전장치이며, 도달 시 남은 데이터가 있을 수 있음을 경고 로그로 남긴다.
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const callLogs = await CallLogPlugin.getCallLogs({ afterTimestamp: lastCallTs, limit: CALL_PAGE_LIMIT, offset });
          // duplicate check + insert in one serialized transaction (the read decides the write)
          await executeInTransaction(async (d) => {
            for (const call of callLogs.calls) {
              const dupCheck = await d.query(
                "SELECT id FROM raw_events WHERE event_type = 'CALL' AND started_at = ? AND raw_data LIKE ?",
                [call.timestamp, `%${call.phoneNumber}%`]
              );
              if (dupCheck.values && dupCheck.values.length > 0) continue;

              const rawData = JSON.stringify({
                phoneNumber: call.phoneNumber,
                contactName: call.contactName,
                callType: call.callType,
                durationSec: call.durationSec,
              });

              await d.run(
                "INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)",
                ["CALL", "com.android.dialer", rawData, call.timestamp],
                false
              );
            }
          });
          if (callLogs.calls.length < CALL_PAGE_LIMIT) break;
          offset += CALL_PAGE_LIMIT;
          if (page === MAX_SYNC_PAGES - 1) {
            console.warn(`[useAppSync] CALL sync hit the ${MAX_SYNC_PAGES}-page safety cap; older records may remain unsynced this cycle.`);
          }
        }
      }

      // SMS 기록 동기화
      let smsPerm = await CallLogPlugin.hasSmsPermission();
      if (!smsPerm.granted) {
        try {
          const req = await CallLogPlugin.requestPermissions({ permissions: ["sms"] });
          smsPerm = { granted: req.sms === "granted" };
        } catch (e) {
          console.warn("[useAppSync] Request sms permission failed:", e);
        }
      }

      if (smsPerm.granted && lastSmsTs !== null) {
        const SMS_PAGE_LIMIT = 100;
        let smsOffset = 0;
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const smsData = await CallLogPlugin.getSms({ afterTimestamp: lastSmsTs, limit: SMS_PAGE_LIMIT, offset: smsOffset });
          // duplicate check + insert in one serialized transaction (the read decides the write)
          await executeInTransaction(async (d) => {
            for (const msg of smsData.messages) {
              const dupCheck = await d.query(
                "SELECT id FROM raw_events WHERE event_type = 'SMS' AND started_at = ? AND raw_data LIKE ?",
                [msg.timestamp, `%${msg.body.substring(0, 10)}%`]
              );
              if (dupCheck.values && dupCheck.values.length > 0) continue;

              const rawData = JSON.stringify({
                phoneNumber: msg.address,
                contactName: msg.contactName,
                callType: msg.type === "INBOX" ? "INCOMING" : "OUTGOING",
                body: msg.body,
              });

              await d.run(
                "INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)",
                ["SMS", "com.android.mms", rawData, msg.timestamp],
                false
              );
            }
          });
          if (smsData.messages.length < SMS_PAGE_LIMIT) break;
          smsOffset += SMS_PAGE_LIMIT;
          if (page === MAX_SYNC_PAGES - 1) {
            console.warn(`[useAppSync] SMS sync hit the ${MAX_SYNC_PAGES}-page safety cap; older records may remain unsynced this cycle.`);
          }
        }
      }
    } catch (err) {
      console.error("[useAppSync] CallLog & SMS sync failed:", err);
    } finally {
      isSyncingCallLogsRef.current = false;
    }
  }, [arePrerequisitePermissionsResolved]);

  // 3. 사진 동기화
  const syncPhotos = useCallback(async () => {
    if (isSyncingPhotosRef.current) return;
    isSyncingPhotosRef.current = true;
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (!Capacitor.isNativePlatform()) return;
      if ((await getFlavor()) === "oss") return; // oss has no call/SMS/photo collectors
      if (!(await arePrerequisitePermissionsResolved())) return;

      const PhotoPlugin = (await import("@/plugins/PhotoPlugin")).default;
      const { getDB, executeInTransaction } = await import("@/lib/db");
      const db = getDB();

      const lastPhotoRes = await db.query(
        "SELECT MAX(started_at) as last_ts FROM raw_events WHERE event_type = 'PHOTO'"
      );
      const lastPhotoTs = await getSyncFloorTimestamp(lastPhotoRes.values?.[0]?.last_ts);

      let photoPerm = await PhotoPlugin.hasPhotoPermission();
      if (!photoPerm.granted) {
        try {
          await PhotoPlugin.getRecentPhotos({ limit: 1 });
          photoPerm = await PhotoPlugin.hasPhotoPermission();
        } catch (e) {
          console.warn("[useAppSync] Request photo permission failed:", e);
        }
      }

      if (photoPerm.granted && lastPhotoTs !== null) {
        const PHOTO_PAGE_LIMIT = 50;
        let photoOffset = 0;
        for (let page = 0; page < MAX_SYNC_PAGES; page++) {
          const photoData = await PhotoPlugin.getRecentPhotos({ afterTimestamp: lastPhotoTs, limit: PHOTO_PAGE_LIMIT, offset: photoOffset });
          // duplicate check + insert in one serialized transaction (the read decides the write)
          await executeInTransaction(async (d) => {
            for (const photo of photoData.photos) {
              const dupCheck = await d.query(
                "SELECT id FROM raw_events WHERE event_type = 'PHOTO' AND started_at = ? AND raw_data LIKE ?",
                [photo.timestamp, `%${photo.fileName}%`]
              );
              if (dupCheck.values && dupCheck.values.length > 0) continue;

              const rawData = JSON.stringify({
                photoUri: photo.photoUri,
                fileName: photo.fileName,
              });

              await d.run(
                "INSERT INTO raw_events (event_type, app_package, raw_data, started_at) VALUES (?, ?, ?, ?)",
                ["PHOTO", "com.android.camera2", rawData, photo.timestamp],
                false
              );
            }
          });
          if (photoData.photos.length < PHOTO_PAGE_LIMIT) break;
          photoOffset += PHOTO_PAGE_LIMIT;
          if (page === MAX_SYNC_PAGES - 1) {
            console.warn(`[useAppSync] PHOTO sync hit the ${MAX_SYNC_PAGES}-page safety cap; older records may remain unsynced this cycle.`);
          }
        }
      }
    } catch (err) {
      console.error("[useAppSync] Photos sync failed:", err);
    } finally {
      isSyncingPhotosRef.current = false;
    }
  }, [arePrerequisitePermissionsResolved]);

  const lastHeavySyncTsRef = useRef(0);

  // 일괄 동기화 및 프로세싱 실행
  const runSyncAndProcessCycle = useCallback(async (forceHeavySync: boolean = false) => {
    try {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.getPlatform() === "web") return;

      // 1. 네이티브 접근성 이벤트 버퍼 플러시 (초경량 1~2ms)
      await flushPendingNativeEvents();

      // 2. 무거운 시스템 DB 동기화(통화/SMS/사진)는 앱 복귀(Resume) 시 또는 60초 주기로만 실행
      const now = Date.now();
      if (forceHeavySync || now - lastHeavySyncTsRef.current > 60000) {
        lastHeavySyncTsRef.current = now;
        await syncCallLogsAndSms();
        await syncPhotos();
        await syncUsageSessions().catch((e) => console.warn("[useAppSync] usage sync failed:", e));
      }

      // 현재 대기 중인 이벤트 수 확인
      const currentPending = await checkPendingCount();
      if (currentPending > 0) {
        setIsSyncing(true);
      }

      // 3. raw_events 를 commits 로 변환 (대기 이벤트가 모두 소진될 때까지 연속 배치 실행)
      const { processRawEventsBatch } = await import("@/lib/processor");
      const { cleanupDuplicateCommits } = await import("@/lib/commitManager");

      let totalProcessed = 0;
      let loopCount = 0;

      while (loopCount < 20) {
        loopCount++;
        const processed = await processRawEventsBatch().catch((e) => {
          console.error("[useAppSync] processRawEventsBatch error:", e);
          return 0;
        });
        if (processed === 0) break;
        totalProcessed += processed;
      }

      // 4. 새로운 커밋이 실제로 만들어졌을 때만 고속 중복 정리 실행
      if (totalProcessed > 0) {
        await cleanupDuplicateCommits().catch(() => {});
        console.log(`[useAppSync] Processed total ${totalProcessed} events into Commits across ${loopCount} batches.`);
        emit(EVENT_COMMITS_UPDATED);
        setResumeTick((prev) => prev + 1);
      }
    } catch (err) {
      console.error("[useAppSync] Sync & process cycle error:", err);
    } finally {
      setIsSyncing(false);
      await checkPendingCount();
    }
  }, [flushPendingNativeEvents, syncCallLogsAndSms, syncPhotos, checkPendingCount]);

  // 백그라운드 10초 주기 폴링 (대기 큐가 남아있을 때는 화면 꺼짐 상태여도 끝까지 실행)
  useEffect(() => {
    if (!isReady || dbStatus !== "ready") return;

    let isPolling = false;

    const tick = async () => {
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.getPlatform() === "web") return;

      // 대기 이벤트가 0건이고 화면이 꺼져있을 때만 절전(Sleep) 유지
      if (document.visibilityState !== "visible" && pendingCountRef.current === 0 && !isSyncing) {
        return;
      }

      if (isPolling) return;

      isPolling = true;
      try {
        await runSyncAndProcessCycle(false);
      } finally {
        isPolling = false;
      }
    };

    const interval = setInterval(tick, 10000);
    tick(); // 초기 1회 실행

    return () => clearInterval(interval);
  }, [isReady, dbStatus, runSyncAndProcessCycle, isSyncing]);

  // 앱 Resume(포그라운드 복귀) 리스너 등록
  useEffect(() => {
    if (!isReady || dbStatus !== "ready") return;

    let listener: any;
    const setupResumeListener = async () => {
      try {
        const { Capacitor } = await import("@capacitor/core");
        if (!Capacitor.isNativePlatform()) return;

        const { App: CapApp } = await import("@capacitor/app");
        listener = await CapApp.addListener("resume", async () => {
          console.log("[useAppSync] App resumed from background. Running sync.");
          await runSyncAndProcessCycle();
          setResumeTick((prev) => prev + 1);
        });
      } catch (e) {
        console.warn("[useAppSync] Resume listener setup failed:", e);
      }
    };

    setupResumeListener();

    return () => {
      if (listener) listener.remove();
    };
  }, [isReady, dbStatus, runSyncAndProcessCycle]);

  return {
    resumeTick,
    isSyncing,
    pendingCount,
    triggerManualSync: () => runSyncAndProcessCycle(true),
  };
}
