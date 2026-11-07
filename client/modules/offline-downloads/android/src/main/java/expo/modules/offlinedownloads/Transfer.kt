package expo.modules.offlinedownloads

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLConnection

enum class StopReason { PAUSE, CANCEL, HOST, NETWORK, CONCURRENCY, UPDATE, VOLUME }

sealed class Outcome {
  /** The whole body is in the synced part file; the engine validates and publishes it under its lock. */
  data class Ready(val total: Long, val etag: String?) : Outcome()
  data class Stopped(val reason: StopReason) : Outcome()
  /** `droppedPartial`: the bytes on disk were discarded (the next attempt starts at 0). */
  data class Failed(val error: DownloadError, val retryable: Boolean, val retryAfterMs: Long? = null, val droppedPartial: Boolean = false) : Outcome()
}

interface TransferListener {
  /** Response accepted; the part file already matches it (truncated and synced when `fromZero`). */
  fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean)

  fun onEnded(transfer: Transfer, outcome: Outcome)
}

/** Free-space admission against the engine's ledger: null when `remaining` fits. */
fun interface SpaceGuard {
  fun check(transfer: Transfer, remaining: Long): DownloadError?
}

private class RedirectRefused(message: String) : IOException(message)

/** A write was refused because the transfer was stopped. */
private class StoppedWriting : IOException("stopped")

