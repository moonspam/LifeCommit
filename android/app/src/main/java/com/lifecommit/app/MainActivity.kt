package com.lifecommit.app

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(AccessibilityPlugin::class.java)
        registerPlugin(CallLogPlugin::class.java)
        registerPlugin(PhotoPlugin::class.java)
        registerPlugin(NotificationPlugin::class.java)
        if (BuildConfig.DEBUG) {
            registerPlugin(DebugPlugin::class.java)
        }
        registerPlugin(LifeCommitPlugin::class.java)
        registerPlugin(KeystorePlugin::class.java)
        super.onCreate(savedInstanceState)
        UsageJobService.ensureScheduled(applicationContext) // both flavors: app usage time comes from UsageStats
    }

    override fun onResume() {
        super.onResume()
        DailyReminder.recordAppOpened(applicationContext)
        DailyReminder.scheduleIfNeeded(applicationContext)
    }
}

