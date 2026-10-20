package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Event
import com.lifecommit.app.StatefulSessionizer.Kind.PAUSED
import com.lifecommit.app.StatefulSessionizer.Kind.RESUMED
import com.lifecommit.app.StatefulSessionizer.Kind.STOP
import com.lifecommit.app.UsageStore.Item
import com.lifecommit.app.UsageStore.StoreState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UsageStoreTest {
    private val own = "com.lifecommit.app"
    private val day = 24 * 3600_000L
    private val t0 = 1_791_000_000_000L

    /** Storage double: persisted value + failure modes. */
    private class FakeStorage(var persisted: StoreState? = null) : UsageStore.StateStorage {
        var mode = "ok" // ok | fail | mutate_then_fail | persist_but_fail
        var writes = 0
        override fun load() = persisted
        override fun write(state: StoreState): Boolean {
            writes++
            return when (mode) {
                "fail" -> false
                "mutate_then_fail" -> { (state.queue as? MutableList<Item>)?.clear(); false }
                "persist_but_fail" -> { persisted = state; false }
                else -> { persisted = state; true }
            }
        }
    }

    private val events = listOf(
        Event("", STOP, t0 + 1_000), // first STOP ends the cold start
        Event("a", RESUMED, t0 + 10_000), Event("a", PAUSED, t0 + 70_000),
        Event("b", RESUMED, t0 + 80_000), Event("b", PAUSED, t0 + 140_000),
        Event("", STOP, t0 + 150_000),
        Event("c", RESUMED, t0 + 200_000), Event("c", PAUSED, t0 + 260_000),
    )
    private val query: (Long, Long) -> List<Event> = { b, e -> events.filter { it.ts in b until e } }

    private fun store(s: FakeStorage = FakeStorage()) = UsageStore(s, coverGap = day, ownPkg = own)
    private fun sessions(st: UsageStore) = st.peek(10_000).items.filterIsInstance<Item.SessionItem>().map { it.session }

    @Test fun lateResetAfterANewerResetIsANoOp() {
        val st = store()
        assertTrue(st.reset(2))
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val before = st.peek(1000)
        assertFalse("late reset(1) must be a no-op", st.reset(1))
        assertEquals(before, st.peek(1000))
        assertEquals(2L, st.epoch())
    }

    @Test fun originalResetArrivingAfterACatchUpIsANoOp() {
        val st = store()
        assertTrue(st.reset(1)) // catch-up reset(1) from the drain path
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val before = st.peek(1000)
        assertFalse("the original reset(1) arriving later must be a no-op", st.reset(1))
        assertEquals(before, st.peek(1000))
    }

    @Test fun staleConfirmIsRejectedAndConfirmKeepsLaterItems() {
        val st = store()
        st.collectNow(query, now = t0 + 150_000, seedCursor = t0)
        val p = st.peek(1000)
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0) // appended after the peek
        assertFalse(st.confirm(p.epoch + 1, p.upToSeq))
        assertTrue(st.confirm(p.epoch, p.upToSeq))
        val left = st.peek(1000).items
        assertTrue(left.isNotEmpty())
        assertTrue(left.all { it.seq > p.upToSeq })
    }

    @Test fun failedWriteChangesNothingAndTheRetryStartsFromTheOldCursor() {
        val s = FakeStorage()
        val st = store(s)
        st.collectNow(query, now = t0 + 100_000, seedCursor = t0)
        val before = st.snapshot()
        s.mode = "fail"
        try { st.collectNow(query, now = t0 + 300_000, seedCursor = t0); fail("expected WriteFailed") } catch (_: UsageStore.WriteFailed) {}
        assertEquals(before, st.snapshot())
        s.mode = "ok"
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val reference = store(); reference.collectNow(query, now = t0 + 100_000, seedCursor = t0); reference.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        assertEquals(sessions(reference), sessions(st))
    }

    @Test fun storageThatMutatesTheStateThenFailsCannotCorruptCommitted() {
        val s = FakeStorage()
        val st = store(s)
        st.collectNow(query, now = t0 + 150_000, seedCursor = t0)
        val before = st.snapshot()
        s.mode = "mutate_then_fail"
        try { st.collectNow(query, now = t0 + 300_000, seedCursor = t0); fail("expected WriteFailed") } catch (_: UsageStore.WriteFailed) {}
        assertEquals(before, st.snapshot())
        assertTrue(st.peek(1000).items.isNotEmpty())
    }

    @Test fun writeThatPersistedButReportedFailureNeitherLosesNorDuplicates() {
        // without a restart: the retry rewrites identical content with identical seqs
        val s = FakeStorage()
        val st = store(s)
        s.mode = "persist_but_fail"
        try { st.collectNow(query, now = t0 + 300_000, seedCursor = t0); fail() } catch (_: UsageStore.WriteFailed) {}
        val persistedFirst = s.persisted
        s.mode = "ok"
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        assertEquals(persistedFirst, s.persisted)

        // with a restart: the new instance loads what was persisted and continues without reusing a seq
        val s2 = FakeStorage()
        val a = store(s2)
        a.collectNow(query, now = t0 + 100_000, seedCursor = t0)
        s2.mode = "persist_but_fail"
        try { a.collectNow(query, now = t0 + 200_000, seedCursor = t0); fail() } catch (_: UsageStore.WriteFailed) {}
        s2.mode = "ok"
        val restarted = store(s2)
        val seqBefore = restarted.snapshot().nextSeq
        restarted.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val seqs = restarted.peek(1000).items.map { it.seq }
        assertEquals(seqs.distinct(), seqs)
        assertTrue(seqs.filter { it >= seqBefore }.isNotEmpty())
        val reference = store(); listOf(100_000L, 200_000L, 300_000L).forEach { reference.collectNow(query, now = t0 + it, seedCursor = t0) }
        assertEquals(sessions(reference), sessions(restarted))
    }

    @Test fun seqStaysMonotonicAcrossResetAndPeekIsBounded() {
        val st = store()
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val maxBefore = st.peek(1000).items.maxOf { it.seq }
        assertTrue(st.reset(1))
        assertEquals(0, st.peek(1000).items.size)
        st.collectNow(query, now = t0 + 400_000, seedCursor = t0 + 300_000)
        assertTrue(st.peek(1000).items.all { it.seq > maxBefore })
        assertEquals(1, st.peek(1).items.size)
    }

    @Test fun lockedOrUnpermittedQueryChangesNothingButLastFailure() {
        val st = store()
        st.collectNow(query, now = t0 + 100_000, seedCursor = t0)
        val before = st.snapshot()
        st.collectNow({ _, _ -> null }, now = t0 + 200_000, seedCursor = t0)
        assertEquals(before.copy(lastFailure = "query_failed"), st.snapshot())
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0, permitted = false)
        assertEquals(before.copy(lastFailure = "permission"), st.snapshot())
        assertEquals(before.session?.lastRunAt, st.snapshot().session?.lastRunAt)
    }

    @Test fun severalCollectsEqualOneDerive() {
        val st = store()
        for (now in listOf(t0 + 5_000, t0 + 75_000, t0 + 75_000, t0 + 145_000, t0 + 230_000, t0 + 400_000)) {
            st.collectNow(query, now = now, seedCursor = t0)
        }
        val one = StatefulSessionizer.derive(query(t0, t0 + 400_000), null, t0 + 400_000, t0 + 400_000, day, own)
        assertEquals(one.sessions, sessions(st))
        assertEquals(listOf("a", "b", "c"), sessions(st).map { it.pkg })
    }

    @Test fun collectForAnOldEpochDoesNotUseItsSeed() {
        val st = store()
        assertTrue(st.reset(1)) // a reset landed after the caller read epoch 0 and chose the legacy seed
        val before = st.snapshot()
        assertFalse(st.collect(query, now = t0 + 300_000, seedCursor = t0 + 9_000, expectedEpoch = 0))
        assertEquals(before, st.snapshot())
        assertTrue(st.collect(query, now = t0 + 300_000, seedCursor = t0 + 100, expectedEpoch = 1))
        // the cold first window: marker from the seed to the first STOP, processed after it
        assertEquals(listOf(t0 + 100 to "cold_start", t0 + 1_000 to null),
            st.peek(1000).items.filterIsInstance<Item.CoverageItem>().map { it.fromMs to it.reason })
    }

    @Test fun theJobDoesNothingWithoutACursor() {
        val s = FakeStorage()
        val st = store(s)
        val before = st.snapshot()
        assertFalse(st.collectIfStarted(query, { t0 + 300_000 }))
        assertEquals(0, s.writes)
        assertEquals(before, st.snapshot())
        assertTrue(st.reset(1))
        val afterReset = s.writes
        assertFalse("after a reset the app's sync seeds first", st.collectIfStarted(query, { t0 + 300_000 }))
        assertEquals(afterReset, s.writes)
    }

    @Test fun theJobContinuesExactlyLikeTheAppsCollect() {
        val app = store(); val mixed = store()
        val nows = listOf(t0 + 5_000, t0 + 75_000, t0 + 145_000, t0 + 230_000, t0 + 400_000)
        for (n in nows) app.collectNow(query, now = n, seedCursor = t0)
        mixed.collectNow(query, now = nows[0], seedCursor = t0) // the app starts the store
        nows.drop(1).forEachIndexed { i, n ->
            if (i % 2 == 0) assertTrue(mixed.collectIfStarted(query, { n })) else mixed.collectNow(query, now = n, seedCursor = t0)
        }
        assertEquals(app.peek(10_000), mixed.peek(10_000))
        assertEquals(listOf("a", "b", "c"), sessions(mixed).map { it.pkg })
    }

    @Test fun aStoppedJobNeverQueriesOrWrites() {
        val s = FakeStorage()
        val st = store(s)
        st.collectNow(query, now = t0 + 5_000, seedCursor = t0)
        val writes = s.writes
        val before = st.snapshot()
        var queried = false
        assertFalse(st.collectIfStarted({ b, e -> queried = true; query(b, e) }, { t0 + 300_000 }, shouldContinue = { false }))
        assertFalse(queried)
        assertEquals(writes, s.writes)
        assertEquals(before, st.snapshot())
    }

    @Test fun theJobReadsTheClockUnderTheLock() {
        val st = store()
        st.collectNow(query, now = t0 + 5_000, seedCursor = t0)
        var held = false
        st.collectIfStarted(query, { held = Thread.holdsLock(st); t0 + 300_000 })
        assertTrue(held)
    }

    @Test fun itemsTheJobAddsBetweenPeekAndConfirmSurvive() {
        val st = store()
        st.collectNow(query, now = t0 + 150_000, seedCursor = t0)
        val p = st.peek(1000) // the app peeks and drains
        st.collectIfStarted(query, { t0 + 300_000 }) // the job runs meanwhile
        assertTrue(st.confirm(p.epoch, p.upToSeq))
        val left = st.peek(1000).items
        assertTrue(left.isNotEmpty() && left.all { it.seq > p.upToSeq })
        assertEquals(listOf("c"), left.filterIsInstance<Item.SessionItem>().map { it.session.pkg })
    }

    @Test fun theClockIsReadUnderTheStoreLock() {
        val st = store()
        var held = false
        st.collect(query, { held = Thread.holdsLock(st); t0 + 300_000 }, t0, st.epoch())
        assertTrue("now must be taken after acquiring the lock", held)
    }

    @Test fun storageThatCannotBeReadMakesTheStoreUnavailableInsteadOfFresh() {
        val throwing = object : KvStateStorage.Kv {
            override fun get(key: String): String? = throw java.io.IOException("keystore unavailable")
            override fun put(values: Map<String, String>) = true
        }
        try { UsageStore(KvStateStorage(throwing), day, own); fail("expected the open failure to propagate") } catch (_: java.io.IOException) {}
    }

    @Test fun aColdWindowIsUncertainOnlyUntilItsFirstStop() {
        val st = store()
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0) // events: first STOP at t0 + 1000
        val cov = st.peek(1000).items.filterIsInstance<Item.CoverageItem>().map { Triple(it.fromMs, it.toMs, it.reason) }
        assertEquals(listOf(Triple(t0, t0 + 1_000, "cold_start"), Triple(t0 + 1_000, t0 + 300_000, null)), cov)
    }

    @Test fun aColdWindowWithoutStopIsUncertainWhole() {
        val st = store()
        val noStop: (Long, Long) -> List<Event> = { b, e -> listOf(Event("a", RESUMED, t0 + 10_000), Event("a", PAUSED, t0 + 70_000)).filter { it.ts in b until e } }
        st.collectNow(noStop, now = t0 + 300_000, seedCursor = t0)
        val cov = st.peek(1000).items.filterIsInstance<Item.CoverageItem>().map { Triple(it.fromMs, it.toMs, it.reason) }
        assertEquals(listOf(Triple(t0, t0 + 300_000, "cold_start")), cov)
    }

    @Test fun clockBehindTheCursorCollectsNothingAndMarksTheGap() {
        val st = store()
        st.collectNow(query, now = t0 + 300_000, seedCursor = t0)
        val n = st.peek(1000).items.size
        st.collectNow(query, now = t0 + 100_000, seedCursor = t0) // clock moved back
        val added = st.peek(1000).items.drop(n)
        assertEquals(listOf("clock"), added.filterIsInstance<Item.CoverageItem>().map { it.reason })
        assertTrue(added.none { it is Item.SessionItem })
    }
}
