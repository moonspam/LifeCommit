package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Candidate
import com.lifecommit.app.StatefulSessionizer.Open
import com.lifecommit.app.StatefulSessionizer.Session
import com.lifecommit.app.UsageStore.Item
import com.lifecommit.app.UsageStore.StoreState
import org.json.JSONArray
import org.json.JSONObject

/** The whole UsageStore state as ONE JSON value, so a store write is a single key (all-or-nothing per commit()). */
object UsageStoreCodec {
    const val VERSION = 1

    fun encode(s: StoreState): String {
        val o = JSONObject()
        o.put("v", VERSION)
        o.put("epoch", s.epoch)
        o.put("nextSeq", s.nextSeq)
        s.cursor?.let { o.put("cursor", it) }
        s.lastFailure?.let { o.put("lastFailure", it) }
        s.session?.let { st ->
            val j = JSONObject()
            j.put("cursor", st.cursor)
            j.put("lastRunAt", st.lastRunAt)
            j.put("warm", st.warm)
            st.open?.let { j.put("open", JSONObject().put("pkg", it.pkg).put("start", it.start)) }
            st.candidate?.let { j.put("cand", JSONObject().put("pkg", it.pkg).put("start", it.start).put("pause", it.pause)) }
            st.suspended?.let { j.put("susp", JSONObject().put("pkg", it.pkg).put("start", it.start).put("blip", it.blipStart)) }
            o.put("session", j)
        }
        val q = JSONArray()
        for (it in s.queue) {
            when (it) {
                is Item.SessionItem -> q.put(JSONObject().put("t", "s").put("seq", it.seq)
                    .put("pkg", it.session.pkg).put("start", it.session.startMs).put("end", it.session.endMs))
                is Item.CoverageItem -> q.put(JSONObject().put("t", "c").put("seq", it.seq)
                    .put("from", it.fromMs).put("to", it.toMs).also { j -> it.reason?.let { r -> j.put("reason", r) } })
            }
        }
        o.put("queue", q)
        return o.toString()
    }

    fun decode(json: String): StoreState {
        val o = JSONObject(json)
        require(o.optInt("v", 0) == VERSION) { "unknown usage store version ${o.opt("v")}" }
        val session = o.optJSONObject("session")?.let { j ->
            StatefulSessionizer.State(
                open = j.optJSONObject("open")?.let { Open(it.getString("pkg"), it.getLong("start")) },
                candidate = j.optJSONObject("cand")?.let { Candidate(it.getString("pkg"), it.getLong("start"), it.getLong("pause")) },
                cursor = j.getLong("cursor"),
                lastRunAt = j.getLong("lastRunAt"),
                warm = j.optBoolean("warm", true),
                // optional (added after v1 shipped): an older blob simply has none
                suspended = j.optJSONObject("susp")?.let { StatefulSessionizer.Suspended(it.getString("pkg"), it.getLong("start"), it.getLong("blip")) },
            )
        }
        val q = o.getJSONArray("queue")
        val items = ArrayList<Item>(q.length())
        for (i in 0 until q.length()) {
            val j = q.getJSONObject(i)
            items.add(when (j.getString("t")) {
                "s" -> Item.SessionItem(j.getLong("seq"), Session(j.getString("pkg"), j.getLong("start"), j.getLong("end")))
                "c" -> Item.CoverageItem(j.getLong("seq"), j.getLong("from"), j.getLong("to"), if (j.has("reason")) j.getString("reason") else null)
                else -> error("unknown item type ${j.getString("t")}")
            })
        }
        return StoreState(
            epoch = o.getLong("epoch"),
            nextSeq = o.getLong("nextSeq"),
            queue = items,
            session = session,
            cursor = if (o.has("cursor")) o.getLong("cursor") else null,
            lastFailure = if (o.has("lastFailure")) o.getString("lastFailure") else null,
        )
    }
}
