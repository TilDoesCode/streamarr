package expo.modules.offlinedownloads

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/** Was REPRO_N4_shortQueryPieceShredsTheCapabilityPastTheTokenRule (DL-N-verify4): the verifier's own fuzz, now 0 leaks. */
class RedactionFuzzTest {
  @Test fun streamarrShapedUrlsNeverLeak() = assertEquals(0, leaks(listOf("")))

  @Test fun shortQueriesNeverSplitTheCapability() = assertEquals(0, leaks(listOf("?a", "?1", "?ab1")))

  @Test fun aGluedUrlAndAOneCharQueryKeepNoPartOfTheCapability() {
    val cap = "0123456789" + "abcdef0123456789".repeat(3) + "0123456789abcd"
    val glued = HttpPolicy.diagnosticLine(404, null, null, "see ${cap}https://other.example/x".toByteArray(), false, listOf("http://h/api/v1/offline/$cap"))
    val short = HttpPolicy.diagnosticLine(404, null, null, "unknown download $cap".toByteArray(), false, listOf("http://h/api/v1/offline/$cap?1"))
    for (line in listOf(glued, short)) assertFalse(line, (0..52).any { line.contains(cap.substring(it, it + 12)) })
    assertEquals("HTTP 404 type=none length=unknown body: see [redacted]", glued)
    assertEquals("HTTP 404 type=none length=unknown body: unknown download [redacted]", short)
  }

  private fun leaks(queries: List<String>): Int {
    val random = java.util.Random(4)
    val hex = "0123456789abcdef"
    var leaks = 0
    repeat(1500) {
      val cap = String(CharArray(64) { hex[random.nextInt(16)] })
      val host = listOf("h.example:8096", "10.0.2.2:39320", "[fd00::1]:8080", "lan", "Media.Example")[random.nextInt(5)]
      val query = queries[random.nextInt(queries.size)]
      val prefix = listOf("", "/streamarr")[random.nextInt(2)]
      val url = "${if (random.nextBoolean()) "https" else "http"}://$host$prefix/api/v1/offline/$cap$query"
      val pieces = listOf("<p>", "Not Found", "</p>", " ", "\n", "\t", "\u0000", "é", "{\"error\":", "\"", "/api/v1/offline/$cap", "/api/v1/offline/$cap$query", url,
        cap, cap.uppercase(), "\\/api\\/v1\\/offline\\/$cap", "http://other.example/x?y=$cap", "ref=", "%2F", query.replace("&", "&amp;"), "x".repeat(random.nextInt(300)))
      val out = java.io.ByteArrayOutputStream()
      val target = listOf(64, 200, 1000, 4000, 4090, 5000)[random.nextInt(6)]
      val delimiters = listOf(" ", "\n", "\"", "<", ">", ",", ";", "'")
      while (out.size() < target) {
        out.write(pieces[random.nextInt(pieces.size)].toByteArray(Charsets.UTF_8))
        out.write(delimiters[random.nextInt(delimiters.size)].toByteArray())
      }
      if (random.nextInt(8) == 0) out.write(byteArrayOf(0xff.toByte(), 0xfe.toByte(), 0x80.toByte()))
      val all = out.toByteArray()
      val head = all.copyOf(minOf(all.size, HttpPolicy.DIAGNOSTIC_READ_BYTES))
      val type = listOf(null, "text/html", "application/json; charset=utf-8", "text/plain; url=$url")[random.nextInt(4)]
      val length = if (random.nextBoolean()) all.size.toLong() else -1L
      val urls = listOf(url) + if (random.nextBoolean()) listOf("http://redirect.example/files/$cap") else emptyList()
      val line = HttpPolicy.diagnosticLine(404, type, length, head, all.size > HttpPolicy.DIAGNOSTIC_READ_BYTES, urls).lowercase()
      if ((0..52).any { line.contains(cap.substring(it, it + 12)) }) leaks++
    }
    return leaks
  }
}
