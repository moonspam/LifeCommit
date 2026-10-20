package com.lifecommit.app

import com.lifecommit.app.StatefulSessionizer.Event

/** Collect at the store's current epoch (the epoch guard itself is tested in UsageStoreTest). */
fun UsageStore.collectNow(query: (Long, Long) -> List<Event>?, now: Long, seedCursor: Long, permitted: Boolean = true) =
    collect(query, now, seedCursor, epoch(), permitted)
