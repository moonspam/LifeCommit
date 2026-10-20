import { Capacitor } from "@capacitor/core";
import { hasAppLabel, rememberAppLabels } from "./processor/utils";

const asked = new Set<string>();

/** Fetch device labels for packages not looked up yet, so resolveAppName shows e.g. "TMAP" instead of "Ku". Never throws. */
export async function loadAppLabels(pkgs: Iterable<string | null | undefined>): Promise<void> {
  const todo = [...new Set(pkgs)].filter((p): p is string => !!p && !hasAppLabel(p) && !asked.has(p));
  if (!todo.length || !Capacitor.isNativePlatform()) return;
  todo.forEach((p) => asked.add(p));
  try {
    const { default: LifeCommitPlugin } = await import("@/plugins/LifeCommitPlugin");
    rememberAppLabels((await LifeCommitPlugin.getAppLabels({ packages: todo })).labels);
  } catch (e) {
    console.warn("[appLabels] lookup failed:", e);
  }
}
