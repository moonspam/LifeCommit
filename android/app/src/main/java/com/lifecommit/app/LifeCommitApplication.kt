package com.lifecommit.app

import android.app.Application
import android.util.Log

/**
 * Application.onCreate()는 같은 프로세스의 모든 Activity/Service보다 먼저 실행이
 * 보장되므로, 접근성 서비스/알림 리스너가 시스템에 의해 MainActivity 없이 독립
 * 실행되는 경우에도 레거시 평문 SharedPreferences 정리가 먼저 끝나도록 여기서 수행한다.
 */
class LifeCommitApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        // An unreadable Keystore key (restored/transferred prefs, a reset Keystore) must not kill the process before
        // the WebView can show the DB error screen; never wipe the key or the DB here - the migration retries next start.
        try {
            PlaintextPrefsMigration.migrateIfNeeded(this)
        } catch (e: Exception) {
            Log.e("LifeCommitApplication", "legacy prefs cleanup skipped (secure prefs unreadable)", e)
        }
    }
}
