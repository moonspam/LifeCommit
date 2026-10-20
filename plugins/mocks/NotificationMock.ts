import type { NotificationPluginInterface } from "../NotificationPlugin";

export class NotificationMock implements NotificationPluginInterface {
  async hasNotificationPermission() {
    return { granted: true };
  }

  async openNotificationSettings(): Promise<void> {
    console.log("[Mock] Opening Notification Access settings screen.");
  }
}
