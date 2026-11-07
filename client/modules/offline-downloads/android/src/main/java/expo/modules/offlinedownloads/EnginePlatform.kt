package expo.modules.offlinedownloads

import java.io.File

enum class Net { NONE, METERED, UNMETERED }

/** How a host ended: the user stopped it, the app replaced it, or the system (constraints, quota, process death). */
enum class HostStop { USER, CANCELLED_BY_APP, SYSTEM }

/** The previous process's exit (Android 11+ exit history). */
data class ExitInfo(val timestamp: Long, val userStop: Boolean, val description: String)

data class ProgressSnapshot(val tasks: List<TaskRecord>, val live: Map<String, Long>, val bytesPerSecond: Long)

/** Where transfers run: the user-initiated job (API 34+) or the dataSync foreground service. */
interface TransferHost {
  fun update(progress: ProgressSnapshot)

  fun finish()
}

/** Android side of the engine (hosts, notifications, network, volumes, exit history); a fake stands in on the JVM. */
interface EnginePlatform {
  val stateDir: File

  /** Wall clock (epoch ms): display, HTTP dates, exit history. */
  fun now(): Long

  /** Elapsed time since boot including deep sleep (ms): every wait and budget runs on it (N2-04). */
  fun elapsed(): Long

  /** Identity of the current boot (null when unknown): elapsed times persisted on another boot are not comparable. */
  fun bootId(): String?

  fun log(message: String)

  fun network(): Net

  /** Observe network and volume changes while there is work; changes call `onChange`. */
  fun observe(active: Boolean, onChange: () -> Unit)

  /** Mounted volumes, internal first. */
  fun volumes(): List<Volume>

  /** Ask for a host (it arrives through `DownloadEngine.attachHost`); `replace` swaps a pending job. */
  fun requestHost(replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Boolean

  /** No work left: drop a pending host request. */
  fun cancelHostRequest()

  fun summary(finished: Int, failed: Int)

  fun clearNotification()

  fun lastExit(): ExitInfo?

  /** The app is in the foreground (a user-initiated job can be scheduled right now). */
  fun visible(): Boolean
}
