package com.lifecommit.app

import android.content.Context
import android.util.Log

/**
 * 과거 버전에서 GPS/화면 텍스트/답장/알림 본문을 평문 SharedPreferences(XML)에
 * 스테이징하던 시절의 잔여 파일을 삭제한다. Application.onCreate()에서 실행되어
 * 같은 프로세스의 어떤 Activity/Service(접근성 서비스, 알림 리스너 포함)보다도
 * 먼저 동작이 보장된다. 삭제에 실패하면 완료 플래그를 세우지 않아 다음 실행에서
 * 다시 시도된다 (조용히 완료 처리하지 않음).
 */
object PlaintextPrefsMigration {
    private const val TAG = "PlaintextPrefsMigration"
    private const val MIGRATION_FLAG_PREFS = "lifecommit_migration_flags"
    private const val KEY_PLAINTEXT_PREFS_DELETED = "plaintext_prefs_deleted_v1"

    private val LEGACY_PLAINTEXT_PREF_NAMES = listOf("lifecommit_buffer", "last_notifications")

    @Synchronized
    fun migrateIfNeeded(context: Context) {
        val flagPrefs = SecurePrefs.get(context, MIGRATION_FLAG_PREFS)
        if (flagPrefs.getBoolean(KEY_PLAINTEXT_PREFS_DELETED, false)) return

        var allDeleted = true
        for (name in LEGACY_PLAINTEXT_PREF_NAMES) {
            try {
                if (!context.deleteSharedPreferences(name)) {
                    allDeleted = false
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to delete legacy plaintext prefs '$name': ${e.message}")
                allDeleted = false
            }
        }

        if (allDeleted) {
            flagPrefs.edit().putBoolean(KEY_PLAINTEXT_PREFS_DELETED, true).apply()
        }
    }
}
