package com.lifecommit.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class KvStateStorageTest {
    private class MapKv(val m: MutableMap<String, String> = HashMap()) : KvStateStorage.Kv {
        override fun get(key: String) = m[key]
        override fun put(values: Map<String, String>): Boolean { m.putAll(values); return true }
    }

    @Test fun garbageBlobLoadsAsAFreshStateAndIsQuarantined() {
        val kv = MapKv(mutableMapOf(KvStateStorage.KEY to "{not json"))
        val st = KvStateStorage(kv).load()!!
        assertEquals(UsageStore.StoreState(lastFailure = "store_corrupt"), st)
        assertNull("no carried session: the next run cold-starts", st.session)
        assertEquals("{not json", kv.m[KvStateStorage.QUARANTINE_KEY])
        // a store built on it keeps working
        val store = UsageStore(KvStateStorage(kv), 24 * 3600_000L, "own")
        store.collectNow({ _, _ -> emptyList() }, now = 10_000, seedCursor = 1_000)
        assertEquals(null, store.snapshot().lastFailure)
        assertEquals("{not json", kv.m[KvStateStorage.QUARANTINE_KEY])
    }

    @Test fun unknownVersionIsTreatedAsCorrupt() {
        val kv = MapKv(mutableMapOf(KvStateStorage.KEY to """{"v":99,"epoch":1,"nextSeq":1,"queue":[]}"""))
        assertEquals("store_corrupt", KvStateStorage(kv).load()!!.lastFailure)
    }

    @Test fun roundTripsThroughTheKv() {
        val kv = MapKv()
        val s = UsageStore.StoreState(epoch = 2, nextSeq = 9, cursor = 5)
        KvStateStorage(kv).write(s)
        assertEquals(s, KvStateStorage(kv).load())
        assertNull(KvStateStorage(MapKv()).load())
    }
}
