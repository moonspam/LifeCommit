"use client";

import { useCallback, useEffect, useState } from "react";

interface PermissionItem {
  key: string;
  label: string;
  desc: string;
  granted: boolean;
  action: () => Promise<void>;
  /** builds this item applies to */
  flavors: ("full" | "oss")[];
  /** shown, but not required to start */
  optional?: boolean;
}

type PermissionStatus = {
  accessibility: boolean;
  notification: boolean;
  battery: boolean;
  location: boolean;
  callLog: boolean;
  sms: boolean;
  photo: boolean;
  usage: boolean;
  locationAlways: boolean;
  contacts: boolean;
};

const ALL_GRANTED: PermissionStatus = {
  accessibility: true,
  notification: true,
  battery: true,
  location: true,
  callLog: true,
  sms: true,
  photo: true,
  usage: true,
  locationAlways: true,
  contacts: true,
};

const ITEM_KEYS: Record<"full" | "oss", (keyof PermissionStatus)[]> = {
  full: ["usage", "accessibility", "notification", "battery", "location", "callLog", "sms", "photo"],
  oss: ["usage"],
};

/**
 * 최초 실행 시(또는 필수 권한이 누락된 동안) 메인 화면 대신 보여주는 권한
 * 안내 페이지. alert()+설정화면 이동을 여러 훅이 각자 순서 없이 실행하면
 * 팝업이 뒤섞이고, 시스템 다이얼로그가 안 보이는 경우 사용자가 막힌 이유를
 * 알 수 없다 -- 대신 이 화면 하나에서 상태를 눈으로 보여주고, 사용자가 직접
 * 원하는 항목을 눌러 진행하게 한다.
 */
