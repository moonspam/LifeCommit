package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Event
import com.lifecommit.app.StatefulSessionizer.Session

/**
 * Step 6c-3 (STEP6-DESIGN v3.1): the native usage queue + collection state. Pure (no android.*), not wired yet.
 *
 * Contract:
 * - `committed` is the only source of truth: the last state whose write returned true. It is loaded once; storage is
 *   never re-read. Every operation computes `next` from `committed` with fresh lists and writes the WHOLE state once.
 *   write()==false -> throw, `committed` unchanged (a retry starts from the same state; content is deterministic, so a
 *   write that persisted but reported false is rewritten identically and seqs are never reused after a restart).
 * - One instance, one lock: every entry point is @Synchronized on this store.
 * - reset(target <= epoch) is a complete no-op (late / duplicate resets cannot wipe a newer generation's queue).
 * - confirm(epoch, upToSeq) is rejected when the epoch differs; it never removes items appended after the peek.
 * - A failed or null query (locked user, no permission) changes nothing except lastFailure; lastRunAt is not touched.
 */
class UsageStore(
    private val storage: StateStorage,
    private val coverGap: Long,
    private val ownPkg: String,
) {
    sealed class Item {
        abstract val seq: Long
        data class SessionItem(override val seq: Long, val session: Session) : Item()
        /** Range the collector processed (or a marker with reason when it could not trust its state). */
        data class CoverageItem(override val seq: Long, val fromMs: Long, val toMs: Long, val reason: String?) : Item()
    }

    data class StoreState(
        val epoch: Long = 0,
        val nextSeq: Long = 1,
        val queue: List<Item> = emptyList(),
        val session: StatefulSessionizer.State? = null,
        val cursor: Long? = null,
        val lastFailure: String? = null,
    )

    interface StateStorage {
        fun load(): StoreState?
        fun write(state: StoreState): Boolean
    }

    data class Peek(val epoch: Long, val upToSeq: Long, val items: List<Item>)

    class WriteFailed : Exception("usage store write failed; state unchanged")

    private var committed: StoreState = storage.load() ?: StoreState()

    @Synchronized fun epoch(): Long = committed.epoch

    @Synchronized fun snapshot(): StoreState = committed

    /**
     * @param query returns the events of [begin, end), or null when the platform returned nothing usable (user locked)
     * @param seedCursor start of the very first window when the store has no cursor (e.g. install time / old JS cursor)
     * @param expectedEpoch the epoch the caller chose seedCursor for; checked under this lock, so a reset that landed
     *   after the caller read the epoch cannot get the old generation's seed
     * @param clock read under this lock: a "now" taken before waiting for the lock could be older than the cursor another
     *   caller just set, which would look like a clock change and drop the open session
     * @return false (nothing written, seed unused) when the epoch moved
     */
    @Synchronized
    fun collect(query: (Long, Long) -> List<Event>?, clock: () -> Long, seedCursor: Long, expectedEpoch: Long, permitted: Boolean = true): Boolean {
        val c = committed
        if (c.epoch != expectedEpoch) return false
        collectChecked(c, query, clock(), seedCursor, permitted)
        return true
    }

    /**
     * The periodic job's collect: it never chooses a seed. Without a cursor (first run, after a reset or a store
     * recovery) it does nothing - the app's sync, which knows the DB's processed mark, starts the store. Checked under
     * the same lock as the app's collect; the clock is read inside it too.
     * @return false when nothing was collected (no cursor)
     */
    @Synchronized
    fun collectIfStarted(query: (Long, Long) -> List<Event>?, clock: () -> Long, permitted: Boolean = true,
                         shouldContinue: () -> Boolean = { true }): Boolean {
        // a job stopped while it waited for this lock must not start a query; a started query finishes its atomic write
        if (!shouldContinue()) return false
        val c = committed
        if (c.cursor == null) return false
        collectChecked(c, query, clock(), c.cursor, permitted)
        return true
    }

    /** Tests: a fixed time. */
    fun collect(query: (Long, Long) -> List<Event>?, now: Long, seedCursor: Long, expectedEpoch: Long, permitted: Boolean = true): Boolean =
        collect(query, { now }, seedCursor, expectedEpoch, permitted)

    private fun collectChecked(c: StoreState, query: (Long, Long) -> List<Event>?, now: Long, seedCursor: Long, permitted: Boolean) {
        if (!permitted) return commit(c.copy(lastFailure = "permission"))
        val begin = c.cursor ?: seedCursor
        val events: List<Event>
        if (begin > now) {
            events = emptyList() // clock went back: derive() reports "clock" and cold-starts
        } else {
            events = query(begin, now) ?: return commit(c.copy(lastFailure = "query_failed"))
        }
        val r = StatefulSessionizer.derive(events.sortedBy { it.ts }, c.session, windowEnd = now, now = now, coverGap = coverGap, ownPkg = ownPkg)
        var seq = c.nextSeq
        val added = ArrayList<Item>()
        for (s in r.sessions) added.add(Item.SessionItem(seq++, s))
        val from = minOf(begin, now)
        val warm = r.warmFrom
        if (r.reason != null && warm != null && warm > from) {
            // only the part before the first STOP is uncertain; the rest of the window was processed normally
            added.add(Item.CoverageItem(seq++, fromMs = from, toMs = warm, reason = r.reason))
            added.add(Item.CoverageItem(seq++, fromMs = warm, toMs = now, reason = null))
        } else {
            added.add(Item.CoverageItem(seq++, fromMs = from, toMs = now, reason = if (r.reason != null && warm == from) null else r.reason))
        }
        commit(c.copy(nextSeq = seq, queue = c.queue.toList() + added, session = r.state, cursor = now, lastFailure = null))
    }

    @Synchronized
    fun peek(max: Int): Peek {
        val items = committed.queue.take(max).toList()
        return Peek(committed.epoch, items.lastOrNull()?.seq ?: 0L, items)
    }

    /** @return false when the epoch is stale (nothing removed) */
    @Synchronized
    fun confirm(epoch: Long, upToSeq: Long): Boolean {
        val c = committed
        if (epoch != c.epoch) return false
        commit(c.copy(queue = c.queue.filter { it.seq > upToSeq }))
        return true
    }

    /** @return false for a no-op (target <= current epoch) */
    @Synchronized
    fun reset(target: Long): Boolean {
        val c = committed
        if (target <= c.epoch) return false
        commit(StoreState(epoch = target, nextSeq = c.nextSeq)) // queue, session and cursor cleared; seq continues
        return true
    }

    private fun commit(next: StoreState) {
        if (!storage.write(next)) throw WriteFailed()
        committed = next
    }
}
