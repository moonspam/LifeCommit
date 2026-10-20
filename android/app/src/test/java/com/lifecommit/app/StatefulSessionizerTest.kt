package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Candidate
import com.lifecommit.app.StatefulSessionizer.Open
import com.lifecommit.app.StatefulSessionizer.State
import com.lifecommit.app.StatefulSessionizer.Event
import com.lifecommit.app.StatefulSessionizer.Kind.PAUSED
import com.lifecommit.app.StatefulSessionizer.Kind.RESUMED
import com.lifecommit.app.StatefulSessionizer.Kind.STOP
import com.lifecommit.app.StatefulSessionizer.Session
import kotlin.random.Random
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StatefulSessionizerTest {
    private val own = "com.lifecommit.app"
    private val day = 24 * 3600_000L
    private val gap = day // COVER_GAP used by the tests
    private val sortKey = compareBy<Session>({ it.startMs }, { it.endMs }, { it.pkg })

    private fun derive(events: List<Event>, state: State?, windowEnd: Long, now: Long = windowEnd) =
        StatefulSessionizer.derive(events, state, windowEnd, now, gap, own)

    /** Random streams with equal-timestamp groups and gaps around the 2 s merge boundary, spanning < COVER_GAP. */
    private fun stream(rnd: Random, t0: Long): List<Event> {
        val pkgs = listOf("a", "b", "c", own)
        val out = ArrayList<Event>()
        var t = t0
        var current: String? = null
        repeat(rnd.nextInt(5, 60)) {
            t += when (rnd.nextInt(6)) {
                0 -> 0L // equal timestamps
                1 -> rnd.nextLong(1999, 2002) // right at the merge boundary
                2 -> rnd.nextLong(1, 1500)
                3 -> rnd.nextLong(2500, 60_000)
                else -> rnd.nextLong(60_000, 40 * 60_000)
            }
            when (rnd.nextInt(12)) {
                in 10..11 -> current?.let { // a blip: another app resumes and pauses while `current` never paused
                    val b = pkgs.filter { p -> p != it }[rnd.nextInt(pkgs.size - 1)]
                    out.add(Event(b, RESUMED, t))
                    t += rnd.nextLong(0, StatefulSessionizer.BLIP_MS + 2)
                    out.add(Event(b, PAUSED, t))
                }
                in 0..4 -> { val p = pkgs[rnd.nextInt(pkgs.size)]; current = p; out.add(Event(p, RESUMED, t)) }
                in 5..7 -> current?.let { out.add(Event(if (rnd.nextInt(5) == 0) pkgs[rnd.nextInt(3)] else it, PAUSED, t)) }
                else -> { out.add(Event("", STOP, t)); current = null }
            }
        }
        return out
    }

    @Test fun anyCutGivesTheSameSessionsAndStateAsOneWindow() {
        var checkedCuts = 0
        var restores = 0 // only a restored blip yields a session nested inside another one
        for (seed in 0 until 300) {
            val rnd = Random(seed)
            val t0 = 1_791_000_000_000L + rnd.nextLong(0, day)
            val events = stream(rnd, t0)
            val end = (events.lastOrNull()?.ts ?: t0) + rnd.nextLong(0, 5_000)
            val whole = derive(events, StatefulSessionizer.emptyState(t0), end)
            restores += whole.sessions.count { inner -> whole.sessions.any { it !== inner && it.startMs < inner.startMs && inner.endMs < it.endMs } }

            val cuts = HashSet<Long>()
            for (e in events) { cuts.add(e.ts); cuts.add(e.ts + 1) }
            for (e in events.filter { it.kind == PAUSED }) for (d in -1L..1L) cuts.add(e.ts + StatefulSessionizer.MERGE_GAP_MS + d)
            for (e in events.filter { it.kind == RESUMED }) for (d in -1L..1L) cuts.add(e.ts + StatefulSessionizer.BLIP_MS + d)
            repeat(10) { cuts.add(rnd.nextLong(t0, end + 1)) }
            for (cut in cuts.filter { it in (t0 + 1)..end }) {
                val first = derive(events.filter { it.ts < cut }, StatefulSessionizer.emptyState(t0), cut)
                val second = derive(events.filter { it.ts >= cut }, first.state, end)
                assertEquals("seed=$seed cut=$cut", whole.sessions.sortedWith(sortKey), (first.sessions + second.sessions).sortedWith(sortKey))
                assertEquals("seed=$seed cut=$cut state", whole.state, second.state)
                checkedCuts++
            }
        }
        assertTrue("cuts checked: $checkedCuts", checkedCuts > 5_000)
        assertTrue("restores exercised: $restores", restores > 200)
    }

    @Test fun mergeBoundaryIsInclusiveAcrossWindows() {
        val t = 1_791_000_000_000L
        val s0 = StatefulSessionizer.emptyState(t - 10_000)
        // PAUSED at t, window ends exactly at t+2000, RESUMED of the same app at t+2000 in the next window: one session
        val w1 = derive(listOf(Event("a", RESUMED, t - 5_000), Event("a", PAUSED, t)), s0, t + 2_000)
        assertEquals(emptyList<Session>(), w1.sessions)
        val w2 = derive(listOf(Event("a", RESUMED, t + 2_000), Event("a", PAUSED, t + 9_000)), w1.state, t + 20_000)
        assertEquals(listOf(Session("a", t - 5_000, t + 9_000)), w2.sessions)
        // one ms later is a new session
        val w3 = derive(listOf(Event("a", RESUMED, t - 5_000), Event("a", PAUSED, t), Event("a", RESUMED, t + 2_001), Event("a", PAUSED, t + 9_000)), s0, t + 20_000)
        assertEquals(listOf(Session("a", t - 5_000, t), Session("a", t + 2_001, t + 9_000)), w3.sessions)
    }

    @Test fun staleStateNeverProducesAMultiDaySession() {
        val mon = 1_791_000_000_000L
        val wed = mon + 2 * day
        val carried = State(open = Open("a", mon), candidate = null, cursor = mon + 60_000, lastRunAt = mon + 60_000)
        val r = derive(listOf(Event("b", RESUMED, wed), Event("b", PAUSED, wed + 60_000), Event("", STOP, wed + 70_000),
            Event("c", RESUMED, wed + 80_000), Event("c", PAUSED, wed + 90_000)), carried, wed + 100_000)
        assertEquals("stale_state", r.reason)
        assertEquals(listOf(Session("c", wed + 80_000, wed + 90_000)), r.sessions) // nothing from Monday, nothing before the first STOP
        assertTrue(r.sessions.all { it.endMs - it.startMs < day })
    }

    @Test fun staleStateStillEmitsTheClosedCandidate() {
        val mon = 1_791_000_000_000L
        val carried = State(open = null, candidate = Candidate("a", mon, mon + 30_000), cursor = mon + 31_000, lastRunAt = mon + 31_000)
        val r = derive(emptyList(), carried, mon + 3 * day)
        assertEquals("stale_state", r.reason)
        assertEquals(listOf(Session("a", mon, mon + 30_000)), r.sessions)
        assertEquals(false, r.state.warm)
    }

    @Test fun clockBehindTheCursorRestartsCold() {
        val t = 1_791_000_000_000L
        val carried = State(open = Open("a", t), candidate = null, cursor = t + 600_000, lastRunAt = t + 600_000)
        val r = derive(listOf(Event("b", RESUMED, t + 100_000)), carried, windowEnd = t + 200_000, now = t + 200_000)
        assertEquals("clock", r.reason)
        assertEquals(emptyList<Session>(), r.sessions)
    }

    @Test fun coldStartDiscardsUntilTheFirstStopAndStaysColdWithoutOne() {
        val t = 1_791_000_000_000L
        val noStop = derive(listOf(Event("a", RESUMED, t), Event("a", PAUSED, t + 50_000)), null, t + 60_000)
        assertEquals("cold_start", noStop.reason)
        assertEquals(emptyList<Session>(), noStop.sessions)
        assertEquals(false, noStop.state.warm)
        // the next window is still cold: the RESUMED of 'b' had no trusted start before the STOP
        val next = derive(listOf(Event("b", PAUSED, t + 70_000), Event("", STOP, t + 80_000),
            Event("c", RESUMED, t + 90_000), Event("c", PAUSED, t + 95_000)), noStop.state, t + 120_000)
        assertEquals("cold_start", next.reason)
        assertEquals(listOf(Session("c", t + 90_000, t + 95_000)), next.sessions)
        assertEquals(true, next.state.warm)
    }

    @Test fun emptyWindowKeepsTheOpenSessionAndAdvancesTheCursor() {
        val t = 1_791_000_000_000L
        val carried = State(open = Open("a", t), candidate = null, cursor = t + 1_000, lastRunAt = t + 1_000)
        val r = derive(emptyList(), carried, t + 600_000)
        assertEquals(null, r.reason)
        assertEquals(emptyList<Session>(), r.sessions)
        assertEquals(State(Open("a", t), null, t + 600_000, t + 600_000), r.state)
    }

    // ── blip: another app covers the open one briefly and leaves, the open app never paused ──
    private val t = 1_791_000_000_000L
    private val s0 = StatefulSessionizer.emptyState(t - 10_000)

    @Test fun launcherFlashOverAVideoKeepsTheVideoSession() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("l", RESUMED, t + 2_000), Event("l", PAUSED, t + 2_400),
            Event("a", PAUSED, t + 480_000)), s0, t + 600_000)
        assertEquals(listOf(Session("a", t, t + 480_000), Session("l", t + 2_000, t + 2_400)), r.sessions.sortedWith(sortKey))
    }

    @Test fun oneSecondBlipEndingExactlyAtTheLimitIsRestored() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("l", RESUMED, t + 1_000), Event("l", PAUSED, t + 1_000 + StatefulSessionizer.BLIP_MS),
            Event("a", PAUSED, t + 54_000)), s0, t + 600_000)
        assertEquals(Session("a", t, t + 54_000), r.sessions.single { it.pkg == "a" })
    }

    @Test fun coverLongerThanABlipEndsTheCoveredApp() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("b", RESUMED, t + 1_000), Event("b", PAUSED, t + 1_001 + StatefulSessionizer.BLIP_MS),
            Event("a", PAUSED, t + 54_000)), s0, t + 600_000)
        assertEquals(Session("a", t, t + 1_000), r.sessions.single { it.pkg == "a" })
    }

    @Test fun coveredAppPausedDuringTheBlipEndsWhenCovered() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("b", RESUMED, t + 1_000), Event("a", PAUSED, t + 1_000),
            Event("b", PAUSED, t + 60_000)), s0, t + 600_000)
        assertEquals(listOf(Session("a", t, t + 1_000), Session("b", t + 1_000, t + 60_000)), r.sessions.sortedWith(sortKey))
    }

    @Test fun stopDuringTheBlipEndsBoth() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("l", RESUMED, t + 1_000), Event("", STOP, t + 1_500),
            Event("a", PAUSED, t + 60_000)), s0, t + 600_000)
        assertEquals(listOf(Session("a", t, t + 1_000), Session("l", t + 1_000, t + 1_500)), r.sessions.sortedWith(sortKey))
    }

    @Test fun thirdAppDuringTheBlipEndsTheCoveredAppWhenCovered() {
        val r = derive(listOf(Event("a", RESUMED, t), Event("l", RESUMED, t + 1_000), Event("c", RESUMED, t + 1_500),
            Event("l", PAUSED, t + 1_600), Event("a", PAUSED, t + 1_700), Event("c", PAUSED, t + 60_000)), s0, t + 600_000)
        assertEquals(listOf(Session("a", t, t + 1_000), Session("l", t + 1_000, t + 1_500), Session("c", t + 1_500, t + 60_000)),
            r.sessions.sortedWith(sortKey))
    }

    @Test fun staleStateEmitsTheSuspendedAppUpToTheCover() {
        val carried = State(open = Open("l", t + 1_000), candidate = null, cursor = t + 1_200, lastRunAt = t + 1_200,
            suspended = StatefulSessionizer.Suspended("a", t, t + 1_000))
        val r = derive(emptyList(), carried, t + 3 * day)
        assertEquals("stale_state", r.reason)
        assertEquals(listOf(Session("a", t, t + 1_000)), r.sessions)
    }

    @Test fun blipDeadlineIsInclusiveAcrossWindows() {
        val d = t + 1_000 + StatefulSessionizer.BLIP_MS // deadline
        val start = listOf(Event("a", RESUMED, t), Event("l", RESUMED, t + 1_000))
        // window ends exactly at the deadline, the blip's PAUSED at the deadline arrives in the next window: restored
        val w1 = derive(start, s0, d)
        val w2 = derive(listOf(Event("l", PAUSED, d), Event("a", PAUSED, t + 60_000)), w1.state, t + 600_000)
        assertEquals(Session("a", t, t + 60_000), (w1.sessions + w2.sessions).single { it.pkg == "a" })
        // one ms later: the cover was not a blip
        val v1 = derive(start, s0, d + 1)
        val v2 = derive(listOf(Event("l", PAUSED, d + 1), Event("a", PAUSED, t + 60_000)), v1.state, t + 600_000)
        assertEquals(Session("a", t, t + 1_000), (v1.sessions + v2.sessions).single { it.pkg == "a" })
    }

    @Test fun aSessionCrossingMidnightIsEmittedWhole() {
        val m = 1_791_212_400_000L // 2026-10-06 00:00 KST; the drain lays out the parts, not the sessionizer
        val r = derive(listOf(Event("a", RESUMED, m - 3_600_000), Event("a", PAUSED, m + 7_200_000)), StatefulSessionizer.emptyState(m - 4_000_000), m + 8_000_000)
        assertEquals(listOf(Session("a", m - 3_600_000, m + 7_200_000)), r.sessions)
    }

    @Test fun ownAppClosesOthersButIsNotEmitted() {
        val t = 1_791_000_000_000L
        val r = derive(listOf(Event("a", RESUMED, t), Event(own, RESUMED, t + 4_000), Event(own, PAUSED, t + 60_000), Event("", STOP, t + 70_000)),
            StatefulSessionizer.emptyState(t - 1), t + 100_000)
        assertEquals(listOf(Session("a", t, t + 4_000)), r.sessions)
    }
}
