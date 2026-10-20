package com.lifecommit.app

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

class LifeCommitNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "LifeCommitNotification"
        
        // 무시할 알림 패키지 목록 (노이즈 필터)
        private val NOISE_PACKAGES = setOf(
            "android",
            "com.android.systemui",
            "com.lifecommit.app",
            "com.google.android.gms",
            "com.google.android.gsf",
            "com.google.android.projection.gearhead",    // 안드로이드 오토
            "com.skt.tmap.ku",                           // 티맵
            "com.locnall.KimGiSa",                       // 카카오내비
            "com.nhn.android.nmap",                      // 네이버 지도
            "com.google.android.apps.maps"               // 구글 지도
        )
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.d(TAG, "Notification Listener Connected")
    }

    override fun onDestroy() {
        super.onDestroy()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return

        try {
            val packageName = sbn.packageName ?: ""
            if (NOISE_PACKAGES.contains(packageName) || packageName == this.packageName) return // own app, whatever its id

            val extras = sbn.notification.extras
            val title = extras.getString("android.title") ?: ""
            val text = extras.getCharSequence("android.text")?.toString() ?: ""

            // 제목과 본문이 모두 비어 있으면 무시
            if (title.isEmpty() && text.isEmpty()) return

            val timestamp = sbn.postTime

            // ── 수신 알림 임시 캐싱 (EncryptedSharedPreferences 기반 NotificationCache) ──
            // 이 저장소는 사용자가 답장을 보내는 시점에 접근성 서비스에서 대조하는 용도로만 쓰입니다.
            // TTL(10분)/개수 상한(200건)으로 자동 정리됩니다.
            NotificationCache.put(this, packageName, title, text, timestamp)

            Log.d(TAG, "Cached incoming notification for reply match: $packageName") // never the title/text (sender names, content)

        } catch (e: Exception) {
            Log.e(TAG, "Error in onNotificationPosted", e)
        }
    }
}
