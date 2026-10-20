package com.lifecommit.app

import android.content.Context
import android.content.Intent
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "AccessibilityPlugin")
class AccessibilityPlugin : Plugin() {

    companion object {
        private var instance: AccessibilityPlugin? = null

        fun emitEvent(event: JSObject) {
            instance?.notifyListeners("accessibilityEvent", event)
        }
    }

    override fun load() {
        instance = this
    }

    @PluginMethod
    fun getServiceStatus(call: PluginCall) {
        val context = context
        val isRunning = AccessibilityState.isRunning
        val isEnabled = isAccessibilityServiceEnabled(context) || isRunning

        val ret = JSObject().apply {
            put("isEnabled", isEnabled)
            put("isRunning", isRunning)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun openAccessibilitySettings(call: PluginCall) {
        try {
            val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to open accessibility settings", e)
        }
    }

    // 버퍼를 읽기만 하고 지우지 않는다 (peek). JS 쪽이 SQLite에 안전하게 커밋한
    // 뒤에만 confirmFlush()를 호출해 버퍼를 지우도록 하여, 커밋 실패나 프로세스
    // 종료로 인한 이벤트 유실을 막는다. upToSeq는 이번에 반환된 이벤트들 중
    // 가장 큰 시퀀스 ID로, confirmFlush 호출 시 그대로 되돌려줘야 한다.
    @PluginMethod
    fun flushBufferedEvents(call: PluginCall) {
        val result = NativeEventBuffer.peek(context)

        val ret = JSObject().apply {
            put("events", result.events)
            put("upToSeq", result.upToSeq)
        }
        call.resolve(ret)
    }

    // JS 쪽이 flushBufferedEvents()로 받은 이벤트를 SQLite 트랜잭션에 성공적으로
    // 커밋한 뒤에만, 그때 받았던 upToSeq 값과 함께 호출해야 한다. 실패 시
    // 호출하지 않으면 다음 플러시 주기에 동일 이벤트가 그대로 재시도된다.
    //
    // 버퍼를 통째로 "[]"로 비우거나 개수(count)로 앞부분을 잘라내지 않고, 각
    // 이벤트 자신의 시퀀스 ID가 upToSeq 이하인 것만 "현재" 버퍼에서 제거한다
    // (NativeEventBuffer.confirmTrim). 개수 기반 트림은 peek과 confirmFlush
    // 사이에 append()가 용량 제한으로 오래된 항목을 evict해 리스트가 재구성되면
    // "몇 번째까지"의 의미가 깨지지만, seq 기반 트림은 이벤트의 정체성으로
    // 판단하므로 eviction이나 동시 append 여부와 무관하게 항상 정확하다.
    @PluginMethod
    fun confirmFlush(call: PluginCall) {
        val upToSeq = call.longArg("upToSeq") ?: 0L // getLong would turn every small seq into 0 (nothing trimmed)
        NativeEventBuffer.confirmTrim(context, upToSeq)
        call.resolve()
    }

    @PluginMethod
    fun updateNoiseFilters(call: PluginCall) {
        try {
            val packagesArray = call.getArray("packages")
            val packages = mutableListOf<String>()
            for (i in 0 until packagesArray.length()) {
                packages.add(packagesArray.getString(i))
            }
            AccessibilityState.updateCustomNoiseFilters(packages)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Failed to update noise filters", e)
        }
    }

    private fun isAccessibilityServiceEnabled(context: Context): Boolean {
        val servicePackage = context.packageName
        val serviceClass = AccessibilityState.SERVICE_CLASS
        val shortClass = AccessibilityState.SERVICE_SHORT_CLASS // app id may differ from the class package
        
        var accessibilityEnabled = 0
        try {
            accessibilityEnabled = Settings.Secure.getInt(
                context.contentResolver,
                Settings.Secure.ACCESSIBILITY_ENABLED
            )
        } catch (e: Settings.SettingNotFoundException) {
            Log.e("AccessibilityPlugin", "Error finding accessibility settings", e)
        }

        if (accessibilityEnabled == 1) {
            val settingValue = Settings.Secure.getString(
                context.contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
            if (settingValue != null) {
                val splitter = TextUtils.SimpleStringSplitter(':')
                splitter.setString(settingValue)
                while (splitter.hasNext()) {
                    val accessibilityService = splitter.next()
                    // com.lifecommit.app/.LifeCommitAccessibilityService 형태와 풀 경로 형태 모두 통과
                    if (accessibilityService.contains(servicePackage, ignoreCase = true) && 
                        (accessibilityService.contains(serviceClass, ignoreCase = true) || 
                         accessibilityService.contains(shortClass, ignoreCase = true))) {
                        return true
                    }
                }
            }
        }
        return false
    }
}
