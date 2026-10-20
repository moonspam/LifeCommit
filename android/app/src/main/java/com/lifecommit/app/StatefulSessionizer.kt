package com.lifecommit.app


/**
 * Step 6c-1 (STEP6-DESIGN v3): sessionizer that carries state across query windows, so the result does not depend on
 * where a window is cut. Pure (no android.*); not wired into collection yet — UsageSessionizer stays in use.
 *
 * Window contract: events are those of [state.cursor, windowEnd) (queryEvents' begin is inclusive, so the cursor is the
 * exclusive end of the previous window and no event is replayed).
 */
object StatefulSessionizer {
    enum class Kind { RESUMED, PAUSED, STOP }  // STOP = screen off / keyguard / shutdown
    data class Event(val pkg: String, val kind: Kind, val ts: Long)
    data class Session(val pkg: String, val startMs: Long, val endMs: Long)

    /** PAUSED -> RESUMED of the same app within this gap (inclusive) is one session. */
    const val MERGE_GAP_MS = 2000L

    /**
     * Another app resumed and paused within this time while the open app never paused (e.g. the launcher flashing over a
     * video): the open app keeps its session. ponytail: calibrated on one day of one device (two cases, both <= 2 s by
     * second-resolution timestamps); revisit with more data.
     */
    const val BLIP_MS = 3000L

    data class Open(val pkg: String, val start: Long)
    /** The open app `pkg` (since `start`) was covered by another app at `blipStart`; restored if that app is a blip. */
    data class Suspended(val pkg: String, val start: Long, val blipStart: Long)
    /** A session closed by PAUSED that may still be reopened by a same-app RESUMED within MERGE_GAP_MS. */
    data class Candidate(val pkg: String, val start: Long, val pause: Long)
    /** warm=false: no trusted device state yet (cold start not finished); the next run keeps discarding until a STOP. */
    data class State(val open: Open?, val candidate: Candidate?, val cursor: Long, val lastRunAt: Long, val warm: Boolean = true,
                     val suspended: Suspended? = null)
    /** warmFrom: when `reason` is set, the first STOP that made the device state known again (events from there on were
     *  processed normally); null if the window never warmed */
    data class Result(val sessions: List<Session>, val state: State, val reason: String?, val warmFrom: Long? = null)

    /** Fresh trusted state at `t` (e.g. right after the first cold-start STOP was seen, or for tests). */
    fun emptyState(t: Long) = State(null, null, t, t)

    /**
     * @param state carried state, or null on a cold start (first run, after a reset, after a fallback)
     * @param coverGap the carried state is trusted only if the previous run was at most this long ago
     * @return final whole sessions (own package dropped; midnight parts are laid out by the drain), the state to carry, and a coverage reason
     *   when the window could not be processed from trusted state ("cold_start", "stale_state", "clock")
     */
    fun derive(
        events: List<Event>, state: State?, windowEnd: Long, now: Long,
        coverGap: Long, ownPkg: String,
    ): Result {
        val out = ArrayList<Session>()
        fun emit(pkg: String, start: Long, end: Long) {
            // whole sessions: the drain lays out midnight parts in the device zone and keys them on the session start, so
            // a later zone change cannot change a session's identity
            if (end > start && pkg != ownPkg) out.add(Session(pkg, start, end))
        }

        var open: Open? = null
        var candidate: Candidate? = null
        var suspended: Suspended? = null
        var cold: Boolean
        var reason: String? = null
        var warmFrom: Long? = null
        when {
            state == null || !state.warm -> { cold = true; reason = "cold_start" }
            now < state.cursor || now < state.lastRunAt -> { cold = true; reason = "clock" }
            now - state.lastRunAt > coverGap -> { cold = true; reason = "stale_state" }
            else -> { cold = false; open = state.open; candidate = state.candidate; suspended = state.suspended }
        }
        if (cold && state != null && state.warm) {
            // the candidate is a real closed session; the open one never saw its end, so it is dropped (no multi-day sessions)
            state.candidate?.let { emit(it.pkg, it.start, it.pause) }
            state.suspended?.let { emit(it.pkg, it.start, it.blipStart) } // its end is known: the app that covered it
        }
        fun finalizeSuspended() { suspended?.let { emit(it.pkg, it.start, it.blipStart) }; suspended = null }

        for (e in events) {
            if (cold) {
                if (e.kind == Kind.STOP) { cold = false; warmFrom = e.ts } // from the first STOP on, the device state is known
                continue
            }
            // a candidate whose merge gap has passed can no longer be reopened
            candidate?.let { if (e.ts - it.pause > MERGE_GAP_MS) { emit(it.pkg, it.start, it.pause); candidate = null } }
            // a covering app that lasted longer than a blip: the suspended app really ended when it was covered
            suspended?.let { if (e.ts - it.blipStart > BLIP_MS) finalizeSuspended() }
            when (e.kind) {
                Kind.RESUMED -> {
                    val sp = suspended
                    var mayBlip = true
                    if (sp != null) {
                        if (e.pkg == open?.pkg) continue
                        open?.let { emit(it.pkg, it.start, e.ts) } // the blip
                        open = null
                        suspended = null
                        if (e.pkg == sp.pkg) { open = Open(sp.pkg, sp.start); continue } // back to the covered app
                        emit(sp.pkg, sp.start, sp.blipStart) // a third app: the covered app ended when it was covered
                        mayBlip = false // one level only
                    }
                    val o = open
                    if (o != null && o.pkg == e.pkg) continue
                    if (o != null && mayBlip) { suspended = Suspended(o.pkg, o.start, e.ts); open = Open(e.pkg, e.ts); continue }
                    if (o != null) { emit(o.pkg, o.start, e.ts); open = null }
                    val c = candidate
                    if (c != null && c.pkg == e.pkg && e.ts - c.pause <= MERGE_GAP_MS) {
                        open = Open(e.pkg, c.start) // activity switch inside the same app
                    } else {
                        c?.let { emit(it.pkg, it.start, it.pause) }
                        open = Open(e.pkg, e.ts)
                    }
                    candidate = null
                }
                Kind.PAUSED -> {
                    val sp = suspended
                    if (sp != null) {
                        val o = open
                        if (o != null && o.pkg == e.pkg) { // the covering app left within the blip time: restore
                            emit(o.pkg, o.start, e.ts)
                            open = Open(sp.pkg, sp.start)
                            suspended = null
                        } else if (e.pkg == sp.pkg) {
                            finalizeSuspended()
                        }
                        continue
                    }
                    val o = open
                    if (o != null && o.pkg == e.pkg) {
                        open = null
                        candidate = if (e.ts > o.start) Candidate(o.pkg, o.start, e.ts) else null
                    }
                }
                Kind.STOP -> {
                    finalizeSuspended()
                    open?.let { emit(it.pkg, it.start, e.ts) }
                    candidate?.let { emit(it.pkg, it.start, it.pause) }
                    open = null
                    candidate = null
                }
            }
        }
        // strictly greater: at windowEnd == pause + gap a same-app RESUMED at exactly that time (next window) may still merge
        candidate?.let { if (windowEnd > it.pause + MERGE_GAP_MS) { emit(it.pkg, it.start, it.pause); candidate = null } }
        suspended?.let { if (windowEnd > it.blipStart + BLIP_MS) finalizeSuspended() } // same boundary rule

        // still cold at the end (no STOP seen): nothing trusted to carry, the next run stays a cold start
        val next = if (cold) State(null, null, windowEnd, now, warm = false) else State(open, candidate, windowEnd, now, suspended = suspended)
        return Result(out, next, reason, warmFrom)
    }
}
