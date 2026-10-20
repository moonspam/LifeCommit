package com.lifecommit.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * "답장(REPLY)" 이벤트 발생 시 최근 수신 알림과 매칭하기 위한 단기 캐시.
 * EncryptedSharedPreferences 기반이며, 무한정 쌓이지 않도록 TTL/개수 상한으로
 * 매 쓰기/읽기 시점에 정리(prune)한다.
 */
object NotificationCache {
    private const val PREFS_NAME = "last_notifications_secure"
    private const val KEY_ENTRIES = "entries"
    private const val TTL_MS = 10 * 60 * 1000L // 10분
    private const val MAX_ENTRIES = 200

    fun put(context: Context, packageName: String, title: String, text: String, timestamp: Long) {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val entries = loadEntries(prefs)

        // 동일 패키지+제목 조합이면 최신 내용으로 교체
        val key = "$packageName:$title"
        entries.removeAll { it.optString("key") == key }
        entries.add(JSONObject().apply {
            put("key", key)
            put("packageName", packageName)
            put("title", title)
            put("text", text)
            put("timestamp", timestamp)
        })

        prune(entries, timestamp)
        saveEntries(prefs, entries)
    }

    /** 지정된 시간창(withinMs) 이내의 해당 패키지 최신 알림을 반환 (없으면 null). */
    fun getLatestForPackage(context: Context, packageName: String, now: Long, withinMs: Long): JSONObject? {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val entries = loadEntries(prefs)
        prune(entries, now)
        saveEntries(prefs, entries)

        return entries
            .filter { it.optString("packageName") == packageName }
            .filter { now - it.optLong("timestamp", 0L) <= withinMs }
            .maxByOrNull { it.optLong("timestamp", 0L) }
    }

    /**
     * titleHint(현재 열려있는 대화창 제목)로 발신자를 우선 매칭한다. 한 앱에 여러
     * 대화(발신자)의 알림이 시간창 내에 섞여 있을 때 getLatestForPackage가 "그 앱의
     * 가장 최근 알림"을 무조건 고르는 바람에 실제로 답장 중인 대화와 다른 발신자로
     * 잘못 매칭되는 문제를 막기 위함. titleHint가 없거나 일치하는 항목이 없으면
     * 기존 방식(패키지 내 최신)으로 폴백한다.
     */
    fun getLatestForPackage(
        context: Context,
        packageName: String,
        now: Long,
        withinMs: Long,
        titleHint: String?
    ): JSONObject? {
        if (!titleHint.isNullOrBlank()) {
            val prefs = SecurePrefs.get(context, PREFS_NAME)
            val entries = loadEntries(prefs)
            prune(entries, now)
            saveEntries(prefs, entries)

            val hint = titleHint.trim()
            val matched = entries
                .filter { it.optString("packageName") == packageName }
                .filter { now - it.optLong("timestamp", 0L) <= withinMs }
                .filter {
                    val title = it.optString("title")
                    title.isNotBlank() && (hint.contains(title) || title.contains(hint))
                }
                .maxByOrNull { it.optLong("timestamp", 0L) }
            if (matched != null) return matched
        }
        // titleHint 미확보 또는 매칭 실패 시 기존 동작으로 폴백
        return getLatestForPackage(context, packageName, now, withinMs)
    }

    private fun prune(entries: MutableList<JSONObject>, now: Long) {
        entries.removeAll { now - it.optLong("timestamp", 0L) > TTL_MS }
        if (entries.size > MAX_ENTRIES) {
            entries.sortBy { it.optLong("timestamp", 0L) }
            while (entries.size > MAX_ENTRIES) entries.removeAt(0)
        }
    }

    private fun loadEntries(prefs: SharedPreferences): MutableList<JSONObject> {
        val raw = prefs.getString(KEY_ENTRIES, "[]") ?: "[]"
        val arr = JSONArray(raw)
        val list = ArrayList<JSONObject>(arr.length())
        for (i in 0 until arr.length()) list.add(arr.getJSONObject(i))
        return list
    }

    private fun saveEntries(prefs: SharedPreferences, entries: List<JSONObject>) {
        val arr = JSONArray()
        entries.forEach { arr.put(it) }
        prefs.edit().putString(KEY_ENTRIES, arr.toString()).apply()
    }
}
