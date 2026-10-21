import type { LifeCommitPluginInterface, SystemPermissionsResult } from "../LifeCommitPlugin";
import type { UsageQueueItem } from "@/lib/usageDrain";

export class LifeCommitMock implements LifeCommitPluginInterface {
  private mockShareChunks = new Map<string, string[]>();

  async checkSystemPermissions(): Promise<SystemPermissionsResult> {
    return {
      accessibility: true,
      notification: true,
      battery: true,
      location: true,
      usage: true,
      locationAlways: true,
      contacts: true,
      flavor: "full",
      postNotifications: true,
      dailyReminder: true,
    };
  }

  async openSystemSetting(): Promise<{ success: boolean }> {
    return { success: true };
  }

  async exportBackupFile(options: { filename: string; content: string }): Promise<{ success: boolean; path?: string; filename?: string }> {
    console.log("[LifeCommitMock] exportBackupFile:", options.filename);
    return { success: true, filename: options.filename };
  }

  async shareImage(options: { filename: string; base64: string; mode: "share" | "save" }): Promise<{ success: boolean; path?: string; uri?: string; filename?: string }> {
    console.log("[LifeCommitMock] shareImage:", options.filename, options.mode);
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      try {
        const cleanBase64 = options.base64.replace(/^data:image\/png;base64,/, "");
        const link = document.createElement("a");
        link.href = `data:image/png;base64,${cleanBase64}`;
        link.download = options.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (e) {
        console.warn("[LifeCommitMock] Web download trigger failed:", e);
      }
    }
    return { success: true, filename: options.filename };
  }

  async appendShareChunk(options: { id: string; base64: string }): Promise<{ success: boolean }> {
    const list = this.mockShareChunks.get(options.id) || [];
    list.push(options.base64);
    this.mockShareChunks.set(options.id, list);
    return { success: true };
  }

  async finishShareMedia(options: {
    id: string;
    filename: string;
    mime?: string;
    mode: "share" | "save";
  }): Promise<{ success: boolean; path?: string; uri?: string; filename?: string }> {
    console.log("[LifeCommitMock] finishShareMedia:", options.filename, options.mode);
    const list = this.mockShareChunks.get(options.id) || [];
    this.mockShareChunks.delete(options.id);

    if (typeof window !== "undefined" && typeof document !== "undefined") {
      try {
        const mimeType = options.mime || "video/mp4";
        const byteArrays: Uint8Array[] = [];
        for (const chunk of list) {
          const clean = chunk.includes(",") ? chunk.substring(chunk.indexOf(",") + 1) : chunk;
          const binaryStr = atob(clean);
          const bytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }
          byteArrays.push(bytes);
        }
        const blob = new Blob(byteArrays as BlobPart[], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = options.filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        console.warn("[LifeCommitMock] Web download trigger failed:", e);
      }
    }

    return { success: true, filename: options.filename };
  }

  async cancelShareMedia(options: { id: string }): Promise<{ success: boolean }> {
    this.mockShareChunks.delete(options.id);
    return { success: true };
  }

  async collectUsage(): Promise<{ collected: boolean; epoch: number; queued: number; lastFailure: string | null }> {
    return { collected: true, epoch: 1, queued: 0, lastFailure: null };
  }

  async peekUsage(): Promise<{ epoch: number; upToSeq: number; items: UsageQueueItem[] }> {
    return { epoch: 1, upToSeq: 0, items: [] };
  }

  async confirmUsage(): Promise<{ confirmed: boolean }> {
    return { confirmed: true };
  }

  async resetUsage(options: { target: number }): Promise<{ reset: boolean; epoch: number }> {
    return { reset: true, epoch: options.target };
  }

  async usageEpoch(): Promise<{ epoch: number }> {
    return { epoch: 1 };
  }

  async getAppLabels(): Promise<{ labels: Record<string, string> }> {
    return { labels: {} };
  }

  async getInstallTime(): Promise<{ installTime: number }> {
    return { installTime: 1700000000000 };
  }

  async backupCorruptDatabase(): Promise<{ success: boolean; path?: string; filesBackedUp?: number }> {
    return { success: true, filesBackedUp: 0 };
  }

  async getDailyReminderSettings(): Promise<{ enabled: boolean; hasPermission: boolean; asked?: boolean }> {
    return { enabled: true, hasPermission: true };
  }

  async setDailyReminderEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }> {
    return { enabled: options.enabled };
  }

  async requestNotificationPermission(): Promise<{ granted: boolean }> {
    return { granted: true };
  }
}
