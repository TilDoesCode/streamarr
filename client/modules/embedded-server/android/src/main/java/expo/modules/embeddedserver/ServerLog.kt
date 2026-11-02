package expo.modules.embeddedserver

import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.text.SimpleDateFormat
import java.util.ArrayDeque
import java.util.Date
import java.util.Locale

/** Child-process output: rolling files for support and a ring buffer for the app. */
class ServerLog(private val dir: File, private val maxFiles: Int = 5, private val maxBytes: Long = 1_000_000, ringSize: Int = 2_000) {
  private val ring = ArrayDeque<String>(ringSize)
  private val ringSize = ringSize
  private var writer: OutputStreamWriter? = null
  private var written = 0L
  private val stamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US)

  @Synchronized
  fun append(line: String) {
    if (ring.size >= ringSize) ring.pollFirst()
    ring.addLast(line)
    try {
      val out = writer ?: open()
      val text = "${stamp.format(Date())} $line\n"
      out.write(text)
      out.flush()
      written += text.length
      if (written >= maxBytes) rotate()
    } catch (_: Exception) {
    }
  }

  /** A line written by the supervisor itself, marked so it is distinguishable from server output. */
  fun note(message: String) = append("[supervisor] $message")

  @Synchronized
  fun tail(maxLines: Int): List<String> {
    val count = maxLines.coerceIn(0, ring.size)
    return ring.toList().takeLast(count)
  }

  /** Last lines that look like an error, for `lastError`. */
  @Synchronized
  fun lastErrorHint(): String? = ring.toList().lastOrNull { it.contains("Unhandled exception") || it.contains(" ERR] ") || it.contains(" FTL] ") || it.startsWith("streamarr-host:") }

  @Synchronized
  fun contains(needle: String): Boolean = ring.any { it.contains(needle) }

  private fun open(): OutputStreamWriter {
    dir.mkdirs()
    val file = File(dir, FILE_NAME)
    written = file.length()
    return OutputStreamWriter(FileOutputStream(file, true), StandardCharsets.UTF_8).also { writer = it }
  }

  private fun rotate() {
    writer?.close()
    writer = null
    for (index in maxFiles - 1 downTo 1) {
      val older = File(dir, "$FILE_NAME.$index")
      val newer = if (index == 1) File(dir, FILE_NAME) else File(dir, "$FILE_NAME.${index - 1}")
      if (older.exists()) older.delete()
      if (newer.exists()) newer.renameTo(older)
    }
    written = 0
  }

  companion object {
    const val FILE_NAME = "server.log"
  }
}
