package com.lifecommit.app

import android.Manifest
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.getcapacitor.JSArray
import java.io.File
import java.io.FileOutputStream

@CapacitorPlugin(
    name = "LifeCommitPlugin",
    permissions = [
        Permission(
            alias = "notifications",
            strings = [Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class LifeCommitPlugin : Plugin() {

    /**
     * 안드로이드 시스템 권한 및 배터리 최적화 제외 상태 확인
     */
    @PluginMethod
    fun checkSystemPermissions(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")

        val ret = JSObject()

        // 1. 접근성 서비스 상태
        val isAccessibilityEnabled = isAccessibilityServiceEnabled(ctx)
        ret.put("accessibility", isAccessibilityEnabled)

        // 2. 알림 접근 리스너 권한 상태
        val isNotificationListenerEnabled = NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.packageName)
        ret.put("notification", isNotificationListenerEnabled)

        // 3. 배터리 최적화 제외(무제한) 상태
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val isBatteryUnrestricted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && pm != null) {
            pm.isIgnoringBatteryOptimizations(ctx.packageName)
        } else {
            true
        }
        ret.put("battery", isBatteryUnrestricted)

        // 4. 위치(GPS) 권한 상태
        val isLocationGranted = ContextCompat.checkSelfPermission(
            ctx,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        ret.put("location", isLocationGranted)
        // optional (full): "always" can only be chosen in system settings since Android 11; contacts only names calls/SMS
        ret.put("locationAlways", ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)
        ret.put("contacts", ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED)

        // 5. 사용 정보 접근(UsageStatsManager) 상태
        ret.put("usage", isUsageAccessGranted(ctx))
        ret.put("flavor", BuildConfig.FLAVOR)

        // 6. 알림 전송 권한 (Android 13+) 및 매일 알림 활성화 상태
        val isPostNotificationGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        ret.put("postNotifications", isPostNotificationGranted)
        ret.put("dailyReminder", DailyReminder.isEnabled(ctx))

        call.resolve(ret)
    }

    @PluginMethod
    fun getDailyReminderSettings(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        val ret = JSObject()
        ret.put("enabled", DailyReminder.isEnabled(ctx))
        val hasPermission = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        ret.put("hasPermission", hasPermission)
        ret.put("asked", DailyReminder.hasAskedNotificationPermission(ctx))
        call.resolve(ret)
    }

    @PluginMethod
    fun setDailyReminderEnabled(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        val enabled = call.getBoolean("enabled", true) ?: true
        DailyReminder.setEnabled(ctx, enabled)
        val ret = JSObject()
        ret.put("enabled", enabled)
        call.resolve(ret)
    }

    @PluginMethod
    fun requestNotificationPermission(call: PluginCall) {
        val ctx = context
        if (ctx != null) {
            DailyReminder.setAskedNotificationPermission(ctx, true)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            requestPermissionForAlias("notifications", call, "notificationsCallback")
        } else {
            val ret = JSObject()
            ret.put("granted", true)
            call.resolve(ret)
        }
    }

    @PermissionCallback
    private fun notificationsCallback(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
        val ret = JSObject()
        ret.put("granted", granted)
        call.resolve(ret)
    }

    private fun isUsageAccessGranted(ctx: Context) = UsageCollector.isUsageAccessGranted(ctx)

    /**
     * 해당 시스템 설정 화면으로 바로 이동
     */
    @PluginMethod
    fun openSystemSetting(call: PluginCall) {
        val act = activity ?: return call.reject("Activity is null")
        val type = call.getString("type") ?: "app_info"

        try {
            when (type) {
                "accessibility" -> {
                    val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    act.startActivity(intent)
                }
                "notification" -> {
                    val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    act.startActivity(intent)
                }
                "usage" -> {
                    val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).apply {
                        data = Uri.parse("package:${act.packageName}")
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                    act.startActivity(intent)
                }
                "battery" -> {
                    try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                            val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                                data = Uri.parse("package:${act.packageName}")
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            act.startActivity(intent)
                        } else {
                            openAppDetails(act)
                        }
                    } catch (e: Exception) {
                        // 2차 폴백: 배터리 최적화 목록 화면 열기
                        try {
                            val intent = Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).apply {
                                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                            }
                            act.startActivity(intent)
                        } catch (e2: Exception) {
                            openAppDetails(act)
                        }
                    }
                }
                else -> {
                    openAppDetails(act)
                }
            }

            call.resolve(JSObject().put("success", true))
        } catch (e: Exception) {
            // 최종 폴백: 앱 상세 정보 화면으로 열기
            try {
                openAppDetails(act)
                call.resolve(JSObject().put("success", true))
            } catch (fallbackErr: Exception) {
                call.reject("설정 화면 열기 실패: ${e.message}")
            }
        }
    }

    private fun openAppDetails(act: android.app.Activity) {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
            data = Uri.parse("package:${act.packageName}")
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        act.startActivity(intent)
    }

    /**
     * JSON 백업 파일을 기기에 저장하고 공유 다이얼로그(카카오톡, 드라이브 등) 호출
     */
    @PluginMethod
    fun exportBackupFile(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        val filename = call.getString("filename") ?: "lifecommit_backup.json"
        // a bare file name only: no path separators or parent references (the file must stay in cache/backups/)
        if (filename.isEmpty() || filename.contains('/') || filename.contains('\\') || filename.contains("..")) return call.reject("invalid filename")
        val content = call.getString("content") ?: ""

        try {
            // 앱 전용 캐시 디렉터리에만 저장 (다른 앱/USB-MTP로 노출되는 공용 다운로드
            // 폴더에는 쓰지 않는다 - GPS/통화/문자 등 민감 데이터를 담은 백업이므로
            // 사용자가 공유 다이얼로그로 명시적으로 보낸 대상에게만 전달되어야 한다)
            val exportDir = File(ctx.cacheDir, "backups").apply { if (!exists()) mkdirs() }

            // 오래된 백업 파일 정리 (앱 전용 캐시에 누적되지 않도록)
            try {
                exportDir.listFiles()?.forEach { it.delete() }
            } catch (ignored: Exception) {}

            val backupFile = File(exportDir, filename)

            FileOutputStream(backupFile).use { fos ->
                fos.write(content.toByteArray(Charsets.UTF_8))
            }

            // FileProvider를 통한 공유 인텐트 발행
            val contentUri = FileProvider.getUriForFile(
                ctx,
                "${ctx.packageName}.fileprovider",
                backupFile
            )

            val shareIntent = Intent(Intent.ACTION_SEND).apply {
                type = "application/json"
                putExtra(Intent.EXTRA_STREAM, contentUri)
                putExtra(Intent.EXTRA_SUBJECT, "LifeCommit Backup: $filename")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }

            val chooser = Intent.createChooser(shareIntent, "백업 파일 저장 및 공유").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            ctx.startActivity(chooser)

            val ret = JSObject()
            ret.put("success", true)
            ret.put("path", backupFile.absolutePath)
            ret.put("filename", filename)
            call.resolve(ret)
        } catch (e: Exception) {
            call.reject("백업 파일 내보내기 실패: ${e.message}")
        }
    }

    /**
     * 앱의 실제 최초 설치 시각을 반환한다. 재설치 시에는 값이 새로 갱신되므로,
     * raw_events가 비어 있는 최초/재설치 상태에서 동기화 커서의 하한선(floor)으로
     * 사용하면 기기에 남아있던 설치 이전 통화/문자/사진 이력이 통째로 유입되는
     * 것을 막을 수 있다.
     */
    @PluginMethod
    fun getInstallTime(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        try {
            val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
            call.resolve(JSObject().put("installTime", info.firstInstallTime))
        } catch (e: Exception) {
            call.reject("Failed to read install time: ${e.message}", e)
        }
    }

    // ── native usage store (Step 6c-3): the JS sync drains its queue ──

    /** Every usage-store call: store open/load failures and write failures reject instead of escaping the bridge. */
    private inline fun withUsageStore(call: PluginCall, block: (Context, UsageStore) -> JSObject) {
        val ctx = context ?: return call.reject("Context is null")
        try {
            call.resolve(block(ctx, UsageCollector.store(ctx)))
        } catch (e: UsageStore.WriteFailed) {
            call.reject("write_failed", e)
        } catch (e: Exception) {
            call.reject("store_unavailable: ${e.message}", e)
        }
    }

    /** Collect into the native queue. seedCursor = window start when the store has no cursor; it was chosen for expectedEpoch. */
    @PluginMethod
    fun collectUsage(call: PluginCall) {
        val seed = call.longArg("seedCursor") ?: return call.reject("seedCursor is required")
        val expected = call.longArg("expectedEpoch") ?: return call.reject("expectedEpoch is required")
        withUsageStore(call) { ctx, store ->
            val collected = UsageCollector.collect(ctx, seed, expected)
            val st = store.snapshot()
            JSObject().put("collected", collected).put("epoch", st.epoch).put("queued", st.queue.size).put("lastFailure", st.lastFailure)
        }
    }

    @PluginMethod
    fun peekUsage(call: PluginCall) = withUsageStore(call) { ctx, store ->
        val p = store.peek(call.getInt("max") ?: 500)
        val pm = ctx.packageManager
        val labels = HashMap<String, String?>()
        val arr = JSArray()
        for (it in p.items) {
            when (it) {
                is UsageStore.Item.SessionItem -> {
                    val label = labels.getOrPut(it.session.pkg) { appLabel(pm, it.session.pkg) }
                    arr.put(JSObject().put("type", "session").put("seq", it.seq).put("pkg", it.session.pkg).put("label", label)
                        .put("startMs", it.session.startMs).put("endMs", it.session.endMs))
                }
                is UsageStore.Item.CoverageItem -> arr.put(JSObject().put("type", "coverage").put("seq", it.seq)
                    .put("fromMs", it.fromMs).put("toMs", it.toMs).put("reason", it.reason))
            }
        }
        JSObject().put("epoch", p.epoch).put("upToSeq", p.upToSeq).put("items", arr)
    }

    /** null when the app is not visible (uninstalled, or outside oss's launcher <queries>) */
    private fun appLabel(pm: PackageManager, pkg: String): String? =
        try { pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString() } catch (ex: Exception) { null }

    /** Labels as the launcher shows them, for display names the built-in map does not know. */
    @PluginMethod
    fun getAppLabels(call: PluginCall) {
        val pkgs = call.getArray("packages")?.toList<String>() ?: return call.reject("packages is required")
        val pm = context.packageManager
        val out = JSObject()
        for (pkg in pkgs) appLabel(pm, pkg)?.let { out.put(pkg, it) }
        call.resolve(JSObject().put("labels", out))
    }

    @PluginMethod
    fun confirmUsage(call: PluginCall) {
        val epoch = call.longArg("epoch") ?: return call.reject("epoch is required")
        val upTo = call.longArg("upToSeq") ?: return call.reject("upToSeq is required")
        withUsageStore(call) { _, store -> JSObject().put("confirmed", store.confirm(epoch, upTo)) }
    }

    /** reset(target <= epoch) is a no-op (returns reset=false). */
    @PluginMethod
    fun resetUsage(call: PluginCall) {
        val target = call.longArg("target") ?: return call.reject("target is required")
        withUsageStore(call) { _, store -> JSObject().put("reset", store.reset(target)).put("epoch", store.epoch()) }
    }

    @PluginMethod
    fun usageEpoch(call: PluginCall) = withUsageStore(call) { _, store -> JSObject().put("epoch", store.epoch()) }

    /**
     * DB 파일이 물리적으로 손상되어 재생성(wipe)이 필요하다고 판단된 경우,
     * 삭제 전에 .db/-wal/-shm 파일을 캐시 디렉터리로 백업한다.
     */
    @PluginMethod
    fun backupCorruptDatabase(call: PluginCall) {
        val ctx = context ?: return call.reject("Context is null")
        val dbFileName = call.getString("database") ?: return call.reject("database is required")

        try {
            val dbFile = ctx.getDatabasePath(dbFileName)
            val backupDir = File(ctx.cacheDir, "corrupt_db_backups/${System.currentTimeMillis()}").apply { mkdirs() }

            var backedUp = 0
            for (suffix in listOf("", "-wal", "-shm")) {
                val src = File(dbFile.absolutePath + suffix)
                if (src.exists()) {
                    src.copyTo(File(backupDir, dbFileName + suffix), overwrite = true)
                    backedUp++
                }
            }

            call.resolve(JSObject().put("success", true).put("path", backupDir.absolutePath).put("filesBackedUp", backedUp))
        } catch (e: Exception) {
            call.reject("Failed to back up corrupt database: ${e.message}", e)
        }
    }

    /**
     * 접근성 서비스 활성화 여부 확인 헬퍼
     */
    private fun isAccessibilityServiceEnabled(context: Context): Boolean {
        val expectedServiceName = "${context.packageName}/${AccessibilityState.SERVICE_CLASS}"
        val enabledServices = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false

        return enabledServices.split(":").any {
            it.equals(expectedServiceName, ignoreCase = true) || it.contains(context.packageName)
        }
    }
}
