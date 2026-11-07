package expo.modules.offlinedownloads

import java.io.File
import java.util.UUID

/** The engine clock (N2-04, C2-07): sleep-inclusive elapsed ms and an id that changes with every reboot, never with the wall clock. */
class BootClock(
  private val elapsed: () -> Long,
  private val bootCount: () -> Int?,
  private val kernelBootId: () -> String? = { runCatching { File(KERNEL_BOOT_ID).readText().trim() }.getOrNull() },
) {
  /** The kernel's boot id, else the boot counter; read once, so a later failing read never changes it within a process. */
  val known: String? by lazy {
    runCatching { kernelBootId() }.getOrNull()?.takeIf { it.isNotEmpty() } ?: runCatching { bootCount() }.getOrNull()?.let { "boot-count-$it" }
  }

  /** Never fails: without a known id the process gets its own. */
  val bootId: String by lazy { known ?: "process-${UUID.randomUUID()}" }

  fun now(): Map<String, Any> = mapOf("elapsedMs" to elapsed().toDouble(), "bootId" to bootId)

  companion object {
    const val KERNEL_BOOT_ID = "/proc/sys/kernel/random/boot_id"
  }
}
