package expo.modules.offlinedownloads

import expo.modules.offlinedownloads.Fixtures.Fixture
import expo.modules.offlinedownloads.Fixtures.partial
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.Test

/** Verifier repros (DL-N-verify1) turned around: each asserts the correct outcome of the actual Transfer.kt. */
class TransferTest {
  companion object {
    @JvmStatic @BeforeClass fun setUp() = Fixtures.install()
  }

  data class Response(val total: Long?, val etag: String?, val fromZero: Boolean, val restarted: Boolean, val partLength: Long)

  data class Result(val outcome: Outcome, val part: File, val target: File, val responses: List<Response>)

  private fun run(
    name: String,
    fixture: Fixture,
    prefix: String = "AAAA",
    known: Long? = 8,
    expected: Long? = 8,
    etag: String? = "\"a\"",
    pinned: String? = null,
    headers: Map<String, String> = emptyMap(),
    url: String = Fixtures.url(name),
    space: SpaceGuard = SpaceGuard { _, _ -> null },
  ): Result {
    Fixtures.responses[name] = fixture
    Fixtures.requests.remove(name)
    val root = Fixtures.work(name)
    val target = File(root, "movie.bin")
    val part = File(root, "movie.bin.part").apply { writeText(prefix) }
    var outcome: Outcome? = null
    val responses = mutableListOf<Response>()
    Transfer(name, url, headers, part, expected, pinned, etag, known, space, object : TransferListener {
      override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) {
        responses += Response(totalBytes, etag, fromZero, restarted, part.length())
      }
      override fun onEnded(transfer: Transfer, outcome: Outcome) = setOutcome(outcome)
      private fun setOutcome(value: Outcome) { outcome = value }
    }).run()
    val final = outcome!!
    val recorded = responses.lastOrNull()?.takeIf { it.fromZero }?.etag ?: etag
    if (final is Outcome.Ready) Publisher.publish(part, target, final.total, expected, final.etag, pinned, recorded)
    return Result(final, part, target, responses)
  }

  private fun sent(name: String, header: String): String? = Fixtures.requests[name]?.firstOrNull()?.get(header)

  private fun Outcome.failed(): Outcome.Failed = this as? Outcome.Failed ?: error("expected Failed, got $this")

  @Test fun normal206AppendsAndPublishes() {
    val result = run("normal", partial("bytes 4-7/8"))
    assertEquals(Outcome.Ready(8, "\"a\""), result.outcome)
    assertEquals("AAAABBBB", result.target.readText())
    assertEquals("bytes=4-", sent("normal", "Range"))
    assertEquals("\"a\"", sent("normal", "If-Range"))
  }

  @Test fun resume200StartsOverAndTruncatesBeforeTheNewValidatorIsReported() {
    val result = run("restart", Fixture(200, mapOf("ETag" to "\"b\""), "CCCCDDDD".toByteArray()))
    assertEquals(Outcome.Ready(8, "\"b\""), result.outcome)
    assertEquals("CCCCDDDD", result.target.readText())
    assertEquals(listOf(Response(8, "\"b\"", fromZero = true, restarted = true, partLength = 0)), result.responses)
  }

  @Test fun wrongStartDropsThePartial() {
    val result = run("wrong-start", partial("bytes 3-6/8"))
    assertTrue(result.outcome.failed().droppedPartial)
    assertEquals(0, result.part.length())
    assertFalse(result.target.exists())
  }

  @Test fun changedEtagDropsThePartial() {
    val result = run("changed", partial("bytes 4-7/8", "\"b\""))
    assertEquals("network", result.outcome.failed().error.kind)
    assertTrue(result.outcome.failed().retryable)
    assertEquals(0, result.part.length())
  }

  /** Was BUG_missingEtagAppendsAndPublishesMixedBytes (N1-01). */
  @Test fun missingEtagWithPinnedValidatorFailsAndDrops() {
    val result = run("missing-etag", partial("bytes 4-7/8", null), pinned = "\"a\"")
    assertEquals("validator_changed", result.outcome.failed().error.kind)
    assertEquals(0, result.part.length())
    assertFalse(result.target.exists())
  }

  @Test fun missingEtagWithoutPinnedValidatorRestartsFromZero() {
    val result = run("missing-etag-free", partial("bytes 4-7/8", null))
    val failed = result.outcome.failed()
    assertTrue(failed.retryable && failed.droppedPartial && failed.retryAfterMs == null)
    assertEquals(0, result.part.length())
  }

  /** Was BUG_unknownRangeTotalAppends. */
  @Test fun unknownRangeTotalIsRejected() {
    val result = run("unknown-total", partial("bytes 4-7/*"))
    assertTrue(result.outcome.failed().droppedPartial)
    assertFalse(result.target.exists())
  }

  /** Was BUG_changedKnownTotalAppendsWithoutExpectedBytes. */
  @Test fun changedTotalIsRejectedEvenWithoutExpectedBytes() {
    val result = run("changed-total", partial("bytes 4-8/9", body = "BBBBB"), expected = null)
    assertTrue(result.outcome.failed().droppedPartial)
    assertFalse(result.target.exists())
  }

  /** Was BUG_invalidRangeEndIgnored. */
  @Test fun invalidRangeEndIsRejected() {
    assertTrue(run("bad-end", partial("bytes 4-2/8")).outcome.failed().droppedPartial)
    assertTrue(run("short-end", partial("bytes 4-6/8", body = "BBB")).outcome.failed().droppedPartial)
  }

  @Test fun rangeTotalMustMatchExpectedBytes() {
    val result = run("expected-total", partial("bytes 4-7/8"), known = null, expected = 9)
    assertEquals("size_mismatch", result.outcome.failed().error.kind)
    assertEquals(0, result.part.length())
  }

  /** Was BUG_weakValidatorWithLastModifiedAppends: a weak ETag never resumes; the request starts at 0. */
  @Test fun weakValidatorNeverResumes() {
    val result = run("weak", Fixture(200, mapOf("ETag" to "W/\"a\""), "CCCCDDDD".toByteArray()), etag = "W/\"a\"")
    assertNull(sent("weak", "Range"))
    assertNull(sent("weak", "If-Range"))
    assertEquals(Outcome.Ready(8, null), result.outcome)
    assertEquals("CCCCDDDD", result.target.readText())
  }

  @Test fun range416FailsAndDropsThePartial() {
    val failed = run("range416", Fixture(416, mapOf("Content-Range" to "bytes */3"), byteArrayOf())).outcome.failed()
    assertEquals(416, failed.error.httpStatus)
    assertFalse(failed.retryable)
  }

  /** Was BUG_416CanCompletePartDespiteExpectedSizeMismatch (N1-04). */
  @Test fun every416FailsEvenForAMatchingPart() {
    val result = run("range416-complete", Fixture(416, mapOf("Content-Range" to "bytes */4"), byteArrayOf()))
    assertEquals(416, result.outcome.failed().error.httpStatus)
    assertEquals(0, result.part.length())
    assertFalse(result.target.exists())
  }

  /** Was BUG_completePartBypassesExpectedBytesAndValidatorAndNetwork: a complete part is re-validated over the network. */
  @Test fun completePartIsRevalidatedThroughItsLastByte() {
    val refused = run("complete-part", Fixture(403, emptyMap(), byteArrayOf()), prefix = "GARBAGE!", expected = 9, pinned = "\"different\"")
    assertEquals(403, refused.outcome.failed().error.httpStatus)
    assertEquals("bytes=7-", sent("complete-part", "Range"))
    assertFalse(refused.target.exists())

    val valid = run("complete-part-ok", partial("bytes 7-7/8", body = "Z"), prefix = "AAAAAAAA")
    assertEquals(Outcome.Ready(8, "\"a\""), valid.outcome)
    assertEquals("AAAAAAAZ", valid.target.readText())
  }

  @Test fun bodyLongerThanTheTotalFails() {
    val result = run("overflow", partial("bytes 4-7/8", body = "BBBBBB"))
    assertEquals("size_mismatch", result.outcome.failed().error.kind)
    assertFalse(result.target.exists())
  }

  @Test fun disk_fullBeforeWritingKeepsThePartial() {
    val result = run("space", partial("bytes 4-7/8"), space = { _, _ -> DownloadError("disk_full", "full") })
    assertEquals("disk_full", result.outcome.failed().error.kind)
    assertEquals("AAAA", result.part.readText())
  }

  /** Was BUG_retryAfterOverflowBecomesZero (N1-09). */
  @Test fun hugeRetryAfterCapsAtOneHour() {
    assertEquals(HttpPolicy.MAX_RETRY_AFTER_MS, HttpPolicy.retryAfterMs("9223372036854776"))
    assertEquals(HttpPolicy.MAX_RETRY_AFTER_MS, HttpPolicy.retryAfterMs("9223372036854775807"))
  }

  /** Was BUG_dateGarbageSuffixAccepted. */
  @Test fun dateWithTrailingGarbageIsRejected() {
    assertNull(HttpPolicy.retryAfterMs("Fri, 06 Nov 2026 20:00:40 GMT garbage", 1_793_995_200_000))
  }

  @Test fun sameOriginRedirectKeepsHeaders() {
    Fixtures.responses["same/moved"] = partial("bytes 4-7/8")
    val result = run("same", Fixture(302, mapOf("Location" to "/moved"), byteArrayOf()), headers = mapOf("Accept-Language" to "de"))
    assertEquals(Outcome.Ready(8, "\"a\""), result.outcome)
    assertEquals(2, Fixtures.requests["same"]?.size)
    assertEquals("de", Fixtures.requests["same"]?.last()?.get("Accept-Language"))
  }

  /** Was BUG_crossHostRedirectForwardsCustomCredentialHeaderOnHostJDK (fixture variant; the live one is below). */
  @Test fun crossOriginRedirectDropsCallerHeaders() {
    Fixtures.responses["cross-target"] = partial("bytes 4-7/8")
    Fixtures.requests.remove("cross-target")
    val result = run("cross", Fixture(307, mapOf("Location" to Fixtures.url("cross-target")), byteArrayOf()), headers = mapOf("X-Capability-Key" to "secret"))
    assertEquals(Outcome.Ready(8, "\"a\""), result.outcome)
    assertEquals("secret", sent("cross", "X-Capability-Key"))
    assertNull(Fixtures.requests["cross-target"]?.single()?.get("X-Capability-Key"))
    assertEquals("bytes=4-", Fixtures.requests["cross-target"]?.single()?.get("Range"))
  }

  @Test fun httpToHttpsUpgradeIsFollowed() {
    Fixtures.responses["upgrade-target"] = partial("bytes 4-7/8")
    val result = run("upgrade", Fixture(301, mapOf("Location" to Fixtures.url("upgrade-target", scheme = "https")), byteArrayOf()))
    assertEquals(Outcome.Ready(8, "\"a\""), result.outcome)
  }

  @Test fun schemeChangingRedirectIsRefused() {
    val failed = run("downgrade", Fixture(302, mapOf("Location" to Fixtures.url("downgrade-target")), byteArrayOf()), url = Fixtures.url("downgrade", scheme = "https")).outcome.failed()
    assertEquals("network", failed.error.kind)
    assertFalse(failed.retryable)
  }

  private val server = System.getProperty("harness.rangeServer")

  private fun serverUp(): Boolean = runCatching { URL("$server/admin/log").readText(); true }.getOrDefault(false)

  @Test fun liveRangeServerResumeAndHash() {
    if (!serverUp()) return println("SKIP liveRangeServerResumeAndHash: no Range server at $server")
    val url = "$server/f/1048576/harness.bin"
    val conn = URL(url).openConnection() as HttpURLConnection
    val original = conn.inputStream.use { it.readBytes() }
    val etag = conn.getHeaderField("ETag")
    conn.disconnect()
    val root = Fixtures.work("server")
    val target = File(root, "movie.bin")
    val part = File(root, "movie.bin.part").apply { writeBytes(original.copyOf(123456)) }
    var outcome: Outcome? = null
    Transfer("server", url, emptyMap(), part, original.size.toLong(), etag, etag, original.size.toLong(), { _, _ -> null }, object : TransferListener {
      override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) {}
      override fun onEnded(transfer: Transfer, outcome: Outcome) { setOutcome(outcome) }
      private fun setOutcome(value: Outcome) { outcome = value }
    }).run()
    val ready = outcome as Outcome.Ready
    assertTrue(Publisher.publish(part, target, ready.total, original.size.toLong(), ready.etag, etag, etag) is Outcome.Ready)
    assertArrayEquals(original, target.readBytes())
    println("Range server: resumed at 123456; SHA-256=" + Files.sha256(target))
  }

  /** Was BUG_processDeathAfter200MetadataPersistPublishesMixedFile (N1-02): the child dies after the new validator was persisted. */
  @Test fun processDeathAfter200NeverPublishesMixedBytes() {
    if (!serverUp()) return println("SKIP processDeathAfter200NeverPublishesMixedBytes: no Range server at $server")
    val url = "$server/f/1048576/crash.bin"
    URL("$server/admin/variant?name=crash.bin&variant=a").readText()
    val initial = URL(url).openConnection() as HttpURLConnection
    val original = initial.inputStream.use { it.readBytes() }
    val oldEtag = initial.getHeaderField("ETag")
    initial.disconnect()
    val root = Fixtures.work("process-death")
    val target = File(root, "movie.bin")
    val part = File(root, "movie.bin.part").apply { writeBytes(original.copyOf(123456)) }
    URL("$server/admin/variant?name=crash.bin&variant=b").readText()
    val changed = URL(url).readBytes()
    val child = ProcessBuilder(File(System.getProperty("java.home"), "bin/java").path, "-cp", System.getProperty("harness.classpath"),
      "expo.modules.offlinedownloads.CrashWorker", root.path, url, oldEtag).redirectErrorStream(true).start()
    assertTrue(child.waitFor(20, TimeUnit.SECONDS))
    assertEquals(child.inputStream.bufferedReader().readText(), 0, child.exitValue())
    val record = TaskStore(File(root, "state")).load().tasks.single()
    assertTrue(record.etag != oldEtag)
    assertEquals("the part was truncated before the validator was persisted", 0L, part.length())
    var outcome: Outcome? = null
    Transfer("crash", url, emptyMap(), part, record.expectedBytes, null, record.etag, record.totalBytes, { _, _ -> null }, object : TransferListener {
      override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) {}
      override fun onEnded(transfer: Transfer, outcome: Outcome) { setOutcome(outcome) }
      private fun setOutcome(value: Outcome) { outcome = value }
    }).run()
    val ready = outcome as Outcome.Ready
    assertTrue(Publisher.publish(part, target, ready.total, record.expectedBytes, ready.etag, null, record.etag) is Outcome.Ready)
    assertArrayEquals("the published file is entirely the new version", changed, target.readBytes())
    URL("$server/admin/variant?name=crash.bin&variant=a").readText()
  }

  /** Live variant of the credential repro: 127.0.0.1 → localhost must not carry the caller's header (N1-12). */
  @Test fun liveCrossHostRedirectDropsCallerHeaders() {
    if (!serverUp()) return println("SKIP liveCrossHostRedirectDropsCallerHeaders: no Range server at $server")
    val root = Fixtures.work("redirect")
    val target = File(root, "movie.bin")
    val part = File(root, "movie.bin.part")
    var outcome: Outcome? = null
    Transfer("redirect", "$server/__verify/redirect", mapOf("X-Capability-Key" to "dummy-harness-secret"), part, null, null, null, null, { _, _ -> null },
      object : TransferListener {
        override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) {}
        override fun onEnded(transfer: Transfer, outcome: Outcome) { setOutcome(outcome) }
        private fun setOutcome(value: Outcome) { outcome = value }
      }).run()
    val ready = outcome as Outcome.Ready
    assertTrue(Publisher.publish(part, target, ready.total, null, ready.etag, null, null) is Outcome.Ready)
    val headers = JSONObject(target.readText())
    assertTrue(headers.getString("host").startsWith("localhost:"))
    assertFalse(headers.has("x-capability-key"))
  }
}
