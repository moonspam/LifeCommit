package com.lifecommit.app

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.util.Log

/**
 * Step 6d: periodic usage collection while the app is closed (oss only - the service is declared in the oss manifest).
 * Calls UsageCollector.collectIfStarted only: never seeds, never touches SQLite; the app's sync drains the queue.
 * Runs in the app process (no android:process), so it shares the one store and its lock with the plugin.
 * Doze / app standby / force-stop can delay or stop it: continuity is not claimed (gaps show as "수집 확인 불가", 6e).
 */
/**
 * Stop flags keyed by job id: onStopJob receives a JobParameters object re-created from a Parcel, not the one passed to
 * onStartJob (no equals), so the id is the only link. Each run keeps its own flag; finish removes the entry only if it
 * still holds that run's flag, so an old run cannot clear a newer one's.
 */
class JobStopFlags {
    private val flags = java.util.concurrent.ConcurrentHashMap<Int, java.util.concurrent.atomic.AtomicBoolean>()
    fun start(id: Int) = java.util.concurrent.atomic.AtomicBoolean(false).also { flags[id] = it }
    fun stop(id: Int) { flags[id]?.set(true) }
    fun finish(id: Int, flag: java.util.concurrent.atomic.AtomicBoolean) { flags.remove(id, flag) }
}

class UsageJobService : JobService() {
    private val stopFlags = JobStopFlags()

    override fun onStartJob(params: JobParameters): Boolean {
        val stopped = stopFlags.start(params.jobId)
        Thread {
            try {
                val collected = UsageCollector.collectIfStarted(applicationContext) { !stopped.get() }
                Log.d(TAG, "periodic collect: ${if (collected) "done" else "skipped (no cursor yet)"}")
            } catch (e: Exception) {
                Log.w(TAG, "periodic collect failed", e) // WriteFailed / keystore: state unchanged, next run retries
            }

            try {
                DailyReminder.scheduleIfNeeded(applicationContext)
            } catch (e: Exception) {
                Log.w(TAG, "schedule daily reminder failed", e)
            } finally {
                stopFlags.finish(params.jobId, stopped)
                if (!stopped.get()) jobFinished(params, false) // after onStopJob the system already ended the job
            }
        }.start()
        return true
    }

    // stops the run before it queries (checked under the store lock); a write already started completes atomically.
    // false: no reschedule needed, the periodic job continues from the cursor next time
    override fun onStopJob(params: JobParameters): Boolean {
        stopFlags.stop(params.jobId)
        return false
    }

    companion object {
        private const val TAG = "UsageJob"
        const val JOB_ID = 6_001
        private const val PERIOD_MS = 6 * 3600_000L
        private const val FLEX_MS = 3600_000L

        /** Called at every app start (oss): schedules only if not pending, so the period timer is not restarted. */
        fun ensureScheduled(context: Context) {
            try {
                val js = context.getSystemService(Context.JOB_SCHEDULER_SERVICE) as JobScheduler
                if (js.getPendingJob(JOB_ID) != null) return
                val job = JobInfo.Builder(JOB_ID, ComponentName(context, UsageJobService::class.java))
                    .setPeriodic(PERIOD_MS, FLEX_MS)
                    .setPersisted(true) // survives a reboot: needs RECEIVE_BOOT_COMPLETED (oss manifest)
                    .build()
                Log.d(TAG, "scheduled: ${js.schedule(job) == JobScheduler.RESULT_SUCCESS}")
            } catch (e: Exception) {
                Log.w(TAG, "scheduling failed", e) // never a FATAL at launch
            }
        }
    }
}
