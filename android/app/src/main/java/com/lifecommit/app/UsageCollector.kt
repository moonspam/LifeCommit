package com.lifecommit.app

import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.os.Build
import android.os.Process
import android.util.Log
import com.lifecommit.app.StatefulSessionizer.Event
import com.lifecommit.app.StatefulSessionizer.Kind

/** Encrypted prefs as the key-value backing of KvStateStorage. The prefs handle is built once. */
class SecurePrefsKv(private val context: Context) : KvStateStorage.Kv {
    private val prefs by lazy { SecurePrefs.get(context, PREFS) }

    override fun get(key: String): String? = prefs.getString(key, null)

    override fun put(values: Map<String, String>): Boolean {
        values[KvStateStorage.KEY]?.let { Log.d(TAG, "usage store write: ${it.length} chars") } // the queue is not capped
        val e = prefs.edit()
        for ((k, v) in values) e.putString(k, v)
        return e.commit() // returned as-is, no retry here
    }

    companion object {
        private const val TAG = "UsageStore"
        private const val PREFS = "lifecommit_usage_store"
    }
}

/**
 * The single UsageStore instance (one store, one lock) shared by the plugin and the periodic job (UsageJobService),
 * both in the app process.
 */
object UsageCollector {
    /** Carried session state is trusted only if the previous run was at most this long ago (operational assumption). */
    const val COVER_GAP_MS = 24 * 3600_000L

    @Volatile private var store: UsageStore? = null

    fun store(context: Context): UsageStore =
        store ?: synchronized(this) {
            store ?: UsageStore(KvStateStorage(SecurePrefsKv(context.applicationContext)), COVER_GAP_MS, context.packageName).also { store = it }
        }

    /** App sync: one collection run, seeding the store if it has no cursor. A null query result (user locked) is a failure. */
    fun collect(context: Context, seedCursor: Long, expectedEpoch: Long): Boolean =
        store(context).collect(query(context), System::currentTimeMillis, seedCursor, expectedEpoch, isUsageAccessGranted(context))

    /** Periodic job: continue from the store's cursor; never seeds (no cursor -> nothing). */
    fun collectIfStarted(context: Context, shouldContinue: () -> Boolean): Boolean =
        store(context).collectIfStarted(query(context), System::currentTimeMillis, isUsageAccessGranted(context), shouldContinue)

    fun isUsageAccessGranted(ctx: Context): Boolean {
        val ops = ctx.getSystemService(Context.APP_OPS_SERVICE) as? AppOpsManager ?: return false
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ops.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        } else {
            @Suppress("DEPRECATION") ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    /** queryEvents [begin, end) mapped to sessionizer events. */
    private fun query(context: Context): (Long, Long) -> List<Event>? {
        val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
        return { begin, end ->
            usm.queryEvents(begin, end)?.let { raw ->
                val out = ArrayList<Event>()
                val e = UsageEvents.Event()
                while (raw.hasNextEvent()) {
                    raw.getNextEvent(e)
                    // numeric ids: 1 foreground, 2 background, 16 screen off, 17 keyguard shown, 26 shutdown
                    val kind = when (e.eventType) {
                        1 -> Kind.RESUMED
                        2 -> Kind.PAUSED
                        16, 17, 26 -> Kind.STOP
                        else -> null
                    } ?: continue
                    out.add(Event(e.packageName ?: "", kind, e.timeStamp))
                }
                out
            }
        }
    }
}
