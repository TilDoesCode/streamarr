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
  /** The request this host answers (job extras / service intent): orders hosts and tells a stale callback apart (N2-11). */
  val token: Long

  fun update(progress: ProgressSnapshot)

  fun finish()
}

/** What the system holds for the engine's host right now (N2-11). */
enum class HostJob {
  /** Nothing scheduled or running: an outstanding request is dead. */
  NONE,

  /** Scheduled, held only by JobScheduler's backoff after a stop: replacing it cannot race a start. */
  BACKOFF,

  /** Scheduled and waiting for a constraint or about to start: never replaced. */
  PENDING,

  /** Executing (job or service). */
  RUNNING,
}

/** A service's live hosts by token: a stop finds its own host, never the one that replaced it (N2-11). */
class HostSlots<T : TransferHost> {
  private val hosts = LinkedHashMap<Long, T>()

  @Synchronized fun started(host: T) {
    hosts[host.token] = host
  }

  @Synchronized fun stopped(token: Long): T? = hosts.remove(token)

  /** The host finished on its own: forget it unless a newer one already took its token's slot. */
  @Synchronized fun released(host: T) {
    if (hosts[host.token] === host) hosts.remove(host.token)
  }

  @Synchronized fun get(token: Long): T? = hosts[token]
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

  fun warn(message: String)

  fun network(): Net

  /** Observe network and volume changes while there is work; changes call `onChange`. */
  fun observe(active: Boolean, onChange: () -> Unit)

  /** Mounted volumes, internal first. */
  fun volumes(): List<Volume>

  /**
   * Ask for a host carrying `token` (it arrives through `DownloadEngine.attachHost`); `replace` swaps the system's job.
   * Returns the token the arriving host will carry (an existing job keeps its own), null when nothing was scheduled.
   */
  fun requestHost(token: Long, replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Long?

  fun hostJob(): HostJob

  /** No work left: drop a pending host request. */
  fun cancelHostRequest()

  fun summary(finished: Int, failed: Int)

  fun clearNotification()

  /** Downloads waiting for a missing volume: a plain note without actions in the progress slot; 0 removes it (N4-02). */
  fun waitingForStorage(count: Int)

  fun lastExit(): ExitInfo?

  /** The app is in the foreground (a user-initiated job can be scheduled right now). */
  fun visible(): Boolean
}
