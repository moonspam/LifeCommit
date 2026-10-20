package com.lifecommit.app

import android.util.Log

/**
 * State shared between the accessibility service (full source set only: it hosts Google Play services location, which
 * the oss build must not bundle) and code both builds compile (AccessibilityPlugin, LifeCommitPlugin).
 */
object AccessibilityState {
    private const val TAG = "LifeCommitAccessibility"
    /** the service class, declared in the full manifest only */
    const val SERVICE_CLASS = "com.lifecommit.app.LifeCommitAccessibilityService"
    const val SERVICE_SHORT_CLASS = ".LifeCommitAccessibilityService"

    @Volatile var isRunning = false

    // 네이티브 레벨 노이즈 필터: 이 패키지들의 이벤트는 JS로 전달하지 않음
    // built-in list (never changes at runtime); the user's filter is a separate set that is REPLACED on every update
    private val DEFAULT_NOISE_PACKAGES = setOf(
        "",                                          // 빈 패키지
        "com.lifecommit.app",                        // 자기 자신 (피드백 루프 차단)
        "com.android.systemui",                      // 상태바, 알림 패널
        "com.google.android.apps.nexuslauncher",     // Pixel 런처
        "com.sec.android.app.launcher",              // 삼성 런처
        "com.miui.home",                             // 샤오미 런처
        "com.huawei.android.launcher",               // 화웨이 런처
        "com.oneplus.launcher",                      // 원플러스 런처
        "com.android.launcher",                      // 기본 런처
        "com.android.launcher3",                     // AOSP 런처
        "android",                                   // 시스템 프로세스
        "com.android.inputmethod.latin",             // AOSP 키보드
        "com.google.android.inputmethod.latin",      // Gboard
        "com.samsung.android.honeyboard",            // 삼성 키보드
        "com.samsung.android.incallui",              // 삼성 통화 UI
        "com.samsung.android.biometrics.app.setting",// 삼성 생체인증 UI
        "com.samsung.android.authframework",         // 삼성 인증 프레임워크
        "com.google.android.projection.gearhead",    // 안드로이드 오토 (중요)
        "com.android.bluetooth",                     // 블루투스 시스템
        "com.skt.tmap.ku",                           // 티맵
        "com.locnall.KimGiSa",                       // 카카오내비
        "com.nhn.android.nmap",                      // 네이버 지도
        "com.google.android.apps.maps"               // 구글 지도
    )

    // derived cache of the DB filter (app_settings): replaced, so a package removed from the filter is collected again
    @Volatile private var customNoisePackages: Set<String> = emptySet()

    fun updateCustomNoiseFilters(packages: List<String>) {
        customNoisePackages = packages.toSet()
        Log.d(TAG, "Custom noise filters replaced: ${packages.size} packages")
    }

    fun isNoise(packageName: String) = packageName in DEFAULT_NOISE_PACKAGES || packageName in customNoisePackages
}
