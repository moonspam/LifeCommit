import { registerPlugin } from "@capacitor/core";

export interface SystemPermissionsResult {
  accessibility: boolean;
  notification: boolean;
  battery: boolean;
  location: boolean;
  usage: boolean;
  /** optional (full): background location, only grantable in system settings */
  locationAlways: boolean;
  /** optional (full): contact names for calls/SMS */
  contacts: boolean;
  flavor: "full" | "oss";
  postNotifications?: boolean;
  dailyReminder?: boolean;
}

import type { UsageQueueItem } from "@/lib/usageDrain";

export interface LifeCommitPluginInterface {
  checkSystemPermissions(): Promise<SystemPermissionsResult>;
  openSystemSetting(options: { type: "accessibility" | "notification" | "battery" | "usage" | "app_info" }): Promise<{ success: boolean }>;
  exportBackupFile(options: { filename: string; content: string }): Promise<{ success: boolean; path?: string; filename?: string }>;
  /** 닫힌 포그라운드 세션 (UsageStatsManager, since 이후). 사용 정보 접근 필요. */
  // native usage store (Step 6c-3): collect -> peek -> drain (JS) -> confirm
  /** collected=false: native epoch != expectedEpoch (nothing written, seed unused) */
  collectUsage(options: { seedCursor: number; expectedEpoch: number }): Promise<{ collected: boolean; epoch: number; queued: number; lastFailure: string | null }>;
  peekUsage(options: { max?: number }): Promise<{ epoch: number; upToSeq: number; items: UsageQueueItem[] }>;
  confirmUsage(options: { epoch: number; upToSeq: number }): Promise<{ confirmed: boolean }>;
  /** target <= current epoch is a no-op (reset=false) */
  resetUsage(options: { target: number }): Promise<{ reset: boolean; epoch: number }>;
  usageEpoch(): Promise<{ epoch: number }>;
  /** launcher labels; packages the device cannot resolve are left out */
  getAppLabels(options: { packages: string[] }): Promise<{ labels: Record<string, string> }>;
  /** 앱의 실제 최초 설치 시각(Unix epoch ms). 재설치 시 새로 갱신됨. */
  getInstallTime(): Promise<{ installTime: number }>;
  /** 손상 의심 DB를 삭제하기 전에 .db/-wal/-shm 파일을 캐시로 백업 */
  backupCorruptDatabase(options: { database: string }): Promise<{ success: boolean; path?: string; filesBackedUp?: number }>;
  /** 매일 21:00 리마인더 알림 설정 조회 */
  getDailyReminderSettings(): Promise<{ enabled: boolean; hasPermission: boolean; asked?: boolean }>;
  /** 매일 21:00 리마인더 알림 활성화/비활성화 */
  setDailyReminderEnabled(options: { enabled: boolean }): Promise<{ enabled: boolean }>;
  /** 알림 권한 (Android 13+ POST_NOTIFICATIONS) 요청 */
  requestNotificationPermission(): Promise<{ granted: boolean }>;
}

const LifeCommitPlugin = registerPlugin<LifeCommitPluginInterface>("LifeCommitPlugin");

export default LifeCommitPlugin;
