package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Candidate
import com.lifecommit.app.StatefulSessionizer.Open
import com.lifecommit.app.StatefulSessionizer.Session
import com.lifecommit.app.UsageStore.Item
import com.lifecommit.app.UsageStore.StoreState
import org.junit.Assert.assertEquals
import org.junit.Test

class UsageStoreCodecTest {
    @Test fun aBlobWrittenBeforeSuspendedExistedStillDecodes() {
        val old = """{"v":1,"epoch":0,"nextSeq":5,"cursor":10,"session":{"cursor":10,"lastRunAt":10,"warm":true,"open":{"pkg":"a","start":3}},"queue":[]}"""
        val st = UsageStoreCodec.decode(old)
        assertEquals(StatefulSessionizer.State(Open("a", 3), null, 10, 10), st.session)
        assertEquals(null, st.lastFailure)
    }

    @Test fun roundTripsEveryField() {
        val full = StoreState(
            epoch = 3, nextSeq = 42,
            queue = listOf(Item.SessionItem(40, Session("a", 1, 2)), Item.CoverageItem(41, 5, 9, "stale_state"), Item.CoverageItem(39, 1, 2, null)),
            session = StatefulSessionizer.State(Open("b", 7), Candidate("c", 3, 4), cursor = 10, lastRunAt = 11, warm = true),
            cursor = 10, lastFailure = "query_failed",
        )
        assertEquals(full, UsageStoreCodec.decode(UsageStoreCodec.encode(full)))
        val empty = StoreState()
        assertEquals(empty, UsageStoreCodec.decode(UsageStoreCodec.encode(empty)))
        val suspended = StoreState(session = StatefulSessionizer.State(Open("l", 9), null, 10, 10,
            suspended = StatefulSessionizer.Suspended("a", 1, 9)))
        assertEquals(suspended, UsageStoreCodec.decode(UsageStoreCodec.encode(suspended)))
        val cold = StoreState(session = StatefulSessionizer.State(null, null, 5, 6, warm = false))
        assertEquals(cold, UsageStoreCodec.decode(UsageStoreCodec.encode(cold)))
    }
}
