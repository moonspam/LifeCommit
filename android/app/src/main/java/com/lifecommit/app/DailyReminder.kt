package com.lifecommit.app

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.Calendar

/**
 * Step 4: 매일 21:00 무렵 앱 열기를 유도하는 알림 (oss/full 공통).
 * 오늘 앱을 이미 연 적이 있으면 알림을 보내지 않으며,
 * inexact alarm을 사용하여 배터리 소모를 최소화합니다.
 */
object DailyReminder {
    private const val TAG = "DailyReminder"
    private const val PREFS_NAME = "lifecommit_daily_reminder"
    private const val KEY_ENABLED = "daily_reminder_enabled"
    private const val KEY_LAST_OPENED_AT = "last_opened_at"
    private const val KEY_LAST_NOTIFIED_AT = "last_notified_at"
    private const val KEY_ASKED = "notification_permission_asked"

    const val WINDOW_MS = 15 * 60 * 1000L // 15분 inexact window

    const val CHANNEL_ID = "daily_reminder"
    const val NOTIFICATION_ID = 4001
    const val REQUEST_CODE = 4002

    const val NOTIF_TITLE = "LifeCommit"
    const val NOTIF_BODY = "오늘 기록을 정리해 볼까요? 앱을 열면 수집이 이어집니다."

    /**
     * 알림 발송 여부를 결정하는 순수 함수 (JVM 단위 테스트용).
     * 1) enabled가 false이면 발송 안 함.
     * 2) 오늘 이미 알림을 보낸 적이 있으면 발송 안 함 (lastNotifiedAt 기준 같은 날).
     * 3) 오늘(now 기준 날짜) 앱을 연 적이 있으면 발송 안 함.
     * 4) 어제 열었거나 한 번도 연 적이 없으면(lastOpenedAt <= 0) 발송함.
     */
    fun shouldSendNotification(
        enabled: Boolean,
        lastOpenedAt: Long,
        lastNotifiedAt: Long = 0L,
        now: Long,
        zoneId: ZoneId = ZoneId.systemDefault()
    ): Boolean {
        if (!enabled) return false
        val nowDate = Instant.ofEpochMilli(now).atZone(zoneId).toLocalDate()
        if (lastNotifiedAt > 0L) {
            val lastNotifiedDate = Instant.ofEpochMilli(lastNotifiedAt).atZone(zoneId).toLocalDate()
            if (lastNotifiedDate == nowDate) return false
        }
        if (lastOpenedAt <= 0L) return true
        val lastDate = Instant.ofEpochMilli(lastOpenedAt).atZone(zoneId).toLocalDate()
        return lastDate.isBefore(nowDate)
    }

    private fun getPrefs(context: Context) =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun isEnabled(context: Context): Boolean {
        return getPrefs(context).getBoolean(KEY_ENABLED, true)
    }

    fun setEnabled(context: Context, enabled: Boolean) {
        getPrefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply()
        if (enabled) {
            scheduleIfNeeded(context)
        } else {
            cancel(context)
        }
    }

    fun hasAskedNotificationPermission(context: Context): Boolean {
        return getPrefs(context).getBoolean(KEY_ASKED, false)
    }

    fun setAskedNotificationPermission(context: Context, asked: Boolean = true) {
        getPrefs(context).edit().putBoolean(KEY_ASKED, asked).apply()
        Log.d(TAG, "setAskedNotificationPermission: $asked")
    }

    fun getLastOpenedAt(context: Context): Long {
        return getPrefs(context).getLong(KEY_LAST_OPENED_AT, 0L)
    }

    fun getLastNotifiedAt(context: Context): Long {
        return getPrefs(context).getLong(KEY_LAST_NOTIFIED_AT, 0L)
    }

    /**
     * 알림이 성공적으로 전송되었을 때 마지막 발송 시각을 저장합니다.
     */
    fun recordNotificationSent(context: Context) {
        val now = System.currentTimeMillis()
        getPrefs(context).edit().putLong(KEY_LAST_NOTIFIED_AT, now).apply()
        Log.d(TAG, "recordNotificationSent at $now")
    }

    /**
     * MainActivity onResume에서 호출되어 마지막으로 앱을 연 시각을 저장합니다.
     */
    fun recordAppOpened(context: Context) {
        val now = System.currentTimeMillis()
        getPrefs(context).edit().putLong(KEY_LAST_OPENED_AT, now).apply()
        Log.d(TAG, "recordAppOpened at $now")
    }

    /**
     * 알람을 매번 21:00 시각으로 예약합니다.
     * 벽시계 21:00 고정이므로 매번 재설정해도 시간이 밀리지 않습니다.
     */
    fun scheduleIfNeeded(context: Context) {
        if (!isEnabled(context)) {
            cancel(context)
            return
        }

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        scheduleNextAlarm(context, alarmManager)
    }

