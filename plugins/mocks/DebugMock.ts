import { DebugPluginInterface } from "../DebugPlugin";

export class DebugMock implements DebugPluginInterface {
  async exportDatabase(): Promise<void> {
    console.log("[Mock DebugPlugin] exportDatabase called. (Ignored in web mode)");
    alert("데이터베이스 내보내기 기능은 모바일 기기(실기기) 환경에서만 사용 가능합니다.");
  }
}
