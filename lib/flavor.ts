export type Flavor = "full" | "oss";

let cached: Flavor | null = null;

/** Android build flavor. Web/dev (no native shell) behaves like "full". */
export async function getFlavor(): Promise<Flavor> {
  if (cached) return cached;
  try {
    const { Capacitor } = await import("@capacitor/core");
    if (!Capacitor.isNativePlatform()) return "full";
    const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
    cached = (await LifeCommitPlugin.checkSystemPermissions()).flavor === "oss" ? "oss" : "full";
    return cached;
  } catch {
    return "full";
  }
}

/** 테스트용: 캐시된 flavor를 강제 설정 (null 전달 시 초기화) */
export function setFlavorForTest(flavor: Flavor | null) {
  cached = flavor;
}
