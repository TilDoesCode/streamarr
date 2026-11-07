package expo.modules.offlinedownloads

import java.util.Calendar
import java.util.TimeZone

/** Status table, Retry-After and retry decisions; mirrored in http-policy.ts and HttpPolicy.swift (test-vectors/http-policy.json). */
object HttpPolicy {
  const val DIAGNOSTIC_READ_BYTES = 4096
  const val DIAGNOSTIC_BODY_CHARS = 128
  private const val DIAGNOSTIC_TYPE_CHARS = 64
  private const val REDACTED = "[redacted]"
  /** The whole run of scheme characters: a URL glued to a token takes the token with it (N4-01). */
  private val ABSOLUTE_URL = Regex("""[A-Za-z0-9+.-]+://[^ ]*""")
  private const val MIN_GLOBAL_PIECE = 8
  private val LONG_TOKEN = Regex("""[A-Za-z0-9._~%-]{24,}""")
  private val TRAILING_TOKEN = Regex("""[A-Za-z0-9._~%-]+$""")

  /** An error answer as one log line, never content: request URL parts, URLs and long tokens redacted, `cut` drops a partial last token (N3-07). */
  fun diagnosticLine(status: Int, contentType: String?, length: Long?, body: ByteArray?, cut: Boolean, requestUrls: List<String>): String {
    var text = printable(body ?: ByteArray(0))
    if (cut) text = text.replace(TRAILING_TOKEN, "").trim()
    text = redact(text, requestUrls)
    val shown = if (text.isEmpty()) "none" else if (text.length > DIAGNOSTIC_BODY_CHARS) text.take(DIAGNOSTIC_BODY_CHARS) + "…" else text
    val type = contentType?.let { redact(printable(it.toByteArray(Charsets.UTF_8)), requestUrls).take(DIAGNOSTIC_TYPE_CHARS) }?.ifEmpty { null } ?: "none"
    val size = length?.takeIf { it >= 0 }?.toString() ?: "unknown"
    return "HTTP $status type=$type length=$size body: $shown"
  }

  /** Bytes 0x20..0x7e kept, every other byte a space; runs of spaces collapsed, trimmed. */
  private fun printable(bytes: ByteArray): String {
    val chars = CharArray(bytes.size) { index -> bytes[index].toInt().and(0xff).let { if (it in 0x20..0x7e) it.toChar() else ' ' } }
    return String(chars).split(' ').filter { it.isNotEmpty() }.joinToString(" ")
  }

  /** URLs, then long tokens, then the request URL's pieces: 8+ chars anywhere, shorter ones only as a whole token (N4-01). */
  private fun redact(text: String, requestUrls: List<String>): String {
    var out = LONG_TOKEN.replace(ABSOLUTE_URL.replace(text, REDACTED), REDACTED)
    // Longest first, ties by text: the order is fixed on every platform.
    for (piece in requestUrls.flatMap { urlPieces(it) }.distinct().sortedWith(compareBy({ -it.length }, { it }))) {
      out = if (piece.length >= MIN_GLOBAL_PIECE) out.replace(piece, REDACTED) else replaceWhole(out, piece)
    }
    return out
  }

  /** Occurrences with no token character right before or after them. */
  private fun replaceWhole(text: String, piece: String): String {
    val out = StringBuilder()
    var from = 0
    while (true) {
      val at = text.indexOf(piece, from)
      if (at < 0) return out.append(text, from, text.length).toString()
      val end = at + piece.length
      if ((at == 0 || !isToken(text[at - 1])) && (end == text.length || !isToken(text[end]))) {
        out.append(text, from, at).append(REDACTED)
        from = end
      } else {
        out.append(text, from, at + 1)
        from = at + 1
      }
    }
  }

  private fun isToken(c: Char) = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c in "._~%-"

  /** The URL, its path with query and its path (each unless just `/`) and its query, split by hand so both platforms agree. */
  private fun urlPieces(url: String): List<String> {
    if (url.isEmpty()) return emptyList()
    val scheme = url.indexOf("://").let { if (it < 0) 0 else it + 3 }
    val pathStart = url.indexOf('/', scheme).let { if (it < 0) url.length else it }
    val rest = url.substring(pathStart).substringBefore('#')
    val path = rest.substringBefore('?')
    val query = if ('?' in rest) rest.substringAfter('?') else ""
    return listOf(url, rest.takeIf { it.length > 1 } ?: "", path.takeIf { it.length > 1 } ?: "", query).filter { it.isNotEmpty() }
  }

