package com.lifecommit.app

import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.SecureRandom

/**
 * Android Keystore로 보호되는 EncryptedSharedPreferences에 SQLCipher DB 암호화
 * 패스프레이즈를 보관한다. 이 키는 JS 번들(NEXT_PUBLIC_*)에는 절대 포함되지 않으며,
 * 네이티브 브릿지를 통해서만 런타임에 전달된다.
 */
@CapacitorPlugin(name = "KeystorePlugin")
class KeystorePlugin : Plugin() {

    companion object {
        private const val PREFS_NAME = "lifecommit_keystore_prefs"
        private const val KEY_DB_SECRET = "db_secret"
        private const val KEY_REKEY_DONE = "legacy_rekey_done"
        private const val SECRET_BYTE_LENGTH = 32 // 256-bit
    }

    private fun prefs() = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    /**
     * DB 암호화 키를 가져온다. 저장된 키가 없으면 SecureRandom으로 256비트 키를
     * 최초 1회 생성하여 저장한다. 이후 호출은 항상 동일한 키를 반환한다.
     */
    @PluginMethod
    fun getOrCreateEncryptionKey(call: PluginCall) {
        try {
            val p = prefs()
            var secret = p.getString(KEY_DB_SECRET, null)
            if (secret.isNullOrEmpty()) {
                val bytes = ByteArray(SECRET_BYTE_LENGTH)
                SecureRandom().nextBytes(bytes)
                secret = bytes.joinToString("") { "%02x".format(it) }
                // commit()으로 동기 저장 - apply()는 비동기라 디스크 반영 전에 프로세스/전원이
                // 끊기면 새로 생성한 키가 유실될 수 있다. 저장 실패 시 성공을 보고하지 않는다.
                if (!p.edit().putString(KEY_DB_SECRET, secret).commit()) {
                    call.reject("Failed to persist new encryption key to native keystore")
                    return
                }
            }
            call.resolve(JSObject().put("key", secret))
        } catch (e: Exception) {
            call.reject("Failed to access native keystore: ${e.message}", e)
        }
    }

    /**
     * 기존 설치본이 하드코딩된 패스프레이즈를 쓰고 있었는지 여부를 추적하는
     * 1회성 마이그레이션 완료 플래그 조회.
     */
    @PluginMethod
    fun getRekeyStatus(call: PluginCall) {
        try {
            val done = prefs().getBoolean(KEY_REKEY_DONE, false)
            call.resolve(JSObject().put("done", done))
        } catch (e: Exception) {
            call.reject("Failed to read rekey status: ${e.message}", e)
        }
    }

    /**
     * 레거시 하드코딩 패스프레이즈 -> 네이티브 키 마이그레이션이 성공적으로
     * 끝난 뒤에만 호출한다. 실패 시 절대 호출하지 말 것 (다음 실행에서 재시도되어야 함).
     */
    @PluginMethod
    fun markRekeyDone(call: PluginCall) {
        try {
            // commit()으로 동기 저장 - apply()로는 완료 플래그가 디스크에 반영되기 전에
            // 프로세스가 죽으면 다음 실행에서 rekey가 이미 끝났다는 사실을 알 수 없게 된다.
            if (!prefs().edit().putBoolean(KEY_REKEY_DONE, true).commit()) {
                call.reject("Failed to persist rekey completion flag")
                return
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to persist rekey status: ${e.message}", e)
        }
    }
}
