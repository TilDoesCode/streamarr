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
  fun diagnosticLinesRedactAndTruncateLikeTheCorpus() {
    val cases = corpus.getJSONArray("diagnostics").objects()
    assertTrue(cases.size >= 10)
    for (case in cases) {
      val urls = case.getJSONArray("requestUrls").let { array -> (0 until array.length()).map { array.getString(it) } }
      val line = HttpPolicy.diagnosticLine(
        case.getInt("status"),
        if (case.isNull("contentType")) null else case.getString("contentType"),
        if (case.isNull("length")) null else case.getLong("length"),
        case.getString("body").toByteArray(Charsets.UTF_8),
        case.getBoolean("cut"),
        urls,
      )
      assertEquals(case.getString("name"), case.getString("expect"), line)
    }
  }

  /** N4-01: the generated cases of the corpus (see its `redactionFuzz._comment`), the same lines as jest and Swift. */
  @Test
  fun redactionFuzzLeaksNothingAndMatchesTheCorpusDigest() {
    val spec = corpus.getJSONObject("redactionFuzz")
    var x = spec.getLong("seed").toInt()
    fun int(n: Int): Int {
      x = x xor (x shl 13)
      x = x xor (x ushr 17)
      x = x xor (x shl 5)
      return ((x.toLong() and 0xffffffffL) % n).toInt()
    }
    fun strings(key: String) = spec.getJSONArray(key).let { array -> (0 until array.length()).map { if (array.isNull(it)) null else array.getString(it) } }
    val hex = spec.getString("hex")
    val chars = spec.getString("queryChars")
    val hosts = strings("hosts")
    val prefixes = strings("prefixes")
    val pieces = strings("pieces")
    val delimiters = strings("delimiters")
    val types = strings("contentTypes")
    val targets = spec.getJSONArray("targets").let { array -> (0 until array.length()).map { array.getInt(it) } }
    val readBytes = spec.getInt("readBytes")
    val lines = ArrayList<String>()
    var leaks = 0
    repeat(spec.getInt("cases")) {
      val cap = String(CharArray(64) { hex[int(16)] })
      val host = hosts[int(hosts.size)]
      val q = int(4)
      val query = if (q == 0) "" else "?" + String(CharArray(q) { chars[int(chars.length)] })
      val prefix = prefixes[int(prefixes.size)]
      val scheme = if (int(2) == 0) "https" else "http"
      val path = "/api/v1/offline/$cap"
      val url = "$scheme://$host$prefix$path$query"
      val values = linkedMapOf("path" to path, "query" to query, "url" to url, "cap" to cap, "CAP" to cap.uppercase(), "filler" to "x".repeat(int(300)))
      fun fill(template: String) = values.entries.fold(template) { text, (key, value) -> text.replace("{$key}", value) }
      val target = targets[int(targets.size)]
      val body = java.io.ByteArrayOutputStream()
      while (body.size() < target) {
        body.write(fill(pieces[int(pieces.size)]!!).toByteArray(Charsets.UTF_8))
        body.write(delimiters[int(delimiters.size)]!!.toByteArray(Charsets.UTF_8))
      }
      if (int(8) == 0) body.write(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0x80.toByte()))
      val all = body.toByteArray()
      val type = types[int(types.size)]?.let(::fill)
      val length = if (int(2) == 0) all.size.toLong() else -1L
      val urls = if (int(2) == 0) listOf(url, fill(spec.getString("redirect"))) else listOf(url)
      val line = HttpPolicy.diagnosticLine(spec.getInt("status"), type, length, all.copyOf(minOf(all.size, readBytes)), all.size > readBytes, urls)
      if ((0..52).any { line.lowercase().contains(cap.substring(it, it + 12)) }) leaks++
      lines += line
    }
    assertEquals(HttpPolicy.DIAGNOSTIC_READ_BYTES, readBytes)
    assertEquals(0, leaks)
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(lines.joinToString("\n").toByteArray(Charsets.UTF_8))
    assertEquals(spec.getString("digest"), digest.joinToString("") { "%02x".format(it) })
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
