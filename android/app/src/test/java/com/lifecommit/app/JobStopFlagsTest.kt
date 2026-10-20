package com.lifecommit.app

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JobStopFlagsTest {
    @Test fun aStopFromASeparateCallReachesTheRunByItsId() {
        val f = JobStopFlags()
        val run = f.start(6001)
        f.stop(6001) // the system's onStopJob carries another JobParameters object: only the id matches
        assertTrue(run.get())
    }

    @Test fun anOldRunFinishingDoesNotClearANewRunsFlag() {
        val f = JobStopFlags()
        val a = f.start(6001)
        f.stop(6001)
        val b = f.start(6001) // restarted
        f.finish(6001, a) // the old thread finishes late
        f.stop(6001)
        assertTrue(b.get())
    }

    @Test fun stopWithoutARunDoesNothing() {
        val f = JobStopFlags()
        f.stop(6001)
        assertFalse(f.start(6001).get())
    }
}
