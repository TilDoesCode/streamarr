package android.os

import java.io.File

// Host-only shim; `harness.freeBytes` overrides the free space for storage-pressure tests.
class StatFs(path: String) {
  private val file = File(path)
  val availableBytes: Long get() = System.getProperty("harness.freeBytes")?.toLong() ?: file.usableSpace
  val totalBytes: Long get() = file.totalSpace
}