    /**
     * 다음 21:00 무렵의 inexact window 알람을 예약합니다.
     * 리시버 발사 직후 재예약 시에는 fromTime에 now + WINDOW_MS를 전달하여 항상 내일 21:00으로 예약합니다.
     */
    fun scheduleNextAlarm(
        context: Context,
        alarmManager: AlarmManager? = null,
        fromTime: Long = System.currentTimeMillis()
    ) {
        val am = alarmManager ?: (context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager) ?: return
        if (!isEnabled(context)) return

        val triggerAtMs = computeNextTriggerTime(fromTime)
        val intent = Intent(context, DailyReminderReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // inexact window: 15분 범위(setWindow), exact alarm 권한 불필요
        am.setWindow(
            AlarmManager.RTC,
            triggerAtMs,
            WINDOW_MS,
            pendingIntent
        )
        Log.d(TAG, "scheduleNextAlarm: scheduled for ${Instant.ofEpochMilli(triggerAtMs)} (base: ${Instant.ofEpochMilli(fromTime)})")
    }

    /**
     * 현재 시각 기준 다음 21:00 시각을 계산합니다.
     * now가 오늘 21:15(창 끝) 전이면 오늘 21:00, 21:15 이후면 내일 21:00.
     */
    fun computeNextTriggerTime(now: Long, zoneId: ZoneId = ZoneId.systemDefault()): Long {
        val currentDateTime = Instant.ofEpochMilli(now).atZone(zoneId).toLocalDateTime()
        val windowEnd = currentDateTime.withHour(21).withMinute(15).withSecond(0).withNano(0)
        val targetDateTime = if (currentDateTime.isBefore(windowEnd)) {
            currentDateTime.withHour(21).withMinute(0).withSecond(0).withNano(0)
        } else {
            currentDateTime.plusDays(1).withHour(21).withMinute(0).withSecond(0).withNano(0)
        }
        return targetDateTime.atZone(zoneId).toInstant().toEpochMilli()
    }

    fun cancel(context: Context) {
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        val intent = Intent(context, DailyReminderReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            REQUEST_CODE,
            intent,
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
        )
        if (pendingIntent != null) {
            alarmManager.cancel(pendingIntent)
            pendingIntent.cancel()
            Log.d(TAG, "canceled daily reminder alarm")
        }
    }

    fun createNotificationChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "매일 알림",
                    NotificationManager.IMPORTANCE_DEFAULT
                ).apply {
                    description = "하루 한 번 기록 확인을 알려 줍니다."
                }
                nm.createNotificationChannel(channel)
            }
        }
    }
}

/**
 * 21:00 알람을 수신하는 브로드캐스트 리시버.
 */
class DailyReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val enabled = DailyReminder.isEnabled(context)
        val lastOpened = DailyReminder.getLastOpenedAt(context)
        val lastNotified = DailyReminder.getLastNotifiedAt(context)
        val now = System.currentTimeMillis()

        Log.d("DailyReminderReceiver", "Alarm fired: enabled=$enabled, lastOpened=$lastOpened, lastNotified=$lastNotified, now=$now")

        if (DailyReminder.shouldSendNotification(enabled, lastOpened, lastNotified, now)) {
            showNotification(context)
        } else {
            Log.d("DailyReminderReceiver", "Notification skipped (already opened today, already notified today, or disabled)")
        }

        // 다음 날 알람 재설정: 발사 직후 재예약 시 기준 시각을 now + WINDOW_MS로 넘겨 항상 내일 21:00이 되게 함 (무한 루프 방지)
        DailyReminder.scheduleNextAlarm(context, fromTime = now + DailyReminder.WINDOW_MS)
    }

    private fun showNotification(context: Context) {
        DailyReminder.createNotificationChannel(context)

        // Android 13+ 권한 확인
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                context,
                android.Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                Log.w("DailyReminderReceiver", "POST_NOTIFICATIONS not granted, cannot post notification")
                return
            }
        }

        val tapIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val tapPendingIntent = PendingIntent.getActivity(
            context,
            0,
            tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, DailyReminder.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(DailyReminder.NOTIF_TITLE)
            .setContentText(DailyReminder.NOTIF_BODY)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(tapPendingIntent)
            .setAutoCancel(true)
            .build()

        try {
            NotificationManagerCompat.from(context).notify(DailyReminder.NOTIFICATION_ID, notification)
            DailyReminder.recordNotificationSent(context)
            Log.d("DailyReminderReceiver", "Notification posted successfully")
        } catch (e: SecurityException) {
            Log.w("DailyReminderReceiver", "SecurityException posting notification", e)
        }
    }
}
