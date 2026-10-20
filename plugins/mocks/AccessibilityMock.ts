import type { AccessibilityPluginInterface, AccessibilityEvent, AccessibilityServiceStatus } from "../AccessibilityPlugin";

export class AccessibilityMock implements AccessibilityPluginInterface {
  async getServiceStatus(): Promise<AccessibilityServiceStatus> {
    return { isEnabled: true, isRunning: true };
  }
  async openAccessibilitySettings(): Promise<void> { console.log("[Mock] openAccessibilitySettings"); }
  async getCurrentScreenText(): Promise<{ text: string }> { return { text: "Demo tab - iluku blog" }; }
  async addListener(_: string, cb: (e: AccessibilityEvent) => void): Promise<{ remove: () => Promise<void> }> {
    const timer = setInterval(() => cb({
      packageName: "com.android.chrome", appLabel: "Chrome",
      eventType: "WINDOW_STATE_CHANGED", extractedText: "iluku blog",
      contentDescription: null, timestamp: Date.now()
    }), 60000);
    return { remove: async () => clearInterval(timer) };
  }

  async flushBufferedEvents(): Promise<{ events: string; upToSeq: number }> {
    return { events: "[]", upToSeq: 0 };
  }

  async confirmFlush(): Promise<void> {}

  async updateNoiseFilters(options: { packages: string[] }): Promise<void> {
    console.log("[Mock] updateNoiseFilters called with:", options.packages);
  }
}