  const val MAX_ATTEMPTS = 8
  const val MIN_RETRY_MS = 2_000L
  const val MAX_BACKOFF_MS = 60_000L
  const val MAX_RETRY_AFTER_MS = 60L * 60 * 1000
  const val MAX_SERVER_WAIT_MS = 12L * 60 * 60 * 1000
  const val PROGRESS_RESETS_ATTEMPTS_BYTES = 1L shl 20
  const val RESERVE_BYTES = 64L * 1024 * 1024
  val ALLOWED_HEADERS = setOf("accept-language", "user-agent")

  private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
  private val IMF_FIXDATE = Regex("""^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$""")
  private val DIGITS = Regex("""^\d+$""")

  /** True: retry natively (honouring Retry-After). False: fail at once with kind `http`. */
  fun retryable(status: Int): Boolean = status == 408 || status == 425 || status == 429 || status in 500..599

  /** Retry-After (delta-seconds or IMF-fixdate) as the wait in ms, 2 s … 1 h; null when absent or invalid. */
  fun retryAfterMs(header: String?, nowMs: Long = System.currentTimeMillis()): Long? {
    val value = header?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val ms = if (DIGITS.matches(value)) {
      // Leading zeroes carry no magnitude; clamp before multiplying so huge values cannot overflow (N2-09).
      val digits = value.trimStart('0').ifEmpty { "0" }
      if (digits.length > 7) MAX_RETRY_AFTER_MS else digits.toLong() * 1000
    } else {
      (httpDate(value) ?: return null) - nowMs
    }
    return ms.coerceIn(MIN_RETRY_MS, MAX_RETRY_AFTER_MS)
  }

  /** Epoch ms of a strict IMF-fixdate, null for anything else or an impossible date. */
  private fun httpDate(value: String): Long? {
    val match = IMF_FIXDATE.matchEntire(value) ?: return null
    val (day, monthName, year, hour, minute, second) = match.destructured
    val month = MONTHS.indexOf(monthName)
    val d = day.toInt()
    if (month < 0 || hour.toInt() > 23 || minute.toInt() > 59 || second.toInt() > 59 || d < 1) return null
    val calendar = Calendar.getInstance(TimeZone.getTimeZone("GMT")).apply {
      clear()
      isLenient = false
      set(year.toInt(), month, d, hour.toInt(), minute.toInt(), second.toInt())
    }
    return runCatching { calendar.timeInMillis }.getOrNull()
  }

  /** Wait after the n-th ordinary failed attempt: 2 s, 4 s, … 60 s. */
  fun backoffMs(attempts: Int): Long = minOf(MAX_BACKOFF_MS, MIN_RETRY_MS shl (attempts - 1).coerceIn(0, 10))

  data class Decision(val retry: Boolean, val attempts: Int, val waitingSince: Long?, val retryAt: Long?)

  /** What a failed attempt does to a task (same rules on iOS and in the fake); times on the elapsed clock (N2-04). */
  fun decideRetry(attempts: Int, waitingSince: Long?, now: Long, retryable: Boolean, retryAfterMs: Long?, progressBytes: Long): Decision {
    var count = if (progressBytes >= PROGRESS_RESETS_ATTEMPTS_BYTES) 0 else attempts
    val since = if (progressBytes > 0) null else waitingSince
    if (!retryable) return Decision(false, count + 1, since, null)
    if (retryAfterMs != null) {
      val start = since ?: now
      val retryAt = now + retryAfterMs
      return if (retryAt - start > MAX_SERVER_WAIT_MS) Decision(false, count, start, null) else Decision(true, count, start, retryAt)
    }
    count += 1
    if (count >= MAX_ATTEMPTS) return Decision(false, count, since, null)
    return Decision(true, count, since, now + backoffMs(count))
  }

  data class Restored(val remainingMs: Long, val consumedMs: Long)

  /** A persisted wait after a restart: elapsed time on the same boot, else the wall clock may only shorten it (N2-04). */
  fun restoreWait(remainingMs: Long, originalMs: Long, sameBoot: Boolean, elapsedMs: Long, wallMs: Long): Restored {
    val saved = remainingMs.coerceIn(0, originalMs.coerceAtLeast(0))
    val remaining = if (sameBoot && elapsedMs >= 0) saved - elapsedMs else minOf(saved, saved - wallMs)
    val restored = remaining.coerceIn(0, originalMs.coerceAtLeast(0))
    return Restored(restored, saved - restored)
  }

  /** Header names outside the allowlist (capability URLs need no headers; a redirect may leave the origin). */
  fun disallowedHeaders(headers: Map<String, String>): List<String> = headers.keys.filter { it.lowercase() !in ALLOWED_HEADERS }
}