/** One HTTP GET into `<final>.part`: appends only to bytes proven to belong to the same strong ETag and size. */
class Transfer(
  val id: String,
  private val url: String,
  private val headers: Map<String, String>,
  val part: File,
  private val expectedBytes: Long?,
  private val pinnedEtag: String?,
  /** Validator of the bytes on disk. */
  private val etag: String?,
  private val knownTotal: Long?,
  private val space: SpaceGuard,
  private val listener: TransferListener,
) : Runnable {
  @Volatile var bytes: Long = 0
    private set
  @Volatile var startBytes: Long = 0
    private set
  /** Bytes known to be on storage (fsynced); the engine checkpoints only these. */
  @Volatile var durableBytes: Long = 0
    private set
  @Volatile private var stopReason: StopReason? = null
  @Volatile private var connection: HttpURLConnection? = null
  /** Every change to the part happens under it after a stop check; `stop` sets the flag under it (N2-02). */
  private val writeLock = Any()

  val stopped: Boolean get() = stopReason != null

  /** No write follows once this returns; `disconnect` closes the socket, so a blocked read fails at once (N2-06). */
  fun stop(reason: StopReason) {
    synchronized(writeLock) { if (stopReason == null) stopReason = reason }
    runCatching { connection?.disconnect() }
  }

  private fun <T> guarded(block: () -> T): T = synchronized(writeLock) {
    if (stopReason != null) throw StoppedWriting()
    block()
  }

  override fun run() {
    val outcome = try {
      transfer()
    } catch (error: Throwable) {
      stopReason?.let { Outcome.Stopped(it) } ?: classify(error)
    }
    listener.onEnded(this, outcome)
  }

  private fun transfer(): Outcome {
    part.parentFile?.mkdirs()
    var offset = if (part.exists()) part.length() else 0L
    val validator = etag?.takeIf { isStrong(it) }
    if (offset > 0 && (validator == null || (knownTotal != null && offset > knownTotal))) offset = truncate(0)
    // A complete part is re-validated through its last byte: one completion path, no 416.
    if (knownTotal != null && knownTotal > 0 && offset == knownTotal) offset = truncate(knownTotal - 1)
    bytes = offset
    startBytes = offset
    durableBytes = offset
    stopReason?.let { return Outcome.Stopped(it) }

    val conn = open(offset, validator)
    try {
      val code = conn.responseCode
      stopReason?.let { return Outcome.Stopped(it) }
      val responseEtag = conn.getHeaderField("ETag")?.trim()
      var restarted = false
      val total: Long?
      when {
        code == HttpURLConnection.HTTP_PARTIAL -> {
          val range = ContentRange.parse(conn.getHeaderField("Content-Range"))
          rejectPartial(offset, validator, range, responseEtag)?.let { return it }
          total = range!!.total
        }
        code in 200..299 -> {
          if (pinnedEtag != null && responseEtag != pinnedEtag) {
            if (offset > 0) truncate(0)
            return Outcome.Failed(DownloadError("validator_changed", "ETag $responseEtag, expected $pinnedEtag"), false, droppedPartial = offset > 0)
          }
          total = conn.contentLengthLong.takeIf { it >= 0 }
          if (expectedBytes != null && total != null && total != expectedBytes) {
            return Outcome.Failed(DownloadError("size_mismatch", "server size $total, expected $expectedBytes"), false)
          }
          restarted = offset > 0
          // The old bytes go before the new validator is recorded (N1-02: metadata never describes other bytes).
          offset = truncate(0)
        }
        code == 416 -> {
          truncate(0)
          return Outcome.Failed(DownloadError("http", "HTTP 416", 416), false, droppedPartial = true)
        }
        HttpPolicy.retryable(code) -> {
          val wait = HttpPolicy.retryAfterMs(conn.getHeaderField("Retry-After"))
          return Outcome.Failed(DownloadError("http", "HTTP $code", code, wait), true, wait)
        }
        else -> return Outcome.Failed(DownloadError("http", "HTTP $code", code), false)
      }
      val size = total ?: expectedBytes
      if (size != null) space.check(this, size - offset)?.let { return Outcome.Failed(it, false) }
      listener.onResponse(this, size, responseEtag?.takeIf { isStrong(it) }, offset == 0L, restarted)
      bytes = offset
      startBytes = offset
      val output = try {
        guarded { FileOutputStream(part, true) }
      } catch (error: StoppedWriting) {
        return Outcome.Stopped(stopReason ?: StopReason.CANCEL)
      } catch (error: IOException) {
        return Outcome.Failed(DownloadError("file_system", error.message ?: "cannot open ${part.name}"), false)
      }
      output.use { out ->
        conn.inputStream.use { input ->
          val buffer = ByteArray(BUFFER_BYTES)
          var sinceSync = 0L
          var sinceSpaceCheck = 0L
          while (stopReason == null) {
            val read = input.read(buffer)
            if (read < 0) break
            if (size != null && bytes + read > size) {
              out.close()
              truncate(0)
              return Outcome.Failed(DownloadError("size_mismatch", "received more than $size bytes"), false, droppedPartial = true)
            }
            guarded { out.write(buffer, 0, read) }
            bytes += read
            sinceSync += read
            sinceSpaceCheck += read
            if (sinceSync >= SYNC_BYTES) {
              out.fd.sync()
              durableBytes = bytes
              sinceSync = 0
            }
            if (size != null && sinceSpaceCheck >= SPACE_CHECK_BYTES) {
              sinceSpaceCheck = 0
              space.check(this, size - bytes)?.let { error ->
                out.fd.sync()
                durableBytes = bytes
                return Outcome.Failed(error, false)
              }
            }
          }
        }
        out.flush()
        out.fd.sync()
        durableBytes = bytes
      }
      stopReason?.let { return Outcome.Stopped(it) }
      if (size != null && bytes < size) return Outcome.Failed(DownloadError("network", "connection closed at $bytes of $size"), true)
      return Outcome.Ready(size ?: bytes, responseEtag?.takeIf { isStrong(it) })
    } finally {
      conn.disconnect()
      connection = null
    }
  }

  /** Null when the 206 continues exactly the bytes on disk; otherwise the partial is dropped (N1-01). */
  private fun rejectPartial(offset: Long, validator: String?, range: ContentRange?, responseEtag: String?): Outcome.Failed? {
    val shape = range != null && offset > 0 && range.start == offset && range.end == range.total - 1
    val sameFile = responseEtag != null && isStrong(responseEtag) && responseEtag == validator
    val sameSize = range != null && (knownTotal == null || range.total == knownTotal)
    if (shape && sameFile && sameSize && (expectedBytes == null || range!!.total == expectedBytes) && (pinnedEtag == null || responseEtag == pinnedEtag)) {
      return null
    }
    truncate(0)
    val detail = "Content-Range ${range?.text}, ETag $responseEtag, bytes on disk $offset/$knownTotal of $validator"
    if (pinnedEtag != null && responseEtag != pinnedEtag) {
      return Outcome.Failed(DownloadError("validator_changed", "ETag $responseEtag, expected $pinnedEtag"), false, droppedPartial = true)
    }
    if (shape && sameFile && expectedBytes != null && range!!.total != expectedBytes) {
      return Outcome.Failed(DownloadError("size_mismatch", "server size ${range.total}, expected $expectedBytes"), false, droppedPartial = true)
    }
    // An ordinary attempt: the next one starts at 0 (never appends to unproven bytes).
    return Outcome.Failed(DownloadError("network", "invalid partial response: $detail"), true, droppedPartial = true)
  }

  /** GET with manual redirects: caller headers never leave their origin; https never downgrades to http (N1-12). */
  private fun open(offset: Long, validator: String?): HttpURLConnection {
    var current = URL(url)
    var callerHeaders = headers
    var hops = 0
    while (true) {
      val conn = (connect(current) as HttpURLConnection).apply {
        instanceFollowRedirects = false
        connectTimeout = CONNECT_TIMEOUT_MS
        readTimeout = READ_TIMEOUT_MS
        useCaches = false
        callerHeaders.forEach { (name, value) -> setRequestProperty(name, value) }
        setRequestProperty("Accept-Encoding", "identity")
        if (offset > 0 && validator != null) {
          setRequestProperty("Range", "bytes=$offset-")
          setRequestProperty("If-Range", validator)
        }
      }
      connection = conn
      val code = conn.responseCode
      val location = conn.getHeaderField("Location")
      if (code !in REDIRECTS || location == null) return conn
      conn.disconnect()
      if (++hops > MAX_REDIRECTS) throw RedirectRefused("more than $MAX_REDIRECTS redirects")
      val next = URL(current, location)
      val upgrade = current.protocol == "http" && next.protocol == "https"
      if (next.protocol != current.protocol && !upgrade) throw RedirectRefused("redirect ${current.protocol} → ${next.protocol} refused")
      if (origin(next) != origin(current)) callerHeaders = emptyMap()
      current = next
      stopReason?.let { throw IOException("stopped: $it") }
    }
  }

  private fun truncate(length: Long): Long {
    guarded {
      if (part.exists()) {
        RandomAccessFile(part, "rw").use {
          it.setLength(length)
          it.fd.sync()
        }
      }
    }
    bytes = length
    durableBytes = length
    return length
  }

  private fun classify(error: Throwable): Outcome {
    val message = error.message ?: error.javaClass.simpleName
    if (message.contains("ENOSPC") || message.contains("No space left", ignoreCase = true)) {
      return Outcome.Failed(DownloadError("disk_full", message), false)
    }
    if (error is RedirectRefused) return Outcome.Failed(DownloadError("network", message), false)
    if (error is IOException) return Outcome.Failed(DownloadError("network", "${error.javaClass.simpleName}: $message"), true)
    return Outcome.Failed(DownloadError("unknown", "${error.javaClass.simpleName}: $message"), false)
  }

  data class ContentRange(val start: Long, val end: Long, val total: Long, val text: String) {
    companion object {
      private val PATTERN = Regex("""^bytes (\d{1,18})-(\d{1,18})/(\d{1,18})$""")

      /** Strict `bytes a-b/total` with a numeric total and a <= b < total. */
      fun parse(header: String?): ContentRange? {
        val text = header?.trim() ?: return null
        val match = PATTERN.matchEntire(text) ?: return null
        val (start, end, total) = match.destructured.toList().map { it.toLong() }
        return if (start <= end && end < total) ContentRange(start, end, total, text) else null
      }
    }
  }

  companion object {
    private const val CONNECT_TIMEOUT_MS = 20_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val BUFFER_BYTES = 256 * 1024
    private const val SYNC_BYTES = 16L * 1024 * 1024
    private const val SPACE_CHECK_BYTES = 64L * 1024 * 1024
    private const val MAX_REDIRECTS = 5
    private val REDIRECTS = setOf(301, 302, 303, 307, 308)

    /** Test seam (host JVM harness): how a URL is opened. */
    @Volatile internal var connect: (URL) -> URLConnection = { it.openConnection() }

    fun isStrong(etag: String): Boolean = etag.length >= 2 && etag.startsWith("\"") && etag.endsWith("\"")

    private fun origin(url: URL): String = "${url.protocol}://${url.host.lowercase()}:${if (url.port == -1) url.defaultPort else url.port}"
  }
}
