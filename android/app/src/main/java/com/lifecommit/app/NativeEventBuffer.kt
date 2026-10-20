package com.lifecommit.app

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * SecurePrefs("lifecommit_buffer_secure")의 "events" 키에 대한 모든 읽기/쓰기는
 * 반드시 이 오브젝트를 통해서만 이루어져야 한다.
 *
 * LifeCommitAccessibilityService(백그라운드에서 이벤트를 append)와
 * AccessibilityPlugin(JS 쪽 peek/confirmTrim)이 서로 다른 스레드에서 동시에
 * 이 키에 대해 read-modify-write를 하면, 나중에 쓰는 쪽이 먼저 쓴 쪽의 결과를
 * 통째로 덮어써 그 사이에 추가된 이벤트가 유실될 수 있다 (lost update).
 *
 * 이 오브젝트는 Kotlin object(싱글턴)이므로 @Synchronized가 잡는 모니터는
 * 프로세스 전체에서 단 하나뿐이다. append/peek/confirmTrim 중 한 메서드가
 * 실행되는 동안 다른 모든 호출은 그 메서드가 끝날 때까지 블록되므로 -- JVM의
 * 모니터 락이 상호 배제와 happens-before 가시성을 보장한다 -- 두 read-modify-write
 * 시퀀스가 서로 겹쳐 실행되는 것 자체가 불가능하다.
 *
 * 락만으로는 부족한 지점: confirmTrim이 "몇 건(count)"으로 지울 대상을 지정하면,
 * 그 사이 append()가 새 이벤트를 추가하면서 용량 제한(MAX_BUFFER_SIZE)을 넘겨
 * 가장 오래된 항목을 evict하는 경우 count의 의미가 깨진다 -- peek 시점에는
 * count가 "peek된 접두사"를 가리켰지만, eviction으로 리스트가 재구성된 뒤에는
 * 같은 count가 방금 추가된 새 이벤트까지 포함해버릴 수 있다. 그래서 각 이벤트에
 * 추가 시점에 단조증가하는 시퀀스 ID(SEQ_FIELD)를 부여하고, confirmTrim은 "이
 * 시퀀스 ID 이하인 이벤트"라는 자기 자신의 고유 식별자로 삭제 대상을 판단한다
 * (위치/개수가 아니라 정체성 기준). eviction이 리스트의 위치를 아무리 재배치해도
 * 각 이벤트의 seq 값 자체는 변하지 않으므로, 이 방식은 구조적으로 안전하다.
 */
object NativeEventBuffer {
    private const val TAG = "NativeEventBuffer"
    private const val PREFS_NAME = "lifecommit_buffer_secure"
    private const val KEY = "events"
    private const val SEQ_FIELD = "_seq"

    // SharedPreferences OOM 방지: 최대 500건으로 안전 유지
    private const val MAX_BUFFER_SIZE = 500

    data class PeekResult(val events: String, val upToSeq: Long)

    private fun maxSeqIn(array: JSONArray): Long {
        var maxSeq = 0L
        for (i in 0 until array.length()) {
            val seq = array.optJSONObject(i)?.optLong(SEQ_FIELD, 0L) ?: 0L
            if (seq > maxSeq) maxSeq = seq
        }
        return maxSeq
    }

    @Synchronized
    fun append(context: Context, items: List<JSONObject>) {
        if (items.isEmpty()) return
        try {
            val prefs = SecurePrefs.get(context, PREFS_NAME)
            val current = prefs.getString(KEY, "[]") ?: "[]"
            var array = JSONArray(current)

            // 새 이벤트들에 현재 버퍼 안의 최대 seq 다음 값부터 순서대로 부여한다.
            // 항상 "현재 실제로 저장된" 버퍼를 기준으로 계산하므로 프로세스 재시작
            // 후에도(인메모리 카운터 없이) 안전하게 이어진다.
            var nextSeq = maxSeqIn(array) + 1
            for (item in items) {
                item.put(SEQ_FIELD, nextSeq)
                array.put(item)
                nextSeq += 1
            }

            if (array.length() > MAX_BUFFER_SIZE) {
                val trimmed = JSONArray()
                for (i in array.length() - MAX_BUFFER_SIZE until array.length()) {
                    trimmed.put(array.get(i))
                }
                array = trimmed
            }

            prefs.edit().putString(KEY, array.toString()).commit()
            Log.d(TAG, "Appended ${items.size} events to native buffer.")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to append events to native buffer", e)
        }
    }

    // 버퍼를 읽기만 하고 지우지 않는다 (peek). JS 쪽이 SQLite에 안전하게 커밋한
    // 뒤에만 confirmTrim()을 호출해, 이번 peek에서 받은 이벤트들의 seq(upToSeq)
    // 이하인 항목만 버퍼에서 제거하도록 한다.
    @Synchronized
    fun peek(context: Context): PeekResult {
        val prefs = SecurePrefs.get(context, PREFS_NAME)
        val current = prefs.getString(KEY, "[]") ?: "[]"
        val upToSeq = try {
            maxSeqIn(JSONArray(current))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to compute max sequence id while peeking buffer", e)
            0L
        }
        return PeekResult(current, upToSeq)
    }

    // JS 쪽이 peek()으로 받은 이벤트를 SQLite 트랜잭션에 성공적으로 커밋한 뒤에만
    // 호출해야 한다. peek()이 반환한 upToSeq 이하의 seq를 가진 이벤트만 "현재"
    // 버퍼에서 제거한다 -- 개수(count)가 아니라 이벤트 자신의 seq로 식별하므로,
    // peek과 confirmTrim 사이에 append()가 새 이벤트를 추가하거나 용량 초과로
    // 오래된 항목을 evict해도(리스트의 위치/길이가 바뀌어도) 그 seq <= upToSeq인
    // 항목만 정확히 지워지고, 그보다 큰 seq를 가진(즉 peek 이후에 추가된) 이벤트는
    // 항상 보존된다.
    @Synchronized
    fun confirmTrim(context: Context, upToSeq: Long) {
        try {
            val prefs = SecurePrefs.get(context, PREFS_NAME)
            val current = prefs.getString(KEY, "[]") ?: "[]"
            val array = JSONArray(current)
            val remaining = JSONArray()
            for (i in 0 until array.length()) {
                val item = array.optJSONObject(i) ?: continue
                if (item.optLong(SEQ_FIELD, 0L) > upToSeq) {
                    remaining.put(item)
                }
            }
            prefs.edit().putString(KEY, remaining.toString()).commit()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to trim confirmed events from native buffer", e)
        }
    }
}
