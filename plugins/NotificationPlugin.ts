import { registerPlugin } from "@capacitor/core";

export interface NotificationPluginInterface {
  /**
   * 알림 접근 허용 권한이 활성화되어 있는지 확인
   */
  hasNotificationPermission(): Promise<{ granted: boolean }>;

  /**
   * 시스템의 '알림 접근 허용' 설정 화면을 실행합니다.
   */
  openNotificationSettings(): Promise<void>;
}

const NotificationPlugin = registerPlugin<NotificationPluginInterface>("NotificationPlugin", {
  web: () =>
    import("./mocks/NotificationMock").then((m) => new m.NotificationMock()),
});

export default NotificationPlugin;
