package expo.modules.offlinedownloads

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The shared corpus (test-vectors/http-policy.json) that jest and the Swift check run too. */
class HttpPolicyTest {
  @Test
  fun errorBodyBecomesOneTruncatedPrintableLine() {
    assertEquals("{\"code\": \"capability_revoked\"}", HttpPolicy.diagnosticBody("{\"code\":\n\t\"capability_revoked\"}\r\n".toByteArray(), 256))
    val long = HttpPolicy.diagnosticBody(ByteArray(300) { 'x'.code.toByte() }, 256)
    assertEquals(257, long.length)
    assertTrue(long.endsWith("…"))
    assertEquals("a b", HttpPolicy.diagnosticBody(byteArrayOf(0x61, 0x00, 0x1b, 0x62), 256))
  }

  private val corpus: JSONObject by lazy { JSONObject(vectors().readText()) }

  private fun vectors(): File {
    System.getProperty("offlineDownloads.vectors")?.let { return File(it) }
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      listOf("test-vectors/http-policy.json", "client/modules/offline-downloads/test-vectors/http-policy.json", "../test-vectors/http-policy.json")
        .map { File(dir, it) }.firstOrNull { it.isFile }?.let { return it }
      dir = dir.parentFile
    }
    error("test-vectors/http-policy.json not found")
  }

  private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

  private fun JSONObject.longOrNull(key: String): Long? = if (has(key) && !isNull(key)) getLong(key) else null

  @Test
  fun constantsMatchTheCorpus() {
    val constants = corpus.getJSONObject("constants")
    assertEquals(constants.getInt("maxAttempts"), HttpPolicy.MAX_ATTEMPTS)
    assertEquals(constants.getLong("minRetryMs"), HttpPolicy.MIN_RETRY_MS)
    assertEquals(constants.getLong("maxBackoffMs"), HttpPolicy.MAX_BACKOFF_MS)
    assertEquals(constants.getLong("maxRetryAfterMs"), HttpPolicy.MAX_RETRY_AFTER_MS)
    assertEquals(constants.getLong("maxServerWaitMs"), HttpPolicy.MAX_SERVER_WAIT_MS)
    assertEquals(constants.getLong("progressResetsAttemptsBytes"), HttpPolicy.PROGRESS_RESETS_ATTEMPTS_BYTES)
    assertEquals(constants.getLong("reserveBytes"), HttpPolicy.RESERVE_BYTES)
  }

  @Test
  fun statusTable() {
    val status = corpus.getJSONObject("status")
    val retry = status.getJSONArray("retry")
    val fail = status.getJSONArray("fail")
    for (index in 0 until retry.length()) assertTrue("${retry.getInt(index)}", HttpPolicy.retryable(retry.getInt(index)))
    for (index in 0 until fail.length()) assertFalse("${fail.getInt(index)}", HttpPolicy.retryable(fail.getInt(index)))
    for (code in 100..599) assertEquals("$code", code in listOf(408, 425, 429) || code >= 500, HttpPolicy.retryable(code))
  }

  @Test
  fun retryAfterVectors() {
    val retryAfter = corpus.getJSONObject("retryAfter")
    val now = retryAfter.getLong("now")
    for (case in retryAfter.getJSONArray("cases").objects()) {
      val header = if (case.isNull("header")) null else case.getString("header")
      assertEquals("Retry-After '$header'", case.longOrNull("ms"), HttpPolicy.retryAfterMs(header, now))
    }
  }

  @Test
  fun backoffVectors() {
    for (case in corpus.getJSONArray("backoff").objects()) {
      assertEquals(case.getLong("ms"), HttpPolicy.backoffMs(case.getInt("attempts")))
    }
  }

  @Test
  fun retrySequences() {
    for (sequence in corpus.getJSONArray("retrySequences").objects()) {
      val name = sequence.getString("name")
      val start = sequence.getJSONObject("start")
      var attempts = start.getInt("attempts")
      var waitingSince = start.longOrNull("waitingSince")
      for (step in sequence.getJSONArray("steps").objects()) {
        val at = step.getLong("at")
        val status = if (step.has("status")) step.getInt("status") else null
        val retryable = status == null || HttpPolicy.retryable(status)
        val header = if (step.has("retryAfter")) step.getString("retryAfter") else null
        val decision = HttpPolicy.decideRetry(attempts, waitingSince, at, retryable, if (retryable) HttpPolicy.retryAfterMs(header, at) else null, step.getLong("progressBytes"))
        val expect = step.getJSONObject("expect")
        val label = "$name @ $at"
        assertEquals(label, expect.getString("action") == "retry", decision.retry)
        assertEquals(label, expect.getInt("attempts"), decision.attempts)
        assertEquals(label, expect.longOrNull("retryAt"), decision.retryAt)
        assertEquals(label, expect.longOrNull("waitingSince"), decision.waitingSince)
        attempts = decision.attempts
        waitingSince = decision.waitingSince
      }
    }
  }

  @Test
  fun waitRestoreVectors() {
    for (case in corpus.getJSONArray("waitRestore").objects()) {
      val wait = case.getJSONObject("wait")
      val change = case.getJSONObject("change")
      val expect = case.getJSONObject("expect")
      val restored = HttpPolicy.restoreWait(wait.getLong("remainingMs"), wait.getLong("originalMs"), change.getBoolean("sameBoot"), change.getLong("elapsedMs"), change.getLong("wallMs"))
      assertEquals(case.getString("name"), HttpPolicy.Restored(expect.getLong("remainingMs"), expect.getLong("consumedMs")), restored)
    }
  }

  @Test
  fun headerAllowlist() {
    assertEquals(emptyList<String>(), HttpPolicy.disallowedHeaders(mapOf("Accept-Language" to "de", "user-agent" to "x")))
    assertEquals(listOf("Authorization"), HttpPolicy.disallowedHeaders(mapOf("Authorization" to "x", "User-Agent" to "y")))
  }
}
