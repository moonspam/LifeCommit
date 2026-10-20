"use client";

import { useState, useEffect, useCallback } from "react";
import { DEFAULT_NOISE_FILTERS_TEXT, NOISE_PACKAGES, mapNativeEventType } from "@/lib/constants";
import { writeFilterText } from "@/lib/filters";
import { applyFilterSave, loadFilterSetting } from "@/lib/settings";

/** localStorage is only a mirror of the DB setting (used to seed after a DB wipe); a failed mirror write is harmless. */
const mirrorFilters = (text: string) => { try { writeFilterText(localStorage, text); } catch (e) { console.warn("[useAppInit] filter mirror write failed:", e); } };

export type DbStatus = "initializing" | "ready" | "error";

export function useAppInit() {
  const [isReady, setIsReady] = useState(false);
  const [dbStatus, setDbStatus] = useState<DbStatus>("initializing");
  const [dbError, setDbError] = useState<string | null>(null);
  const [customFiltersText, setCustomFiltersText] = useState("");


  const saveFilters = useCallback(async (newFiltersText: string) => {
    try {
      const customPkgs = newFiltersText
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"));

      // [옵션 B] 등록된 노이즈 패키지의 기존 과거 커밋 및 원시 이벤트 일괄 영구 삭제 + 필터 텍스트 저장을
      // 한 직렬화 구간에서: 수집(drain)이 그 사이에 옛 필터로 제외 앱을 다시 넣을 수 없다.
      // mass delete + new filter text in ONE SQLite transaction (the filter lives in app_settings): all or nothing
      const { executeInTransaction } = await import("@/lib/db");
      const { commits: deletedCommitsCount, events: deletedEventsCount } = await executeInTransaction(
        (d) => applyFilterSave(d, newFiltersText), { requireTransaction: true });
      mirrorFilters(newFiltersText);
      setCustomFiltersText(newFiltersText);

      // the DB is already committed: a failure to push the native (accessibility) cache is reported separately and is
      // re-applied from the DB on the next app start (bootstrap pushes the DB value)
      const { Capacitor } = await import("@capacitor/core");
      if (Capacitor.isNativePlatform()) {
        try {
          const AccessibilityPlugin = (await import("@/plugins/AccessibilityPlugin")).default;
          await AccessibilityPlugin.updateNoiseFilters({ packages: customPkgs });
        } catch (e) {
          console.warn("[useAppInit] native filter update failed after save:", e);
          alert("✓ 노이즈 필터는 저장됐습니다.\n다만 실시간 접근성 필터 적용에 실패해, 앱을 다시 시작할 때 적용됩니다.");
          window.location.reload();
          return;
        }
      }

      if (deletedCommitsCount > 0 || deletedEventsCount > 0) {
        alert(
          `✓ 노이즈 필터 저장 완료!\n등록된 앱의 기존 커밋 ${deletedCommitsCount}개 및 이벤트 ${deletedEventsCount}개를 정리했습니다.\n(필터를 유지하는 동안 제외되며, 필터에서 빼면 시스템에 남아 있는 기간의 기록은 다시 수집될 수 있습니다.)`
        );
      } else {
        alert("✓ 노이즈 필터가 성공적으로 저장 및 적용되었습니다.");
      }

      window.location.reload();
    } catch (e: any) {
      console.error("[useAppInit] Failed to save filters:", e);
      alert("필터 저장 중 오류 발생: " + (e?.message || e));
    }
  }, []);

  // 접근성/알림/배터리/통화/SMS/사진 권한 안내는 이제 <PermissionOnboarding>
  // 화면(components/Common/PermissionOnboarding.tsx)이 전담한다. 여기서 alert()
  // 기반으로 동시에 안내하면 온보딩 화면의 버튼 클릭과 겹쳐 순서가 다시 꼬인다.

  useEffect(() => {
    let isCancelled = false;

    async function bootstrap() {
      try {
        const { Capacitor } = await import("@capacitor/core");
        const { initDB, executeInTransaction } = await import("@/lib/db");

        // 1. SQLite DB 초기화
        await initDB();

        // 1b. 노이즈 필터: DB(app_settings)가 원본. 없으면 localStorage 사본(또는 기본값)으로 채운다.
        const savedFilters = await executeInTransaction(
          (d) => loadFilterSetting(d, localStorage, DEFAULT_NOISE_FILTERS_TEXT), { requireTransaction: true });
        mirrorFilters(savedFilters);
        setCustomFiltersText(savedFilters);

        // 2. 네이티브 환경 전용 권한 확인 및 리스너 등록
        // (위치/접근성/알림/배터리/통화/SMS/사진 권한 요청은 이제 전부
        //  <PermissionOnboarding> 화면에서 사용자가 직접 눌러서 진행한다.
        //  여기서 자동으로 쏘면 온보딩 화면을 보기도 전에 다이얼로그가 떠서
        //  순서가 다시 꼬인다.)
        if (Capacitor.isNativePlatform()) {
          // 노이즈 필터 세팅 (네이티브 접근성 필터는 DB 값에서 파생된 캐시)
          const AccessibilityPlugin = (await import("@/plugins/AccessibilityPlugin")).default;
          const JS_NOISE = new Set(NOISE_PACKAGES);
          const customPkgs = savedFilters
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
          customPkgs.forEach((pkg) => JS_NOISE.add(pkg));

          try {
            await AccessibilityPlugin.updateNoiseFilters({ packages: customPkgs });
          } catch (e) {
            console.warn("[useAppInit] updateNoiseFilters not supported or failed:", e);
          }

          // 접근성 실시간 이벤트 리스너 등록
          let lastContentPkg = "";
          let lastContentTime = 0;

          await AccessibilityPlugin.addListener("accessibilityEvent", async (event) => {
            try {
              const pkg = event.packageName || "";
              const nativeType = event.eventType || "";

              // 노이즈 필터 (LOCATION, REPLY 제외)
              if (
                nativeType !== "LOCATION" &&
                nativeType !== "REPLY" &&
                JS_NOISE.has(pkg)
              ) {
                return;
              }

              // WINDOW_CONTENT_CHANGED 쓰로틀링 (동일 앱 500ms 이내 무시)
              if (nativeType === "WINDOW_CONTENT_CHANGED") {
                const now = Date.now();
                if (pkg === lastContentPkg && now - lastContentTime < 500) return;
                lastContentPkg = pkg;
                lastContentTime = now;
              }

              const mappedType = mapNativeEventType(nativeType);
              let rawData: string;

              if (nativeType === "LOCATION") {
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
                rawData = JSON.stringify({
                  text: event.extractedText,
                  desc: event.contentDescription,
                  label: event.appLabel,
                });
              }

              await executeInTransaction((d) => d.run(
                `INSERT INTO raw_events (event_type, app_package, raw_data, started_at)
                 VALUES (?, ?, ?, ?)`,
                [mappedType, pkg, rawData, event.timestamp],
                false
              ));
            } catch (err) {
              console.error("[useAppInit] Failed to save raw event:", err);
            }
          });

        }

        if (!isCancelled) {
          setDbStatus("ready");
          setIsReady(true);
        }
      } catch (err: any) {
        if (err === "WEB_MODE_SKIP_DB") {
          console.log("[useAppInit] Web mode detected. DB init skipped.");
          if (!isCancelled) {
            setDbStatus("ready");
            setIsReady(true);
          }
        } else {
          console.error("[useAppInit] DB init failed:", err);
          if (!isCancelled) {
            setDbStatus("error");
            setDbError(err?.message || String(err));
            setIsReady(true);
          }
        }
      }
    }

    bootstrap();

    return () => {
      isCancelled = true;
    };
  }, []);

  return {
    isReady,
    dbStatus,
    dbError,
    setDbStatus,
    customFiltersText,
    setCustomFiltersText,
    saveFilters,
  };
}
