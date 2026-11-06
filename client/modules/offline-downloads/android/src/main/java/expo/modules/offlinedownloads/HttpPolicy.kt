package expo.modules.offlinedownloads

import java.util.Calendar
import java.util.TimeZone

/** Status table, Retry-After and retry decisions; mirrored in http-policy.ts and HttpPolicy.swift (test-vectors/http-policy.json). */
object HttpPolicy {
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
      // Clamp before multiplying so huge values cannot overflow.
      if (value.length > 7) MAX_RETRY_AFTER_MS else value.toLong() * 1000
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

  /** What a failed attempt does to a task (same rules on iOS and in the fake). */
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

  /** Header names outside the allowlist (capability URLs need no headers; a redirect may leave the origin). */
  fun disallowedHeaders(headers: Map<String, String>): List<String> = headers.keys.filter { it.lowercase() !in ALLOWED_HEADERS }
}
