import { registerPlugin } from "@capacitor/core";

export interface KeystorePluginInterface {
  /**
   * Android Keystore로 보호된 EncryptedSharedPreferences에서 SQLCipher DB
   * 암호화 키를 가져온다. 저장된 키가 없으면 네이티브 측에서 무작위 256비트
   * 키를 최초 1회 생성한다. JS 번들에는 키 값이 절대 포함되지 않는다.
   */
  getOrCreateEncryptionKey(): Promise<{ key: string }>;

  /** 레거시 하드코딩 패스프레이즈 -> 네이티브 키 재암호화(rekey) 완료 여부 */
  getRekeyStatus(): Promise<{ done: boolean }>;

  /** rekey 마이그레이션이 성공한 뒤에만 호출 (1회성 완료 플래그 기록) */
  markRekeyDone(): Promise<void>;
}

const KeystorePlugin = registerPlugin<KeystorePluginInterface>("KeystorePlugin");

export default KeystorePlugin;
