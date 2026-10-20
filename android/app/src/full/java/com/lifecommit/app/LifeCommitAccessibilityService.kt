package com.lifecommit.app

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.location.Location
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import org.json.JSONObject

class LifeCommitAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "LifeCommitAccessibility"

        // ── 답장(REPLY) 캡처를 허용할 메신저/메시지 앱 화이트리스트 ──
        // '전송'/'보내기' 버튼은 채팅 앱 밖에서도 흔한 라벨(검색, 로그인, 결제 등)이므로,
        // 이 목록에 없는 앱에서는 직전 입력 텍스트를 답장으로 캡처하지 않는다.
        private val MESSAGING_APP_PACKAGES = setOf(
            "com.kakao.talk",                    // 카카오톡
            "com.samsung.android.messaging",     // 삼성 메시지
            "com.google.android.apps.messaging",  // 구글 메시지
            "com.instagram.android",             // 인스타그램 DM
            "com.twitter.android",               // X (트위터) DM
            "com.facebook.katana",               // 페이스북
            "com.facebook.orca",                 // 메신저
            "com.discord",                       // 디스코드
            "org.telegram.messenger",            // 텔레그램
            "com.naver.line",                    // 라인
            "com.slack",                         // 슬랙
            "com.microsoft.teams",               // 팀즈
            "com.google.android.gm",             // 지메일
        )
    }

    private lateinit var fusedLocationClient: FusedLocationProviderClient
    private lateinit var locationCallback: LocationCallback

    // ── 비동기 I/O 전용 단일 스레드 Executor (메인 스레드 프리징/ANR 원천 차단) ──
    private val ioExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()

    // ── 인메모리 버퍼 최적화 변수 ──
    private val memoryBuffer = ArrayList<JSONObject>()
    private val handler = Handler(Looper.getMainLooper())
    private val flushRunnable = object : Runnable {
        override fun run() {
            flushMemoryBufferToDisk()
            handler.postDelayed(this, 60000L) // 1분 주기 플러시
        }
    }

    // ── 실시간 사용자 타이핑 캐시 (패키지별로 분리하여 앱 간 텍스트 오염 방지) ──
    private val lastInputTextByPackage = HashMap<String, String>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.d(TAG, "Accessibility Service Connected")
        AccessibilityState.isRunning = true

        // Fused Location Provider 설정
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this)
        locationCallback = object : LocationCallback() {
            override fun onLocationResult(locationResult: LocationResult) {
                for (location in locationResult.locations) {
                    saveLocationEvent(location)
                }
            }
        }
        startLocationUpdates()

        // 1분 주기 타이머 시작
        handler.postDelayed(flushRunnable, 60000L)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null) return

        try {
            val type = event.eventType
            val packageName = event.packageName?.toString() ?: ""

            if (AccessibilityState.isNoise(packageName) || packageName == this.packageName) { // own app, whatever its id (full is com.lifecommit.app.full)
                return // 노이즈 패키지는 무시
            }

            // 1단계: 사용자가 타이핑 중인 에디트 텍스트 캐싱 (메신저 앱에서만, 패키지별로 분리)
            if (type == AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED && event.className == "android.widget.EditText"
                && MESSAGING_APP_PACKAGES.contains(packageName)) {
                val txt = event.text.joinToString(" ") { it.toString() }.trim()
                if (txt.isNotEmpty()) {
                    lastInputTextByPackage[packageName] = txt
                } else {
                    lastInputTextByPackage.remove(packageName) // erased draft: do not keep it in memory
                }
            }

            // 2단계: 사용자가 '전송' 또는 '보내기' 버튼을 클릭한 액션 감지 (메신저 앱에서만)
            if (type == AccessibilityEvent.TYPE_VIEW_CLICKED && MESSAGING_APP_PACKAGES.contains(packageName)) {
                val viewText = event.text.joinToString(" ") { it.toString() }.trim()
                val desc = event.contentDescription?.toString() ?: ""
                val isSendClick = viewText == "전송" || viewText == "보내기" || desc == "전송" || desc == "보내기"

                val pendingInput = lastInputTextByPackage[packageName]
                if (isSendClick && !pendingInput.isNullOrEmpty()) {
                    // 현재 열려있는 대화창 제목(윈도우 타이틀)을 힌트로 사용해, 같은 앱에서
                    // 여러 발신자의 알림이 시간창 내에 섞여 있어도 실제 답장 중인 대화의
                    // 발신자로 정확히 매칭한다 (없으면 기존처럼 앱 내 최신 알림으로 폴백).
                    val titleHint = try {
                        event.source?.window?.title?.toString()
                    } catch (e: Exception) {
                        null
                    }
                    // 답장 이벤트 생성 및 매칭
                    handleUserReply(packageName, pendingInput, titleHint)
                    lastInputTextByPackage.remove(packageName) // 사용 완료 후 클리어
                    return
                }
            }

            // App usage time comes from UsageStats (UsageJobService), as in oss: accessibility gaps (a video playing,
            // the screen off) cannot tell watching from away. This service only captures replies and hosts location.

        } catch (e: Exception) {
            Log.e(TAG, "Exception in onAccessibilityEvent", e)
        }
    }

    // ── 답장 액션 발생 시 최근 알림 정보 매칭 및 REPLY 이벤트 생성 ──
    private fun handleUserReply(packageName: String, replyMsg: String, titleHint: String? = null) {
        try {
            var sender = "알 수 없음"
            var receivedMsg = "이전 대화"

            // 5분(300,000ms) 이내의 최근 수신 알림만 연동 대상으로 유효 판정
            val now = System.currentTimeMillis()
            val matchLimit = 300000L

            val cachedJson = NotificationCache.getLatestForPackage(this, packageName, now, matchLimit, titleHint)
            if (cachedJson != null) {
                sender = cachedJson.optString("title", "알 수 없음")
                receivedMsg = cachedJson.optString("text", "이전 대화")
            }

            val appLabelStr = try {
                val pm = packageManager
                val appInfo = pm.getApplicationInfo(packageName, 0)
                pm.getApplicationLabel(appInfo).toString()
            } catch (e: Exception) {
                packageName
            }

            // 답장 정보를 가공하기 편하도록 JSON 형태로 패킹
            val replyDetail = JSONObject().apply {
                put("sender", sender)
                put("receivedMsg", receivedMsg)
                put("replyMsg", replyMsg)
            }

            val timestamp = System.currentTimeMillis()
            val obj = JSONObject().apply {
                put("packageName", packageName)
                put("appLabel", appLabelStr)
                put("eventType", "REPLY")
                put("extractedText", replyDetail.toString())
                put("contentDescription", JSONObject.NULL)
                put("timestamp", timestamp)
            }

            // 인메모리 버퍼 및 실시간 웹뷰 통보
            queueEventInMemory(obj)

            val jsObj = JSObject().apply {
                put("packageName", packageName)
                put("appLabel", appLabelStr)
                put("eventType", "REPLY")
                put("extractedText", replyDetail.toString())
                put("contentDescription", JSONObject.NULL)
                put("timestamp", timestamp)
            }
            AccessibilityPlugin.emitEvent(jsObj)
            Log.d(TAG, "Successfully captured REPLY event for package: $packageName")

        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle user reply match", e)
        }
    }

    override fun onInterrupt() {
        Log.d(TAG, "Accessibility Service Interrupted")
    }

    override fun onUnbind(intent: Intent?): Boolean {
        Log.d(TAG, "Accessibility Service Unbound")
        AccessibilityState.isRunning = false
        stopLocationUpdates()
        handler.removeCallbacks(flushRunnable)
        flushMemoryBufferToDisk()
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        Log.d(TAG, "Accessibility Service Destroyed")
        stopLocationUpdates()
        handler.removeCallbacks(flushRunnable)
        flushMemoryBufferToDisk()
        super.onDestroy()
    }

    private fun startLocationUpdates() {
        try {
            val locationRequest = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 180000L).apply {
                setMinUpdateIntervalMillis(90000L)
                // no distance filter: a still phone keeps reporting, so a gap in fixes means collection stopped (lib/today.ts stays)
            }.build()

            fusedLocationClient.requestLocationUpdates(
                locationRequest,
                locationCallback,
                mainLooper
            )
        } catch (e: SecurityException) {
            Log.e(TAG, "Location permission missing for FusedLocationProvider", e)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Fused location updates", e)
        }
    }

    private fun stopLocationUpdates() {
        try {
            if (::fusedLocationClient.isInitialized && ::locationCallback.isInitialized) {
                fusedLocationClient.removeLocationUpdates(locationCallback)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop Fused location updates", e)
        }
    }

    private fun saveLocationEvent(location: Location) {
        try {
            val locObj = JSONObject().apply {
                put("lat", location.latitude)
                put("lng", location.longitude)
                put("accuracy", location.accuracy)
                put("activityType", "UNKNOWN")
            }

            val obj = JSONObject().apply {
                put("packageName", "system.location")
                put("appLabel", "GPS")
                put("eventType", "LOCATION")
                put("extractedText", locObj.toString())
                put("contentDescription", JSONObject.NULL)
                put("timestamp", location.time)
            }

            queueEventInMemory(obj)

            val jsObj = JSObject().apply {
                put("packageName", "system.location")
                put("appLabel", "GPS")
                put("eventType", "LOCATION")
                put("extractedText", locObj.toString())
                put("contentDescription", JSONObject.NULL)
                put("timestamp", location.time)
            }
            AccessibilityPlugin.emitEvent(jsObj)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save location event", e)
        }
    }

    private fun queueEventInMemory(obj: JSONObject) {
        synchronized(memoryBuffer) {
            memoryBuffer.add(obj)
            if (memoryBuffer.size >= 25) {
                ioExecutor.execute { flushMemoryBufferToDisk() }
            }
        }
    }

    private fun flushMemoryBufferToDisk() {
        val itemsToWrite = ArrayList<JSONObject>()
        synchronized(memoryBuffer) {
            if (memoryBuffer.isEmpty()) return
            itemsToWrite.addAll(memoryBuffer)
            memoryBuffer.clear()
        }

        ioExecutor.execute {
            // 모든 버퍼 읽기/쓰기는 NativeEventBuffer를 통해서만 이루어진다 --
            // AccessibilityPlugin.confirmFlush()의 read-modify-write와 이 append가
            // 서로 겹쳐 실행되며 한쪽 결과를 덮어쓰는 것(lost update)을 막기 위함.
            // 자세한 근거는 NativeEventBuffer의 클래스 문서 참고.
            NativeEventBuffer.append(this, itemsToWrite)
        }
    }
}
