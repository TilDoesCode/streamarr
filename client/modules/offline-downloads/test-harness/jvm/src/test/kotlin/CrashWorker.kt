package expo.modules.offlinedownloads

import java.io.File

/** Child JVM: resumed GET answers 200 (new version); persist the new validator like DownloadEngine.onResponse, then die. */
object CrashWorker {
  @JvmStatic fun main(args: Array<String>) {
    val root = File(args[0])
    val url = args[1]
    val oldEtag = args[2]
    val part = File(root, "movie.bin.part")
    val record = TaskRecord("crash", url, emptyMap(), "movie.bin", Volumes.INTERNAL, 1048576, null, null, States.RUNNING,
      bytesWritten = part.length(), totalBytes = 1048576, etag = oldEtag, checkpoint = part.length())
    Transfer("crash", url, emptyMap(), part, 1048576, null, oldEtag, 1048576, { _, _ -> null }, object : TransferListener {
      override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) {
        check(fromZero && restarted)
        record.totalBytes = totalBytes
        record.etag = etag
        record.bytesWritten = 0
        record.checkpoint = 0
        TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(record)))
        Runtime.getRuntime().halt(0)
      }
      override fun onEnded(transfer: Transfer, outcome: Outcome) = error("child should have halted: $outcome")
    }).run()
    error("unexpected return")
  }
}
