package expo.modules.offlinedownloads

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL

enum class StopReason { PAUSE, CANCEL, HOST, NETWORK, CONCURRENCY, UPDATE }

sealed class Outcome {
  object Completed : Outcome()
  data class Stopped(val reason: StopReason) : Outcome()
  data class Failed(val error: DownloadError, val retryable: Boolean, val retryAfterMs: Long? = null) : Outcome()
}

interface TransferListener {
  /** Response accepted: size and the validator of the bytes on disk (`fromZero` = the part file starts over). */
  fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, lastModified: String?, fromZero: Boolean, restarted: Boolean)

  fun onEnded(transfer: Transfer, outcome: Outcome)
}

/** One HTTP GET into `<final>.part`: resumes with Range + If-Range, starts over when the validator changed. */
class Transfer(
  val id: String,
  private val url: String,
  private val headers: Map<String, String>,
  val part: File,
  private val target: File,
  private val volume: Volume,
  private val expectedBytes: Long?,
  private val expectedEtag: String?,
  private val etag: String?,
  private val lastModified: String?,
  private val knownTotal: Long?,
  private val listener: TransferListener,
) : Runnable {
  @Volatile var bytes: Long = 0
    private set
  @Volatile var startBytes: Long = 0
    private set
  @Volatile private var stopReason: StopReason? = null
  @Volatile private var connection: HttpURLConnection? = null

  fun stop(reason: StopReason) {
    if (stopReason == null) stopReason = reason
    connection?.disconnect()
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
    val validator = etag?.takeUnless { it.startsWith("W/") } ?: lastModified
    if (offset > 0 && (validator == null || (knownTotal != null && offset > knownTotal))) offset = truncate(0)
    if (knownTotal != null && offset == knownTotal && offset > 0) {
      bytes = offset
      return finish(knownTotal)
    }
    bytes = offset
    startBytes = offset
    stopReason?.let { return Outcome.Stopped(it) }

    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      instanceFollowRedirects = true
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      useCaches = false
      headers.forEach { (name, value) -> setRequestProperty(name, value) }
      setRequestProperty("Accept-Encoding", "identity")
      if (offset > 0) {
        setRequestProperty("Range", "bytes=$offset-")
        setRequestProperty("If-Range", validator)
      }
    }
    connection = conn
    try {
      val code = conn.responseCode
      stopReason?.let { return Outcome.Stopped(it) }
      val responseEtag = conn.getHeaderField("ETag")
      val responseLastModified = conn.getHeaderField("Last-Modified")
      var restarted = false
      val total: Long?
      when {
        code == HttpURLConnection.HTTP_PARTIAL -> {
          val range = ContentRange.parse(conn.getHeaderField("Content-Range"))
          if (range == null || range.start != offset || (etag != null && responseEtag != null && responseEtag != etag)) {
            truncate(0)
            return Outcome.Failed(DownloadError("network", "unexpected partial response ${conn.getHeaderField("Content-Range")}"), true, 0)
          }
          total = range.total ?: knownTotal
        }
        code in 200..299 -> {
          if (offset > 0) restarted = true
          offset = 0
          total = conn.contentLengthLong.takeIf { it >= 0 }
        }
        code == 416 -> {
          val rangeTotal = ContentRange.total(conn.getHeaderField("Content-Range")) ?: knownTotal
          if (rangeTotal != null && offset == rangeTotal) {
            bytes = offset
            return finish(rangeTotal)
          }
          // The bytes on disk do not fit the file any more: drop them, so `resume()` starts over.
          truncate(0)
          return Outcome.Failed(DownloadError("http", "range not satisfiable", code), false)
        }
        HttpPolicy.retryable(code) -> {
          val wait = HttpPolicy.retryAfterMs(conn.getHeaderField("Retry-After"))
          return Outcome.Failed(DownloadError("http", "HTTP $code", code, wait), true, wait)
        }
        else -> return Outcome.Failed(DownloadError("http", "HTTP $code", code), false)
      }
      if (expectedEtag != null && responseEtag != null && responseEtag != expectedEtag) {
        return Outcome.Failed(DownloadError("validator_changed", "ETag $responseEtag, expected $expectedEtag"), false)
      }
      if (expectedBytes != null && total != null && total != expectedBytes) {
        return Outcome.Failed(DownloadError("size_mismatch", "server size $total, expected $expectedBytes"), false)
      }
      val size = total ?: expectedBytes
      listener.onResponse(this, size, responseEtag, responseLastModified, offset == 0L, restarted)
      if (size != null && volume.freeBytes() < size - offset + RESERVE_BYTES) {
        return Outcome.Failed(DownloadError("disk_full", "needs ${size - offset} bytes, ${volume.freeBytes()} free"), false)
      }
      if (offset == 0L) bytes = 0
      startBytes = offset
      val output = try {
        FileOutputStream(part, offset > 0)
      } catch (error: IOException) {
        return Outcome.Failed(DownloadError("file_system", error.message ?: "cannot open ${part.name}"), false)
      }
      output.use { out ->
        conn.inputStream.use { input ->
          val buffer = ByteArray(BUFFER_BYTES)
          while (stopReason == null) {
            val read = input.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            bytes += read
          }
        }
        if (stopReason == null) out.fd.sync()
      }
      stopReason?.let { return Outcome.Stopped(it) }
      if (size != null && bytes < size) return Outcome.Failed(DownloadError("network", "connection closed at $bytes of $size"), true)
      if (size != null && bytes > size) {
        truncate(0)
        return Outcome.Failed(DownloadError("size_mismatch", "received $bytes of $size"), false)
      }
      return finish(size ?: bytes)
    } finally {
      conn.disconnect()
      connection = null
    }
  }

  private fun finish(size: Long): Outcome {
    if (part.length() != size) return Outcome.Failed(DownloadError("size_mismatch", "file has ${part.length()} of $size bytes"), false)
    return try {
      Files.move(part, target)
      Outcome.Completed
    } catch (error: Exception) {
      Outcome.Failed(DownloadError("file_system", error.message ?: "move failed"), false)
    }
  }

  private fun truncate(length: Long): Long {
    if (part.exists()) RandomAccessFile(part, "rw").use { it.setLength(length) }
    bytes = length
    return length
  }

  private fun classify(error: Throwable): Outcome {
    val message = error.message ?: error.javaClass.simpleName
    if (message.contains("ENOSPC") || message.contains("No space left", ignoreCase = true)) {
      return Outcome.Failed(DownloadError("disk_full", message), false)
    }
    if (error is IOException) return Outcome.Failed(DownloadError("network", "${error.javaClass.simpleName}: $message"), true)
    return Outcome.Failed(DownloadError("unknown", "${error.javaClass.simpleName}: $message"), false)
  }

  private data class ContentRange(val start: Long, val end: Long, val total: Long?) {
    companion object {
      private val PATTERN = Regex("""bytes\s+(\d+)-(\d+)/(\d+|\*)""")
      private val TOTAL = Regex("""/(\d+)\s*$""")

      fun total(header: String?): Long? = header?.let { TOTAL.find(it) }?.groupValues?.get(1)?.toLongOrNull()

      fun parse(header: String?): ContentRange? {
        val match = header?.let { PATTERN.find(it) } ?: return null
        val (start, end, total) = match.destructured
        return ContentRange(start.toLong(), end.toLong(), total.toLongOrNull())
      }
    }
  }

  companion object {
    private const val CONNECT_TIMEOUT_MS = 20_000
    private const val READ_TIMEOUT_MS = 30_000
    private const val BUFFER_BYTES = 256 * 1024
    /** Left free on the volume so the system and the app keep working. */
    const val RESERVE_BYTES = 64L * 1024 * 1024
  }
}