export default function PermissionOnboarding({ onAllGranted }: { onAllGranted: () => void }) {
  const [status, setStatus] = useState<PermissionStatus>(ALL_GRANTED);
  const [checked, setChecked] = useState(false);
  const [flavor, setFlavor] = useState<"full" | "oss">("full");

  const refresh = useCallback(async () => {
    try {
      const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
      const { default: CallLogPlugin } = await import("@/plugins/CallLogPlugin");
      const { default: PhotoPlugin } = await import("@/plugins/PhotoPlugin");

      const sys = await LifeCommitPlugin.checkSystemPermissions();
      const isOss = sys.flavor === "oss";
      setFlavor(isOss ? "oss" : "full");

      // oss declares none of the call/SMS/photo permissions; don't even query them
      const none = { granted: false };
      const [callLog, sms, photo] = isOss
        ? [none, none, none]
        : await Promise.all([
            CallLogPlugin.hasCallLogPermission().catch(() => none),
            CallLogPlugin.hasSmsPermission().catch(() => none),
            PhotoPlugin.hasPhotoPermission().catch(() => none),
          ]);

      const next: PermissionStatus = {
        accessibility: sys.accessibility,
        notification: sys.notification,
        battery: sys.battery,
        location: sys.location,
        callLog: callLog.granted,
        sms: sms.granted,
        photo: photo.granted,
        usage: sys.usage,
        locationAlways: sys.locationAlways,
        contacts: sys.contacts,
      };
      setStatus(next);
      setChecked(true);

      const required = ITEM_KEYS[isOss ? "oss" : "full"];
      if (required.every((k) => next[k])) {
        onAllGranted();
      }
    } catch (e) {
      console.warn("[PermissionOnboarding] status check failed:", e);
      setChecked(true);
    }
  }, [onAllGranted]);

  useEffect(() => {
    refresh();

    let listener: any;
    (async () => {
      try {
        const { App: CapApp } = await import("@capacitor/app");
        listener = await CapApp.addListener("resume", refresh);
      } catch (e) {
        console.warn("[PermissionOnboarding] resume listener failed:", e);
      }
    })();

    return () => {
      if (listener) listener.remove();
    };
  }, [refresh]);

  const openSetting = useCallback(async (type: "accessibility" | "notification" | "battery" | "usage" | "app_info") => {
    const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
    await LifeCommitPlugin.openSystemSetting({ type });
  }, []);

  const items: PermissionItem[] = ([
    {
      key: "usage",
      label: "사용 정보 접근",
      desc: "어떤 앱이 언제 앞에 있었는지만 기록합니다. 화면 내용, 입력 텍스트, 메시지는 읽지 않습니다. 직장 프로필·보안 폴더 앱은 수집되지 않습니다.",
      granted: status.usage,
      action: () => openSetting("usage"),
      flavors: ["oss", "full"],
    },
    {
      key: "accessibility",
      label: "접근성 서비스",
      desc: "메신저 답장 기록과 위치 기록에 필요합니다. 앱 사용 시간은 사용 정보 접근으로 기록합니다.",
      granted: status.accessibility,
      flavors: ["full"],
      action: () => openSetting("accessibility"),
    },
    {
      key: "notification",
      label: "알림 접근 허용",
      desc: "받은 알림을 로그로 남기고 답장을 매칭하는 데 필요합니다.",
      granted: status.notification,
      flavors: ["full"],
      action: () => openSetting("notification"),
    },
    {
      key: "battery",
      label: "배터리 최적화 제외",
      desc: "화면이 꺼져도 기록이 끊기지 않게 합니다.",
      granted: status.battery,
      flavors: ["full"],
      action: () => openSetting("battery"),
    },
    {
      key: "location",
      label: "위치 권한",
      desc: "어디서 있었는지 커밋에 남기는 데 필요합니다.",
      granted: status.location,
      flavors: ["full"],
      action: async () => {
        const { Geolocation } = await import("@capacitor/geolocation");
        await Geolocation.requestPermissions();
        await refresh();
      },
    },
    {
      key: "locationAlways",
      label: "위치 항상 허용 (선택)",
      desc: "앱을 닫아 둔 동안에도 위치를 기록합니다. Android 정책상 권한 창에서는 고를 수 없어서, 설정 → 권한 → 위치에서 '항상 허용'을 직접 골라야 합니다.",
      granted: status.locationAlways,
      flavors: ["full"],
      optional: true,
      action: () => openSetting("app_info"),
    },
    {
      key: "callLog",
      label: "통화 기록",
      desc: "통화 내역을 커밋으로 남기는 데 필요합니다.",
      granted: status.callLog,
      flavors: ["full"],
      action: async () => {
        const { default: CallLogPlugin } = await import("@/plugins/CallLogPlugin");
        await CallLogPlugin.requestPermissions({ permissions: ["callLog"] });
        await refresh();
      },
    },
    {
      key: "sms",
      label: "문자 메시지",
      desc: "문자 내역을 커밋으로 남기는 데 필요합니다.",
      granted: status.sms,
      flavors: ["full"],
      action: async () => {
        const { default: CallLogPlugin } = await import("@/plugins/CallLogPlugin");
        await CallLogPlugin.requestPermissions({ permissions: ["sms"] });
        await refresh();
      },
    },
    {
      key: "photo",
      label: "사진",
      desc: "촬영/저장한 사진을 커밋으로 남기는 데 필요합니다.",
      granted: status.photo,
      flavors: ["full"],
      action: async () => {
        const { default: PhotoPlugin } = await import("@/plugins/PhotoPlugin");
        await PhotoPlugin.getRecentPhotos({ limit: 1 });
        await refresh();
      },
    },
    {
      key: "contacts",
      label: "연락처 (선택)",
      desc: "통화·문자 기록에 번호 대신 이름을 표시합니다.",
      granted: status.contacts,
      flavors: ["full"],
      optional: true,
      action: async () => {
        const { default: CallLogPlugin } = await import("@/plugins/CallLogPlugin");
        await CallLogPlugin.requestPermissions({ permissions: ["contacts"] });
        await refresh();
      },
    },
  ] as PermissionItem[]).filter((i) => i.flavors.includes(flavor));

  const remaining = items.filter((i) => !i.granted && !i.optional).length;

  // 최초 확인이 끝나기 전(checked=false)이나, 확인 결과 이미 전부 허용된 상태라면
  // 화면을 아예 그리지 않는다 -- 안 그러면 "확인 중..." 문구가 한 프레임 잠깐
  // 나타났다 사라지는 깜빡임이 생긴다.
  if (!checked || remaining === 0) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-terminal-bg text-terminal-white font-mono p-4">
      <div className="w-full max-w-md border border-terminal-border rounded-lg bg-terminal-surface p-6">
        <h1 className="text-lg font-bold mb-1">LifeCommit 시작 전 권한 설정</h1>
        <p className="text-sm text-terminal-gray mb-4">
          {checked
            ? remaining > 0
              ? `${remaining}개 권한이 더 필요해요. 항목을 눌러 하나씩 진행해주세요.`
              : "모든 권한이 확인됐어요. 곧 시작합니다..."
            : "권한 상태 확인 중..."}
        </p>

        <ul className="space-y-2 mb-4">
          {items.map((item) => (
            <li
              key={item.key}
              className={`flex items-start justify-between gap-3 rounded border px-3 py-2 ${
                item.granted ? "border-terminal-green/40 bg-terminal-green/5" : "border-terminal-border"
              }`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span>{item.granted ? "✅" : "⬜"}</span>
                  <span className="font-semibold">{item.label}</span>
                </div>
                <p className="text-xs text-terminal-gray mt-0.5">{item.desc}</p>
              </div>
              {!item.granted && (
                <button
                  onClick={item.action}
                  className="shrink-0 text-xs px-3 py-1.5 rounded bg-terminal-green/20 hover:bg-terminal-green/30 text-terminal-green border border-terminal-green/40 transition-colors"
                >
                  설정
                </button>
              )}
            </li>
          ))}
        </ul>

        <button
          onClick={refresh}
          className="w-full text-xs py-2 rounded border border-terminal-border hover:bg-terminal-border/30 transition-colors text-terminal-gray"
        >
          새로고침
        </button>
      </div>
    </div>
  );
}
