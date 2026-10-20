import type { CallLogPluginInterface, CallLogEntry, SmsEntry } from "../CallLogPlugin";

export class CallLogMock implements CallLogPluginInterface {
  async hasCallLogPermission() { return { granted: true }; }
  async hasSmsPermission() { return { granted: true }; }
  async checkPermissions() { return { callLog: "granted", sms: "granted" }; }
  async requestPermissions() { return { callLog: "granted", sms: "granted" }; }
  async getCallLogs(): Promise<{ calls: CallLogEntry[] }> {
    return { calls: [
      { id: "1", contactName: "아내", phoneNumber: "010-0000-0001", callType: "INCOMING", durationSec: 240, timestamp: Date.now() - 7200000, resolvedTag: "#family" },
      { id: "2", contactName: "Jiho", phoneNumber: "010-0000-0002", callType: "OUTGOING", durationSec: 90, timestamp: Date.now() - 3600000, resolvedTag: "#family" },
    ]};
  }
  async getSms(): Promise<{ messages: SmsEntry[] }> { return { messages: [] }; }
  async listContacts(): Promise<{ contacts: { name: string; phone: string }[] }> {
    return {
      contacts: [
        { name: "김철수", phone: "010-1234-5678" },
        { name: "이영희", phone: "010-9876-5432" },
      ],
    };
  }
  async addListener(_: string, _cb: (e: any) => void): Promise<{ remove: () => Promise<void> }> {
    return { remove: async () => {} };
  }
}
