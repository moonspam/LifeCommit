import { registerPlugin } from "@capacitor/core";

export interface DebugPluginInterface {
  /**
   * sqlite db 파일을 내보내기 위한 공유 인텐트를 실행합니다.
   */
  exportDatabase(): Promise<void>;
}

const DebugPlugin = registerPlugin<DebugPluginInterface>("DebugPlugin", {
  web: () =>
    import("./mocks/DebugMock").then((m) => new m.DebugMock()),
});

export default DebugPlugin;
