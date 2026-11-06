package expo.modules.offlinedownloads

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** What a response status does to a transfer; mirrored in src/downloads/engine/http-policy.ts and HttpPolicy.swift. */
object HttpPolicy {
  const val MAX_RETRY_AFTER_MS = 60L * 60 * 1000

  /** True: retry natively (honouring Retry-After). False: fail at once with kind `http`. */
  fun retryable(status: Int): Boolean = status == 408 || status == 425 || status == 429 || status in 500..599

  /** Retry-After (delta-seconds or IMF-fixdate) in ms, capped at an hour; null when absent or unparsable. */
  fun retryAfterMs(header: String?, nowMs: Long = System.currentTimeMillis()): Long? {
    val value = header?.trim()?.takeIf { it.isNotEmpty() } ?: return null
    val ms = if (value.all { it.isDigit() }) {
      value.toLongOrNull()?.let { it * 1000 } ?: MAX_RETRY_AFTER_MS
    } else {
      runCatching { httpDate().parse(value)!!.time - nowMs }.getOrNull() ?: return null
    }
    return ms.coerceIn(0, MAX_RETRY_AFTER_MS)
  }

  // java.time needs API 26; minSdk is 24 (old TV boxes).
  private fun httpDate() = SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).apply { timeZone = TimeZone.getTimeZone("GMT") }
}
