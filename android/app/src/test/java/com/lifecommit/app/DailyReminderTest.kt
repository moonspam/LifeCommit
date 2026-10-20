package com.lifecommit.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class DailyReminderTest {

    private val zone = ZoneId.of("Asia/Seoul")

    private fun toMillis(dt: LocalDateTime): Long {
        return dt.atZone(zone).toInstant().toEpochMilli()
    }

    @Test
    fun testDisabledNeverSends() {
        val now = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))
        val yesterday = toMillis(LocalDateTime.of(2026, 10, 16, 21, 0, 0))

        // 꺼져 있으면 어제 열었든 한 번도 안 열었든 절대 안 보냄
        assertFalse("꺼져 있으면 안 보냄", DailyReminder.shouldSendNotification(enabled = false, lastOpenedAt = yesterday, now = now, zoneId = zone))
        assertFalse("꺼져 있으면 안 보냄 (한 번도 안 엶)", DailyReminder.shouldSendNotification(enabled = false, lastOpenedAt = 0L, now = now, zoneId = zone))
    }

    @Test
    fun testOpenedTodayDoesNotSend() {
        val now = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))
        val todayMorning = toMillis(LocalDateTime.of(2026, 10, 17, 9, 30, 0))

        // 오늘 앱을 연 적이 있으면 보내지 않음
        assertFalse("오늘 이미 열었으면 안 보냄", DailyReminder.shouldSendNotification(enabled = true, lastOpenedAt = todayMorning, now = now, zoneId = zone))
    }

    @Test
    fun testOpenedYesterdaySends() {
        val now = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))
        val yesterdayNight = toMillis(LocalDateTime.of(2026, 10, 16, 23, 59, 0))

        // 어제 열었으면 보냄
        assertTrue("어제 열었으면 오늘 21시에 보냄", DailyReminder.shouldSendNotification(enabled = true, lastOpenedAt = yesterdayNight, now = now, zoneId = zone))
    }

    @Test
    fun testNeverOpenedSends() {
        val now = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))

        // 앱을 설치하고 한 번도 안 열었거나 초기 상태(lastOpenedAt = 0)이면 보냄
        assertTrue("한 번도 안 열었으면 보냄", DailyReminder.shouldSendNotification(enabled = true, lastOpenedAt = 0L, now = now, zoneId = zone))
    }

    @Test
    fun testComputeNextTriggerTime() {
        val today2100 = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))
        val tomorrow2100 = toMillis(LocalDateTime.of(2026, 10, 18, 21, 0, 0))

        // 20:59 -> 오늘 21:00
        val t2059 = toMillis(LocalDateTime.of(2026, 10, 17, 20, 59, 0))
        assertEquals("20:59 -> 오늘 21:00", today2100, DailyReminder.computeNextTriggerTime(t2059, zone))

        // 21:05 -> 오늘 21:00 (15분 window 내)
        val t2105 = toMillis(LocalDateTime.of(2026, 10, 17, 21, 5, 0))
        assertEquals("21:05 -> 오늘 21:00", today2100, DailyReminder.computeNextTriggerTime(t2105, zone))

        // 21:15 -> 내일 21:00 (window 끝 시점)
        val t2115 = toMillis(LocalDateTime.of(2026, 10, 17, 21, 15, 0))
        assertEquals("21:15 -> 내일 21:00", tomorrow2100, DailyReminder.computeNextTriggerTime(t2115, zone))

        // 23:59 -> 내일 21:00
        val t2359 = toMillis(LocalDateTime.of(2026, 10, 17, 23, 59, 0))
        assertEquals("23:59 -> 내일 21:00", tomorrow2100, DailyReminder.computeNextTriggerTime(t2359, zone))
    }

    @Test
    fun testRescheduleAfterFiringAt2103TargetsTomorrow() {
        val t2103 = toMillis(LocalDateTime.of(2026, 10, 17, 21, 3, 0))
        val tomorrow2100 = toMillis(LocalDateTime.of(2026, 10, 18, 21, 0, 0))
        val rescheduleBase = t2103 + DailyReminder.WINDOW_MS
        assertEquals("21:03 발사 후 재예약 기준 -> 내일 21:00", tomorrow2100, DailyReminder.computeNextTriggerTime(rescheduleBase, zone))
    }

    @Test
    fun testNotifiedTodayDoesNotSend() {
        val now = toMillis(LocalDateTime.of(2026, 10, 17, 21, 5, 0))
        val notifiedEarlier = toMillis(LocalDateTime.of(2026, 10, 17, 21, 0, 0))
        val yesterday = toMillis(LocalDateTime.of(2026, 10, 16, 21, 0, 0))

        // 어제 열었지만 오늘 이미 알림을 보낸 경우 -> 발송 안 함
        assertFalse(
            "오늘 이미 알림 보냈으면 안 보냄 (어제 엶)",
            DailyReminder.shouldSendNotification(
                enabled = true,
                lastOpenedAt = yesterday,
                lastNotifiedAt = notifiedEarlier,
                now = now,
                zoneId = zone
            )
        )

        // 한 번도 안 열었지만 오늘 이미 알림을 보낸 경우 -> 발송 안 함
        assertFalse(
            "오늘 이미 알림 보냈으면 안 보냄 (한 번도 안 엶)",
            DailyReminder.shouldSendNotification(
                enabled = true,
                lastOpenedAt = 0L,
                lastNotifiedAt = notifiedEarlier,
                now = now,
                zoneId = zone
            )
        )

        // 어제 알림을 보냈고 오늘 아직 안 열었으면 오늘 발송해야 함
        val notifiedYesterday = toMillis(LocalDateTime.of(2026, 10, 16, 21, 0, 0))
        assertTrue(
            "어제 알림 보냈고 오늘 아직 안 열었으면 오늘 발송",
            DailyReminder.shouldSendNotification(
                enabled = true,
                lastOpenedAt = yesterday,
                lastNotifiedAt = notifiedYesterday,
                now = now,
                zoneId = zone
            )
        )
    }
}
