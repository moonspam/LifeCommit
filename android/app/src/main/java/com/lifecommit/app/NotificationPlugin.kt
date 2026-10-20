package com.lifecommit.app

import android.content.Intent
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "NotificationPlugin")
class NotificationPlugin : Plugin() {

    @PluginMethod
    fun hasNotificationPermission(call: PluginCall) {
        val packageName = context.packageName
        val enabledPackages = NotificationManagerCompat.getEnabledListenerPackages(context)
        val granted = enabledPackages.contains(packageName)
        val ret = JSObject().apply {
            put("granted", granted)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun openNotificationSettings(call: PluginCall) {
        try {
            val intent = Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            try {
                val intent = Intent(Settings.ACTION_SETTINGS).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(intent)
                call.resolve()
            } catch (ex: Exception) {
                call.reject("Failed to open settings: ${ex.message}", ex)
            }
        }
    }
}
