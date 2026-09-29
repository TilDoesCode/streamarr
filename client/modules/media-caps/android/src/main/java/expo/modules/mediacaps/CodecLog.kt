package expo.modules.mediacaps

import android.os.Process

// Reads this process's own logcat (no permission needed) to see which MediaCodec instances the players open.
internal object CodecLog {
  private val LINE = Regex("""^\s*(\d+)\.(\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]+?)\s*:\s(.*)$""")
  private val ALLOCATE = Regex("""allocate\(((?:c2|OMX)\.[\w.\-]+)\)""")
  private val NAMED = Regex("""\[((?:c2|OMX)\.[\w.\-]+)]""")
  private val EXO_DECODER = Regex("""(video|audio)DecoderInitialized \[.*?,\s*((?:c2|OMX)\.[\w.\-]+|[\w.\-]+)]""")
  private val EXO_DROPPED = Regex("""droppedFrames \[.*?,\s*(\d+)]""")
  private val TAGS = setOf("CCodec", "MediaCodec", "ACodec", "EventLogger", "VLC", "libvlc")

  fun read(sinceEpochMs: Long): List<Map<String, Any?>> {
    val args = listOf("logcat", "-d", "-v", "epoch", "--pid=${Process.myPid()}", "-t", "4000")
    val process = ProcessBuilder(args).redirectErrorStream(true).start()
    val out = mutableListOf<Map<String, Any?>>()
    process.inputStream.bufferedReader().useLines { lines ->
      for (line in lines) {
        val match = LINE.find(line) ?: continue
        val (seconds, fraction, _, tag, message) = match.destructured
        if (TAGS.none { tag.startsWith(it) }) continue
        val time = seconds.toLong() * 1000 + fraction.padEnd(3, '0').take(3).toLong()
        if (time < sinceEpochMs) continue
        parse(tag, message)?.let { out.add(it + mapOf("time" to time.toDouble(), "tag" to tag)) }
      }
    }
    process.waitFor()
    return out.takeLast(200)
  }

  private fun parse(tag: String, message: String): Map<String, Any?>? {
    EXO_DECODER.find(message)?.let { return mapOf("event" to "decoderInitialized", "kind" to it.groupValues[1], "codec" to it.groupValues[2]) }
    EXO_DROPPED.find(message)?.let { return mapOf("event" to "droppedFrames", "count" to it.groupValues[1].toInt()) }
    ALLOCATE.find(message)?.let { return mapOf("event" to "allocate", "codec" to it.groupValues[1]) }
    if (tag.startsWith("MediaCodec") && message.contains("release", ignoreCase = true)) {
      NAMED.find(message)?.let { return mapOf("event" to "release", "codec" to it.groupValues[1]) }
    }
    if (tag.startsWith("VLC") || tag.startsWith("libvlc")) {
      Regex("""((?:c2|OMX)\.[\w.\-]+)""").find(message)?.let { return mapOf("event" to "vlcCodec", "codec" to it.groupValues[1], "message" to message.take(160)) }
    }
    return null
  }
}
