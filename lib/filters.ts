import { NOISE_PACKAGES } from "./constants";

/** Saved noise-filter text helpers. The saved text is the ONE effective filter: oss collection and "save deletes history" both use it. */
export const filterLines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

/**
 * Navigation/vehicle packages that used to ship in the default filter text. For UsageStats they are real foreground use;
 * the full build's accessibility service still drops them natively (LifeCommitAccessibilityService.NOISE_PACKAGES).
 */
export const RETIRED_DEFAULT_PACKAGES = [
  "com.google.android.projection.gearhead", "com.skt.tmap.ku", "com.locnall.KimGiSa", "com.nhn.android.nmap", "com.google.android.apps.maps",
];
const RETIRED_HEADER = "# --- 네비게이션 / 차량 (백그라운드 지속 실행 노이즈) ---";
/** Current-format filter text. One key = one setItem, so a write is all-or-nothing (no half-written state). */
export const FILTERS_STORAGE_KEY = "lifecommit_filters_v3";
/** Written by older builds: text (+ a marker set once the retired defaults were removed). Read once, never written. */
export const LEGACY_FILTERS_KEY = "lifecommit_custom_filters";
export const LEGACY_MIGRATION_KEY = "lifecommit_filters_migrated_v2";

export interface KV { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The only way to store filter text. No try/catch: callers see failures. */
export function writeFilterText(storage: KV, text: string) {
  storage.setItem(FILTERS_STORAGE_KEY, text);
}

/** Load (and initialise/upgrade) the filter text: current key, else legacy text (cleaned if it predates the cleanup), else defaults; then merge newly added defaults. */
export function loadFilterText(storage: KV, defaults: string): string {
  const stored = storage.getItem(FILTERS_STORAGE_KEY); // "" is a real (cleared) value: the merge below refills it
  let saved: string;
  let changed = false;
  if (stored == null) {
    const legacy = storage.getItem(LEGACY_FILTERS_KEY);
    saved = legacy ? (storage.getItem(LEGACY_MIGRATION_KEY) ? legacy : removeRetiredDefaults(legacy)) : defaults;
    changed = true;
  } else {
    saved = stored;
  }
  const current = new Set(filterLines(saved));
  const missing = filterLines(defaults).filter((pkg) => !current.has(pkg));
  if (missing.length > 0) {
    saved = saved.trimEnd() + "\n\n# --- 신규 시스템 추천 필터 자동 보강 ---\n" + missing.join("\n");
    changed = true;
  }
  if (changed) writeFilterText(storage, saved);
  return saved;
}
/** One-time cleanup of saved text written from the old defaults: drops exactly the retired packages and their header. */
export function removeRetiredDefaults(saved: string): string {
  const retired = new Set([...RETIRED_DEFAULT_PACKAGES, RETIRED_HEADER]);
  return saved.split("\n").filter((l) => !retired.has(l.trim())).join("\n");
}

/** Built-in noise list + every line of the saved filter text (the same set "save filters" deletes history for). */
export function noisePackages(saved: string | null): Set<string> {
  return new Set([...NOISE_PACKAGES, ...filterLines(saved ?? "")]);
}
