/**
 * LifeCommit 전역 상수 모듈
 *
 * 노이즈 패키지 목록, 이벤트 타입 매핑 등 여러 파일에서 공통으로 사용하는 상수를
 * 한 곳에서 관리하여 불일치를 방지합니다.
 */

// ─────────────────────────────────────────────────
// [1] 노이즈 패키지 (.gitignore 역할)
//     접근성 서비스, 버퍼 플러시, 프로세서에서 공통 참조
// ─────────────────────────────────────────────────
export const NOISE_PACKAGES = new Set([
  // ── 기본 시스템 ──
  "",
  "android",
  "com.lifecommit.app",
  "com.lifecommit.app.full", // the full build (LifeCommit+) has its own app id
  "com.android.systemui",
  "com.android.launcher",
  "com.android.launcher3",
  "com.samsung.knox.securefolder", // Secure Folder switcher: 1s foreground blips, not real usage
  "com.android.intentresolver", // the system share sheet: a few seconds per share, not app use

  // ── 키보드 ──
  "com.android.inputmethod.latin",
  "com.google.android.inputmethod.latin",
  "com.samsung.android.honeyboard",

  // ── 런처 (각 제조사별) ──
  "com.google.android.apps.nexuslauncher",
  "com.sec.android.app.launcher",
  "com.miui.home",
  "com.huawei.android.launcher",
  "com.oneplus.launcher",

  // ── 삼성 시스템 서비스 ──
  "com.samsung.android.incallui",
  "com.samsung.android.spay",
  "com.samsung.android.biometrics.app.setting",
  "com.samsung.android.authframework",
  "com.samsung.android.app.aodservice",
  "com.samsung.android.sidegesturepad",
  "com.samsung.android.app.cocktailbarservice",
  "com.samsung.android.app.smartcapture",
  "com.samsung.android.themestore",
  "com.samsung.android.lool",
  "com.samsung.android.app.routines",
  "com.samsung.android.samsungpass",
  "com.samsung.android.forest",
  "com.samsung.android.goodlock",
  "com.samsung.android.app.dressroom",
  "com.samsung.android.wallpaper.res",
  "com.samsung.android.da.daagent",
  "com.samsung.android.fmm",
  "com.samsung.android.net.wifi.wifiguider",
  "com.samsung.android.mobileservice",
  "com.samsung.android.app.notes",
  "com.samsung.android.voc",
  "com.sec.android.daemonapp",

  // ── 안드로이드 프레임워크 / 공통 시스템 ──
  "com.android.providers.media",
  "com.android.providers.downloads",
  "com.android.providers.contacts",
  "com.android.providers.calendar",
  "com.android.server.telecom",
  "com.android.phone",
  "com.android.nfc",
  "com.android.bluetooth",
  "com.android.printspooler",
  "com.android.documentsui",
  "com.android.permissioncontroller",
  "com.android.packageinstaller",
  "com.android.shell",
  "com.android.vending",
  "com.google.android.gms",
  "com.google.android.gsf",
  "com.google.android.ext.services",
  "com.google.android.packageinstaller",

  // ── 알림바 / 상태바 관련 ──
  "com.samsung.android.app.galaxyfinder",
  "com.samsung.android.notilus",
]);

// ─────────────────────────────────────────────────
// [2] 네이티브 이벤트 타입 → 프로세서 이벤트 타입 매핑
//     실시간 리스너와 버퍼 플러시에서 공통 참조
// ─────────────────────────────────────────────────

/** 네이티브 접근성 이벤트 타입을 프로세서가 인식하는 타입으로 변환합니다. */
export function mapNativeEventType(nativeType: string): string {
  switch (nativeType) {
    case "LOCATION":
    case "REPLY":
      return nativeType; // 그대로 유지
    default:
      // WINDOW_STATE_CHANGED, WINDOW_CONTENT_CHANGED, VIEW_SCROLLED 등
      return "APP_USAGE";
  }
}

// ─────────────────────────────────────────────────
// [3] 사용자 설정 기본 필터 목록 (노이즈 필터 UI 초기값)
// ─────────────────────────────────────────────────
export const DEFAULT_NOISE_FILTERS_TEXT = [
  "# --- 기본 시스템 ---",
  "android", "com.lifecommit.app", "com.lifecommit.app.full", "com.android.systemui",
  "com.android.launcher", "com.android.launcher3",
  "\n# --- 키보드 ---",
  "com.android.inputmethod.latin", "com.google.android.inputmethod.latin",
  "com.samsung.android.honeyboard",
  "\n# --- 런처 ---",
  "com.google.android.apps.nexuslauncher", "com.sec.android.app.launcher",
  "com.miui.home", "com.huawei.android.launcher", "com.oneplus.launcher",
  "\n# --- 삼성 시스템 / 보안 / 생체인증 ---",
  "com.samsung.android.biometrics.app.setting",
  "com.samsung.android.authframework",
  "com.samsung.android.incallui", "com.samsung.android.spay",
  "com.samsung.android.app.aodservice", "com.samsung.android.sidegesturepad",
  "com.samsung.android.app.cocktailbarservice", "com.samsung.android.app.smartcapture",
  "com.samsung.android.themestore", "com.samsung.android.goodlock",
  "com.samsung.android.app.dressroom", "com.samsung.android.wallpaper.res",
  "com.samsung.android.lool", "com.samsung.android.app.routines",
  "com.samsung.android.samsungpass", "com.samsung.android.forest",
  "com.samsung.android.da.daagent", "com.samsung.android.fmm",
  "com.samsung.android.net.wifi.wifiguider", "com.samsung.android.mobileservice",
  "com.samsung.android.voc", "com.sec.android.daemonapp",
  "com.samsung.android.notilus", "com.samsung.android.app.galaxyfinder",
  "\n# --- 안드로이드 프레임워크 / 서비스 ---",
  "com.android.providers.media", "com.android.providers.downloads",
  "com.android.providers.contacts", "com.android.providers.calendar",
  "com.android.server.telecom", "com.android.phone", "com.android.nfc",
  "com.android.bluetooth", "com.android.printspooler", "com.android.documentsui",
  "com.android.permissioncontroller", "com.android.packageinstaller", "com.android.shell",
  "com.android.vending", "com.google.android.gms", "com.google.android.gsf",
  "com.google.android.ext.services", "com.google.android.packageinstaller",
].join("\n");
