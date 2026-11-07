package expo.modules.offlinedownloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** C2-07: the engine clock for JS is monotonic and its boot id never changes within a process. */
class ClockTest {
  @Test fun elapsedIsMonotonicAndTheBootIdStableWithinAProcess() {
    var reads = 0
    val clock = BootClock({ System.nanoTime() / 1_000_000 }, { 7 }, { reads++; if (reads == 1) "5f3c1d2e-boot" else "changed" })
    val samples = (0 until 2_000).map { clock.now() }
    val elapsed = samples.map { it["elapsedMs"] as Double }
    assertTrue("monotonic", elapsed.zipWithNext().all { (a, b) -> b >= a })
    assertTrue(samples.all { it["bootId"] == "5f3c1d2e-boot" })
    assertEquals(1, reads)
    assertEquals("5f3c1d2e-boot", clock.known)
  }

  @Test fun theBootCounterThenAProcessIdStandInWithoutTheKernelId() {
    val counted = BootClock({ 1L }, { 12 }, { null })
    assertEquals("boot-count-12", counted.now()["bootId"])
    var failures = 0
    val unknown = BootClock({ 1L }, { failures++; null }, { throw SecurityException("denied") ; })
    val id = runCatching { unknown.bootId }.getOrElse { "threw" }
    assertTrue(id, id.startsWith("process-"))
    assertEquals(id, unknown.now()["bootId"])
    assertEquals(null, unknown.known)
    assertEquals(1, failures)
  }
}
