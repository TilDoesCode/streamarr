package expo.modules.offlinedownloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HttpPolicyTest {
  @Test
  fun clientErrorsFailAtOnce() {
    for (status in listOf(400, 401, 403, 404, 409, 410, 416, 451)) assertFalse("$status", HttpPolicy.retryable(status))
  }

  @Test
  fun throttlingAndServerErrorsRetry() {
    for (status in listOf(408, 425, 429, 500, 501, 502, 503, 504, 507, 599)) assertTrue("$status", HttpPolicy.retryable(status))
  }

  @Test
  fun retryAfterReadsSecondsAndDates() {
    val now = 1_793_995_200_000L
    assertEquals(40_000L, HttpPolicy.retryAfterMs("40", now))
    assertEquals(0L, HttpPolicy.retryAfterMs(" 0 ", now))
    assertEquals(90_000L, HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 20:01:30 GMT", now))
    assertEquals(0L, HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 19:59:00 GMT", now))
  }

  @Test
  fun retryAfterIsCappedAndIgnoresGarbage() {
    assertEquals(HttpPolicy.MAX_RETRY_AFTER_MS, HttpPolicy.retryAfterMs("86400"))
    assertEquals(HttpPolicy.MAX_RETRY_AFTER_MS, HttpPolicy.retryAfterMs("99999999999999999999"))
    assertNull(HttpPolicy.retryAfterMs("soon"))
    assertNull(HttpPolicy.retryAfterMs("-5"))
    assertNull(HttpPolicy.retryAfterMs(""))
    assertNull(HttpPolicy.retryAfterMs(null))
  }
}
