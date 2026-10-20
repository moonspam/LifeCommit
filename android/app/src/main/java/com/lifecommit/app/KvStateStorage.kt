package com.lifecommit.app

/**
 * UsageStore persisted as ONE key (the whole state is one JSON value, so each write is all-or-nothing).
 * A blob that cannot be decoded (corruption, unknown version) must not stop collection forever: it is copied to a
 * quarantine key and the store starts fresh (no session state -> cold start, lastFailure = "store_corrupt").
 * Pure apart from the Kv interface, so the recovery is JVM-tested.
 */
class KvStateStorage(private val kv: Kv) : UsageStore.StateStorage {
    interface Kv {
        fun get(key: String): String?
        /** all values in one commit; returns the commit result */
        fun put(values: Map<String, String>): Boolean
    }

    override fun load(): UsageStore.StoreState? {
        val raw = kv.get(KEY) ?: return null
        return try {
            UsageStoreCodec.decode(raw)
        } catch (e: Exception) {
            kv.put(mapOf(QUARANTINE_KEY to raw)) // best effort: keep the original for inspection
            UsageStore.StoreState(lastFailure = "store_corrupt")
        }
    }

    override fun write(state: UsageStore.StoreState): Boolean = kv.put(mapOf(KEY to UsageStoreCodec.encode(state)))

    companion object {
        const val KEY = "state"
        const val QUARANTINE_KEY = "state_corrupt"
    }
}
