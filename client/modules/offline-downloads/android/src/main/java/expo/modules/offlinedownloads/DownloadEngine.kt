package expo.modules.offlinedownloads

import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Process-wide download queue: owns the registry and the path claims, runs transfers inside a host, survives without JS. */
class DownloadEngine(private val platform: EnginePlatform) : TransferListener, SpaceGuard {
  interface Listener {
    fun onProgress(event: Map<String, Any?>)
    fun onState(event: Map<String, Any?>)
  }

  private val lock = Any()
  private val store = TaskStore(platform.stateDir)
  val volumes = Volumes { platform.volumes() }
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val pool = Executors.newCachedThreadPool { runnable -> Thread(runnable, "offline-download").apply { isDaemon = true } }
  private val timer = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "offline-download-timer").apply { isDaemon = true } }
  private var settings = Settings()
  private var lastExitHandled = 0L
  private val tasks = LinkedHashMap<String, TaskRecord>()
  private val transfers = HashMap<String, Transfer>()
  /** Stopped transfers whose worker still runs, for every stop reason: they keep their task's paths until it ended (N2-02). */
  private val drains = HashMap<Transfer, Drain>()
  /** Ids whose cancel/remove timed out (`cancel_pending`); `settled`: their drain ended since, a retry resolves. */
  private val pending = HashSet<String>()
  private val settled = HashSet<String>()
  private val speeds = HashMap<String, Speed>()
  private var host: TransferHost? = null
  private var hostRequested = false
  private var ticker: ScheduledFuture<*>? = null
  private var pendingPump: ScheduledFuture<*>? = null
  private var retryTimer: ScheduledFuture<*>? = null
  private var ticks = 0L
  private var lastFastStart = 0L
  private var finished = 0
  private var failed = 0

  private class Speed(var bytes: Long, var at: Long, var perSecond: Double = 0.0)

  /** `dispose`: the task is gone (cancel, remove): the worker's partial is deleted once it ended. */
  private class Drain(val task: TaskRecord, var dispose: Boolean, val latch: CountDownLatch = CountDownLatch(1))

  /** Test seam: how long cancel/remove wait for a stopped worker before `cancel_pending` / `remove_pending`. */
  @Volatile internal var drainTimeoutMs = DRAIN_TIMEOUT_MS

  fun load() = synchronized(lock) {
    val state = store.load()
    settings = state.settings
    lastExitHandled = state.lastExitHandled
    // Task Manager "Stop" kills the process without onStopJob: honour it as a pause on the next start (N1-13).
    val exit = platform.lastExit()?.takeIf { it.timestamp > lastExitHandled }
    if (exit != null) lastExitHandled = exit.timestamp
    val userStopped = exit?.userStop == true
    if (userStopped) platform.log("previous process was stopped by the user (${exit?.description}): unfinished downloads pause")
    state.tasks.forEach { task ->
      if (task.state == States.RUNNING) task.state = States.QUEUED
      if (userStopped && task.isActive) {
        task.state = States.PAUSED
        task.clearRetry()
      }
      if (task.state != States.COMPLETED && task.state != States.CANCELLED) recoverPart(task)
      tasks[task.id] = task
    }
    restoreWaits(state)
    if (state.legacyUnresolved.isNotEmpty()) {
      // Dev installs from before UUID volume ids (state v1): never rebound by list order (N2-05).
      platform.log("state v${state.version}: nothing identifies the volume of ${state.legacyUnresolved.joinToString()}: $VOLUME_UNAVAILABLE")
      for (id in state.legacyUnresolved) {
        val task = tasks[id] ?: continue
        task.clearRetry()
        task.error = DownloadError("file_system", VOLUME_UNAVAILABLE)
        task.state = States.FAILED
      }
    }
    // A death while a cancelled worker drained can leave its partial; a newer task's path is never touched.
    tasks.values.filter { it.state == States.CANCELLED }.forEach { tombstone ->
      tombstone.bytesWritten = 0
      if (ownerOf(claimsOf(tombstone)) == null) partFile(tombstone)?.delete()
    }
    persist()
    pumpLocked()
  }

  /** Waits persisted on the elapsed clock stay on the same boot; otherwise the wall clock may only shorten them (N2-04). */
  private fun restoreWaits(state: StoredState) {
    val elapsed = platform.elapsed()
    val wall = platform.now()
    val clock = state.clock
    val sameBoot = clock != null && clock.bootId != null && clock.bootId == platform.bootId() && elapsed >= clock.elapsed
    for (task in tasks.values) {
      when {
        clock == null || state.version < 3 -> {
          // Epoch times (state v2): the wall clock is all there is, bounded by the longest wait.
          val remaining = task.retryAt?.let { (it - wall).coerceIn(0, HttpPolicy.MAX_RETRY_AFTER_MS) }
          task.retryDue = remaining?.let { elapsed + it }
          task.retryDelay = remaining
          task.waitingSince = task.waitingSince?.let { elapsed - (wall - it).coerceIn(0, HttpPolicy.MAX_SERVER_WAIT_MS) }
        }
        !sameBoot -> {
          val restored = task.retryDue?.let { due ->
            val saved = due - clock.elapsed
            HttpPolicy.restoreWait(saved, task.retryDelay ?: saved, false, 0, wall - clock.wall)
          }
          task.waitingSince = task.waitingSince?.let { elapsed - ((clock.elapsed - it).coerceAtLeast(0) + (restored?.consumedMs ?: 0)) }
          task.retryDue = restored?.let { elapsed + it.remainingMs }
        }
      }
      task.retryAt = task.retryDue?.let { wall + (it - elapsed) }
    }
  }

  /** After a crash only the fsynced prefix of a part is trusted (N1-15). */
  private fun recoverPart(task: TaskRecord) {
    val part = partFile(task) ?: return
    if (!part.exists()) {
      task.bytesWritten = 0
      return
    }
    val checkpoint = task.checkpoint
    if (checkpoint != null && part.length() > checkpoint) {
      runCatching { RandomAccessFile(part, "rw").use { it.setLength(checkpoint); it.fd.sync() } }
    }
    task.bytesWritten = part.length()
  }

  fun addListener(listener: Listener) = listeners.add(listener)

  fun removeListener(listener: Listener) = listeners.remove(listener)

  // region API

  fun start(spec: Map<String, Any?>): Map<String, Any?> = synchronized(lock) {
    val id = spec["id"] as? String ?: throw DownloadException("invalid_argument", "id is required")
    tasks[id]?.let { return it.toMap(uri(it)) }
    val url = spec["url"] as? String ?: throw DownloadException("invalid_argument", "url is required")
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw DownloadException("invalid_argument", "url must be http(s)")
    @Suppress("UNCHECKED_CAST")
    val headers = (spec["headers"] as? Map<String, Any?>)?.mapValues { it.value.toString() } ?: emptyMap()
    checkHeaders(headers)
    val relativePath = spec["relativePath"] as? String ?: throw DownloadException("invalid_argument", "relativePath is required")
    val volumeId = spec["volumeId"] as? String ?: Volumes.INTERNAL
    Volumes.resolveIn(volumes.get(volumeId), relativePath)
    val key = Volumes.claimKey(volumeId, relativePath)
    if (key.endsWith(PART_SUFFIX)) throw DownloadException("invalid_argument", "a download path may not end in $PART_SUFFIX: $relativePath")
    ownerOf(claimsOf(key))?.let { owner ->
      throw DownloadException("invalid_state", "path $relativePath belongs to download $owner")
    }
    val expectedBytes = (spec["expectedBytes"] as? Number)?.toLong()
    val task = TaskRecord(
      id = id,
      url = url,
      headers = headers,
      relativePath = relativePath,
      volumeId = volumeId,
      expectedBytes = expectedBytes,
      expectedEtag = spec["etag"] as? String,
      title = spec["notificationTitle"] as? String,
      state = States.QUEUED,
      totalBytes = expectedBytes,
      createdAt = platform.now(),
    )
    tasks[id] = task
    emitState(task)
    persist()
    pumpLocked()
    task.toMap(uri(task))
  }

  fun pause(id: String) = synchronized(lock) {
    pauseLocked(need(id))
    persist()
    pumpLocked()
  }

  /** Notification action: every unfinished download. */
  fun pauseAll() = synchronized(lock) {
    tasks.values.filter { it.isActive }.forEach { pauseLocked(it) }
    persist()
    pumpLocked()
  }

  private fun pauseLocked(task: TaskRecord) {
    if (!task.isActive) return
    stopTransfer(task.id, StopReason.PAUSE)
    task.clearRetry()
    setState(task, States.PAUSED)
  }

  fun resume(id: String, url: String?, headers: Map<String, String>?) = synchronized(lock) {
    val task = need(id)
    if (url != null) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) throw DownloadException("invalid_argument", "url must be http(s)")
      task.url = url
    }
    if (headers != null) {
      checkHeaders(headers)
      task.headers = headers
    }
    when {
      task.state == States.PAUSED || task.state == States.FAILED -> {
        task.attempts = 0
        task.waitingSince = null
        task.error = null
        task.clearRetry()
        setState(task, States.QUEUED)
      }
      task.state == States.RETRYING -> {
        task.clearRetry()
        setState(task, States.QUEUED)
      }
      task.state == States.RUNNING && (url != null || headers != null) -> stopTransfer(id, StopReason.UPDATE)
    }
    persist()
    pumpLocked()
  }

  /**
   * Stops the task and resolves once its worker really ended (the connection is force-closed first), so the path and the
   * partial are free afterwards. After [drainTimeoutMs] it throws `io: cancel_pending`: the cancel continues, the path
   * stays claimed, and calling it again waits again (N2-06).
   */
  fun cancel(id: String) {
    val latches = synchronized(lock) {
      val task = tasks[id]
      when {
        // A tombstone is only forgotten: its path may belong to a newer download by now.
        task?.state == States.CANCELLED -> {
          tasks.remove(id)
          persist()
          emptyList()
        }
        task != null -> cancelLocked(task, tombstone = false).also {
          persist()
          pumpLocked()
        }
        else -> {
          val waiting = disposedDrains(id)
          if (waiting.isEmpty() && !settled.remove(id)) throw DownloadException("not_found", "no download $id")
          waiting
        }
      }
    }
    awaitDrains(id, latches, CANCEL_PENDING)
  }

  /** Notification action (outside the app): every active download stays as a `cancelled` tombstone until `remove`. */
  fun cancelAll(): Boolean {
    val latches = synchronized(lock) {
      // All first, then one pump: a queued task must not start just to be cancelled a moment later.
      tasks.values.filter { it.isActive }.toList().flatMap { cancelLocked(it, tombstone = true) }.also {
        persist()
        pumpLocked()
      }
    }
    val until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(drainTimeoutMs)
    // Never reported as done before every worker ended: a timeout leaves the tombstones and the claims in place.
    return latches.all { it.await((until - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS) }
  }

  /** Stops the task's worker (current or already stopping) and marks it for disposal; returns what to wait for. */
  private fun cancelLocked(task: TaskRecord, tombstone: Boolean): List<CountDownLatch> {
    speeds.remove(task.id)
    transfers[task.id]?.let { stopTransfer(task.id, StopReason.CANCEL) }
    val latches = drainsOf(task).onEach { it.dispose = true }.map { it.latch }
    if (latches.isEmpty()) partFile(task)?.delete()
    if (tombstone) {
      task.bytesWritten = 0
      task.checkpoint = null
      task.clearRetry()
      task.error = null
      setState(task, States.CANCELLED)
    } else {
      tasks.remove(task.id)
      task.error = DownloadError("cancelled", "cancelled")
      emitState(task, States.CANCELLED)
    }
    return latches
  }

  /**
   * Forgets a finished task (a completed file stays, a failed task's partial goes) once a worker still ending for it
   * has ended; `io: remove_pending` after [drainTimeoutMs] (N2-02). Idempotent: an unknown id is fine.
   */
  fun remove(id: String) {
    val latches = synchronized(lock) {
      val task = tasks[id] ?: return@synchronized disposedDrains(id).also { settled.remove(id) }
      if (task.isActive || task.state == States.PAUSED) throw DownloadException("invalid_state", "download $id is ${task.state}")
      tasks.remove(id)
      val waiting = drainsOf(task).onEach { it.dispose = true }.map { it.latch }
      if (waiting.isEmpty() && task.state == States.FAILED) partFile(task)?.delete()
      persist()
      waiting
    }
    awaitDrains(id, latches, REMOVE_PENDING)
  }

  private fun drainsOf(task: TaskRecord) = drains.values.filter { it.task === task }

  private fun disposedDrains(id: String) = drains.values.filter { it.task.id == id && it.dispose }.map { it.latch }

  /** Waits outside the lock; a timeout keeps the drain (and its claims) and is remembered for the retry. */
  private fun awaitDrains(id: String, latches: List<CountDownLatch>, timeout: String) {
    if (latches.isEmpty()) return
    val until = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(drainTimeoutMs)
    for (latch in latches) {
      if (!latch.await((until - System.nanoTime()).coerceAtLeast(0), TimeUnit.NANOSECONDS)) {
        synchronized(lock) { if (disposedDrains(id).isNotEmpty()) pending += id else settled += id }
        platform.log("$id: worker still ending after ${drainTimeoutMs} ms ($timeout)")
        throw DownloadException("io", timeout)
      }
    }
  }

  /** File or directory; refuses anything an unfinished or still-writing download owns. */
  fun deletePath(relativePath: String, volumeId: String?) = synchronized(lock) {
    val volume = volumes.get(volumeId)
    val file = Volumes.resolveIn(volume, relativePath)
    liveOwnerTouching(volume.id, relativePath)?.let { throw DownloadException("invalid_state", "$relativePath belongs to unfinished download $it") }
    Files.delete(file)
  }

  fun move(from: String, to: String, volumeId: String?) = synchronized(lock) {
    val volume = volumes.get(volumeId)
    for (path in listOf(from, to)) {
      liveOwnerTouching(volume.id, path)?.let { throw DownloadException("invalid_state", "$path belongs to unfinished download $it") }
    }
    Files.move(Volumes.resolveIn(volume, from), Volumes.resolveIn(volume, to))
  }

  fun list(): List<Map<String, Any?>> = synchronized(lock) { tasks.values.map { snapshot(it) } }

  fun get(id: String): Map<String, Any?>? = synchronized(lock) { tasks[id]?.let { snapshot(it) } }

  fun settings(): Settings = synchronized(lock) { settings }

  fun setWifiOnly(wifiOnly: Boolean) = synchronized(lock) {
    if (settings.wifiOnly == wifiOnly) return
    settings = settings.copy(wifiOnly = wifiOnly)
    persist()
    // The job's network constraint carries the setting: end the running host, replace a pending request.
    if (host != null) releaseHost()
    if (tasks.values.any { it.isActive }) hostRequested = platform.requestHost(true, settings.wifiOnly, remainingBytes())
    pumpLocked()
  }

  fun setMaxConcurrent(maxConcurrent: Int) = synchronized(lock) {
    settings = settings.copy(maxConcurrent = maxConcurrent.coerceIn(1, 6))
    persist()
    pumpLocked()
  }

  fun pump() = synchronized(lock) { pumpLocked() }

  /** A visible app may get a host the background could not; a job left pending after a kill is replaced. */
  fun onForeground() = synchronized(lock) {
    if (host == null && tasks.values.any { it.isActive }) hostRequested = platform.requestHost(true, settings.wifiOnly, remainingBytes())
    pumpLocked()
  }

  fun uri(task: TaskRecord): String = runCatching { volumes.find(task.volumeId)?.let { android.net.Uri.fromFile(Volumes.resolveIn(it, task.relativePath)).toString() } }.getOrNull() ?: ""

  // endregion

  // region hosts

  fun attachHost(newHost: TransferHost) = synchronized(lock) {
    host?.takeIf { it !== newHost }?.finish()
    host = newHost
    hostRequested = true
    finished = 0
    failed = 0
    newHost.update(progressSnapshot())
    pumpLocked()
  }

  /** The host ended; true when the system will start it again (a job), so the engine waits for that. */
  fun detachHost(old: TransferHost, stop: HostStop, systemReschedules: Boolean): Boolean = synchronized(lock) {
    if (host !== old) return false
    host = null
    stopAll(StopReason.HOST)
    val blocked = blockedState()
    for (task in tasks.values.filter { it.isActive }) {
      when {
        stop == HostStop.USER -> pauseLocked(task)
        task.retryDue != null -> setState(task, States.RETRYING)
        else -> setState(task, blocked ?: States.QUEUED)
      }
    }
    stopTicker()
    persist()
    val reschedule = stop == HostStop.SYSTEM && systemReschedules && tasks.values.any { it.isActive }
    hostRequested = reschedule
    if (stop != HostStop.USER) pumpSoon()
    platform.log("host stopped ($stop), reschedule=$reschedule")
    reschedule
  }

  fun progressSnapshot(): ProgressSnapshot = synchronized(lock) {
    ProgressSnapshot(tasks.values.filter { it.isActive }.toList(), transfers.mapValues { it.value.bytes }, speeds.values.sumOf { it.perSecond }.toLong())
  }

  private fun remainingBytes() = tasks.values.filter { it.isActive }.sumOf { ((it.totalBytes ?: 0L) - it.bytesWritten).coerceAtLeast(0L) }

  private fun ensureHost() {
    if (host != null || hostRequested) return
    hostRequested = platform.requestHost(false, settings.wifiOnly, remainingBytes())
  }

  private fun releaseHost() {
    stopAll(StopReason.HOST)
    stopTicker()
    host?.finish()
    host = null
    hostRequested = false
    tasks.values.filter { it.state == States.RUNNING }.forEach { setState(it, States.QUEUED) }
  }

  private fun goIdle() {
    stopTicker()
    platform.observe(false) {}
    retryTimer?.cancel(false)
    val wasHosted = host != null
    host?.finish()
    host = null
    hostRequested = false
    platform.cancelHostRequest()
    if (wasHosted) platform.summary(finished, failed) else platform.clearNotification()
    finished = 0
    failed = 0
  }

  // endregion

  // region queue

  private fun pumpSoon() {
    pendingPump?.cancel(false)
    pendingPump = timer.schedule({ pump() }, 300, TimeUnit.MILLISECONDS)
  }

  private fun blockedState(): String? = when (platform.network()) {
    Net.NONE -> States.WAITING_NETWORK
    Net.METERED -> if (settings.wifiOnly) States.WAITING_WIFI else null
    Net.UNMETERED -> null
  }

  /** Missing volume: its unfinished tasks fail with `volume_unavailable`; they continue when it is back (N1-14). */
  private fun reconcileVolumes() {
    val mounted = volumes.all().map { it.id }.toSet()
    for (task in tasks.values) {
      val missing = task.volumeId !in mounted
      if (missing && task.isActive) {
        stopTransfer(task.id, StopReason.VOLUME)
        task.clearRetry()
        fail(task, DownloadError("file_system", VOLUME_UNAVAILABLE))
      } else if (!missing && task.state == States.FAILED && task.error?.message == VOLUME_UNAVAILABLE) {
        task.error = null
        task.attempts = 0
        setState(task, States.QUEUED)
      }
    }
  }

  private fun pumpLocked() {
    reconcileVolumes()
    val active = tasks.values.filter { it.isActive }
    val volumeWait = tasks.values.any { it.state == States.FAILED && it.error?.message == VOLUME_UNAVAILABLE }
    if (active.isEmpty()) {
      if (volumeWait) platform.observe(true) { pumpSoon() }
      if (transfers.isEmpty() && drains.isEmpty()) {
        if (volumeWait) {
          host?.finish()
          host = null
          hostRequested = false
          platform.cancelHostRequest()
        } else {
          goIdle()
        }
      }
      return
    }
    platform.observe(true) { pumpSoon() }
    val now = platform.elapsed()
    val blocked = blockedState()
    if (blocked != null) {
      // Network changes never shorten a server cooldown: retryDue stays (N1-08).
      transfers.keys.toList().forEach { stopTransfer(it, StopReason.NETWORK) }
      active.forEach { setState(it, blocked) }
      ensureHost()
      showProgress()
      persist()
      return
    }
    ensureHost()
    // JobScheduler restarts a job stopped by a network change only after its backoff; a visible app replaces it now.
    if (host == null && hostRequested && now - lastFastStart > FAST_START_MS && platform.visible()) {
      lastFastStart = now
      hostRequested = platform.requestHost(true, settings.wifiOnly, remainingBytes())
    }
    var nextRetry: Long? = null
    if (host == null) {
      for (task in active) {
        val due = task.retryDue
        when {
          due != null && due > now -> {
            setState(task, States.RETRYING)
            nextRetry = minOf(nextRetry ?: due, due)
          }
          task.state != States.QUEUED -> setState(task, States.QUEUED)
        }
      }
      scheduleRetry(nextRetry, now)
      persist()
      return
    }
    var slots = settings.maxConcurrent - transfers.size
    if (slots < 0) transfers.keys.toList().takeLast(-slots).forEach { stopTransfer(it, StopReason.CONCURRENCY) }
    for (task in active) {
      // A task whose stopped worker still ends gets no second one on the same file (N2-02).
      if (transfers.containsKey(task.id) || drainsOf(task).isNotEmpty()) continue
      val due = task.retryDue
      if (due != null && due > now) {
        setState(task, States.RETRYING)
        nextRetry = minOf(nextRetry ?: due, due)
        continue
      }
      if (slots > 0) {
        if (startTransfer(task)) slots -= 1
      } else if (task.state != States.QUEUED) {
        setState(task, States.QUEUED)
      }
    }
    scheduleRetry(nextRetry, now)
    if (transfers.isNotEmpty()) startTicker()
    showProgress()
    persist()
  }

  private fun scheduleRetry(at: Long?, now: Long) {
    retryTimer?.cancel(false)
    retryTimer = at?.let { timer.schedule({ pump() }, (it - now).coerceAtLeast(0), TimeUnit.MILLISECONDS) }
  }

  private fun startTransfer(task: TaskRecord): Boolean {
    val volume = volumes.find(task.volumeId) ?: run {
      fail(task, DownloadError("file_system", VOLUME_UNAVAILABLE))
      return false
    }
    val target = try {
      Volumes.resolveIn(volume, task.relativePath)
    } catch (error: DownloadException) {
      fail(task, DownloadError("file_system", error.message ?: "bad path"))
      return false
    }
    val transfer = Transfer(
      id = task.id,
      url = task.url,
      headers = task.headers,
      part = File(target.path + PART_SUFFIX),
      expectedBytes = task.expectedBytes,
      pinnedEtag = task.expectedEtag,
      etag = task.etag,
      knownTotal = task.totalBytes,
      space = this,
      listener = this,
    )
    transfers[task.id] = transfer
    speeds[task.id] = Speed(task.bytesWritten, platform.elapsed())
    task.clearRetry()
    setState(task, States.RUNNING)
    pool.execute(transfer)
    return true
  }

  /** The worker becomes a drain that keeps the task's paths until it ended; after `stop` it writes nothing more. */
  private fun stopTransfer(id: String, reason: StopReason) {
    val transfer = transfers.remove(id) ?: return
    drains[transfer] = Drain(tasks.getValue(id), dispose = false)
    speeds.remove(id)
    transfer.stop(reason)
  }

  private fun stopAll(reason: StopReason) = transfers.keys.toList().forEach { stopTransfer(it, reason) }

  /** Remaining bytes of this transfer plus every other running one on the volume, plus the reserve (N1-16). */
  override fun check(transfer: Transfer, remaining: Long): DownloadError? = synchronized(lock) {
    if (transfers[transfer.id] !== transfer) return null
    val task = tasks[transfer.id] ?: return null
    val volume = volumes.find(task.volumeId) ?: return DownloadError("file_system", VOLUME_UNAVAILABLE)
    val others = transfers.values.filter { it !== transfer }.sumOf { other ->
      val record = tasks[other.id]?.takeIf { it.volumeId == task.volumeId } ?: return@sumOf 0L
      ((record.totalBytes ?: 0L) - other.bytes).coerceAtLeast(0L)
    }
    val free = volume.freeBytes()
    if (free - others >= remaining + HttpPolicy.RESERVE_BYTES) return null
    DownloadError("disk_full", "needs $remaining bytes plus a 64 MiB reserve; $free free, $others reserved by other downloads")
  }

  override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, fromZero: Boolean, restarted: Boolean) = synchronized(lock) {
    val task = tasks[transfer.id] ?: return
    if (transfers[transfer.id] !== transfer) return
    task.totalBytes = totalBytes
    task.error = null
    if (fromZero) {
      // The part is already truncated and synced, so the new validator describes the bytes on disk (N1-02).
      task.etag = etag
      task.bytesWritten = 0
      task.checkpoint = 0
    }
    if (restarted) {
      task.restarts += 1
      platform.log("${task.id}: validator changed, starting over")
    }
    task.updatedAt = platform.now()
    emitState(task)
    persist()
  }

  /** Test seam: runs on the worker right before its outcome is applied. */
  @Volatile internal var beforeOutcome: ((Transfer, Outcome) -> Unit)? = null

  override fun onEnded(transfer: Transfer, outcome: Outcome) {
    beforeOutcome?.invoke(transfer, outcome)
    synchronized(lock) { applyOutcome(transfer, outcome) }
  }

  private fun applyOutcome(transfer: Transfer, outcome: Outcome) {
    drains.remove(transfer)?.let { drain ->
      val task = drain.task
      if (drain.dispose || tasks[task.id] !== task) {
        // A cancelled or removed task leaves nothing behind, not even a finished part; its claims end only now.
        transfer.part.delete()
      } else {
        task.bytesWritten = if (transfer.part.exists()) transfer.part.length() else 0
        task.checkpoint = transfer.durableBytes
        when (outcome) {
          // A stop requested meanwhile wins (pause): the complete part stays and the next start re-validates it.
          is Outcome.Ready -> Unit
          is Outcome.Stopped -> if ((outcome.reason == StopReason.CONCURRENCY || outcome.reason == StopReason.UPDATE) && task.isActive) setState(task, States.QUEUED)
          is Outcome.Failed -> if (outcome.droppedPartial) dropPartial(task, transfer, false)
        }
      }
      if (task.id in pending && disposedDrains(task.id).isEmpty()) {
        pending -= task.id
        settled += task.id
      }
      drain.latch.countDown()
      persist()
      pumpLocked()
      return
    }
    if (transfers[transfer.id] !== transfer) {
      pumpLocked()
      return
    }
    transfers.remove(transfer.id)
    speeds.remove(transfer.id)
    val task = tasks[transfer.id]
    if (task == null) {
      pumpLocked()
      return
    }
    task.bytesWritten = if (transfer.part.exists()) transfer.part.length() else 0
    task.checkpoint = transfer.durableBytes
    when (outcome) {
      // Re-checked under the lock: a stopped transfer never publishes (N2-02).
      is Outcome.Ready -> if (!transfer.stopped) publish(task, transfer, outcome)
      is Outcome.Stopped -> Unit
      is Outcome.Failed -> onFailed(task, transfer, outcome)
    }
    persist()
    pumpLocked()
  }

  /** Publication = completion, under the lock and only for the current transfer (N1-04, N1-07). */
  private fun publish(task: TaskRecord, transfer: Transfer, ready: Outcome.Ready) {
    val volume = volumes.find(task.volumeId) ?: return fail(task, DownloadError("file_system", VOLUME_UNAVAILABLE))
    val target = Volumes.resolveIn(volume, task.relativePath)
    when (val result = Publisher.publish(transfer.part, target, ready.total, task.expectedBytes, ready.etag, task.expectedEtag, task.etag)) {
      is Outcome.Ready -> {
        task.bytesWritten = ready.total
        task.totalBytes = ready.total
        task.attempts = 0
        task.waitingSince = null
        task.clearRetry()
        task.checkpoint = null
        task.error = null
        finished += 1
        setState(task, States.COMPLETED)
        emitProgress(task, 0.0)
      }
      is Outcome.Failed -> onFailed(task, transfer, result)
      else -> Unit
    }
  }

  private fun dropPartial(task: TaskRecord, transfer: Transfer, restart: Boolean) {
    transfer.part.delete()
    task.etag = null
    task.bytesWritten = 0
    task.checkpoint = 0
    if (restart) task.restarts += 1
  }

  private fun onFailed(task: TaskRecord, transfer: Transfer, outcome: Outcome.Failed) {
    if (!task.isActive) return
    if (outcome.droppedPartial) dropPartial(task, transfer, outcome.retryable)
    val progress = (transfer.bytes - transfer.startBytes).coerceAtLeast(0)
    if (outcome.retryable && platform.network() == Net.NONE) {
      if (progress > 0) task.waitingSince = null
      task.error = outcome.error
      setState(task, States.WAITING_NETWORK)
      return
    }
    val now = platform.elapsed()
    val decision = HttpPolicy.decideRetry(task.attempts, task.waitingSince, now, outcome.retryable, outcome.retryAfterMs, progress)
    task.attempts = decision.attempts
    task.waitingSince = decision.waitingSince
    val due = decision.retryAt
    if (decision.retry && due != null) {
      task.error = outcome.error
      task.retryDue = due
      task.retryDelay = due - now
      task.retryAt = platform.now() + (due - now)
      platform.log("${task.id}: ${outcome.error.message}, attempt ${task.attempts}, retry in ${due - now} ms")
      setState(task, States.RETRYING)
    } else {
      fail(task, outcome.error)
    }
  }

  private fun fail(task: TaskRecord, error: DownloadError) {
    task.error = error
    task.clearRetry()
    failed += 1
    platform.log("${task.id} failed: ${error.kind} ${error.message}")
    setState(task, States.FAILED)
  }

  // endregion

  // region ownership

  /** A task's final and staging path (N2-01). */
  private fun claimsOf(key: String) = listOf(key, key + PART_SUFFIX)

  private fun claimsOf(task: TaskRecord): List<String> =
    runCatching { claimsOf(Volumes.claimKey(task.volumeId, task.relativePath)) }.getOrDefault(emptyList())

  /** Equal, an ancestor directory or a descendant. */
  private fun overlaps(a: String, b: String) = a == b || a.startsWith("$b/") || b.startsWith("$a/")

  private fun conflicts(task: TaskRecord, claims: List<String>) = claimsOf(task).any { mine -> claims.any { overlaps(mine, it) } }

  /** A registered task (but a tombstone) or a still-ending worker of any task owns its paths (N1-03, N2-01, N2-02). */
  private fun ownerOf(claims: List<String>): String? =
    tasks.values.firstOrNull { it.state != States.CANCELLED && conflicts(it, claims) }?.id
      ?: drains.values.firstOrNull { conflicts(it.task, claims) }?.task?.id

  /** Unfinished or still-writing task whose file, partial or directory `relativePath` touches. */
  private fun liveOwnerTouching(volumeId: String, relativePath: String): String? {
    val claims = listOf(Volumes.claimKey(volumeId, relativePath))
    return tasks.values.firstOrNull { (it.isActive || transfers.containsKey(it.id)) && conflicts(it, claims) }?.id
      ?: drains.values.firstOrNull { conflicts(it.task, claims) }?.task?.id
  }

  private fun checkHeaders(headers: Map<String, String>) {
    val rejected = HttpPolicy.disallowedHeaders(headers)
    if (rejected.isNotEmpty()) throw DownloadException("invalid_argument", "headers not allowed: ${rejected.joinToString()}")
  }

  // endregion

  // region progress

  private fun startTicker() {
    if (ticker != null) return
    ticker = timer.scheduleWithFixedDelay({ tick() }, TICK_MS, TICK_MS, TimeUnit.MILLISECONDS)
  }

  private fun stopTicker() {
    ticker?.cancel(false)
    ticker = null
  }

  private fun tick() = synchronized(lock) {
    if (transfers.isEmpty()) {
      stopTicker()
      return
    }
    val now = platform.elapsed()
    for ((id, transfer) in transfers) {
      val task = tasks[id] ?: continue
      val bytes = transfer.bytes
      val speed = speeds.getOrPut(id) { Speed(bytes, now) }
      val elapsed = (now - speed.at).coerceAtLeast(1)
      val instant = (bytes - speed.bytes).coerceAtLeast(0) * 1000.0 / elapsed
      speed.perSecond = if (speed.perSecond == 0.0) instant else speed.perSecond * 0.7 + instant * 0.3
      speed.bytes = bytes
      speed.at = now
      task.checkpoint = transfer.durableBytes
      if (bytes != task.bytesWritten) {
        task.bytesWritten = bytes
        emitProgress(task, speed.perSecond)
      }
    }
    ticks += 1
    if (ticks % 2 == 0L) showProgress()
    if (ticks % 6 == 0L) persist()
  }

  private fun showProgress() {
    val current = host ?: return
    current.update(ProgressSnapshot(tasks.values.filter { it.isActive }.toList(), transfers.mapValues { it.value.bytes }, speeds.values.sumOf { it.perSecond }.toLong()))
  }

  // endregion

  private fun need(id: String) = tasks[id] ?: throw DownloadException("not_found", "no download $id")

  private fun partFile(task: TaskRecord): File? =
    runCatching { volumes.find(task.volumeId)?.let { File(Volumes.resolveIn(it, task.relativePath).path + PART_SUFFIX) } }.getOrNull()

  private fun snapshot(task: TaskRecord): Map<String, Any?> {
    transfers[task.id]?.let { task.bytesWritten = it.bytes }
    showRetryAt(task)
    return task.toMap(uri(task))
  }

  /** `retryAt` is only a wall-clock display of the elapsed deadline: recomputed whenever it is shown (N2-04). */
  private fun showRetryAt(task: TaskRecord) {
    task.retryAt = task.retryDue?.let { platform.now() + (it - platform.elapsed()) }
  }

  private fun setState(task: TaskRecord, state: String) {
    if (task.state == state) return
    task.state = state
    task.updatedAt = platform.now()
    emitState(task)
  }

  private fun emitState(task: TaskRecord, state: String = task.state) {
    showRetryAt(task)
    val map = task.toMap(uri(task)).toMutableMap().apply { put("state", state) }
    val event = mapOf("id" to task.id, "state" to state, "task" to map)
    listeners.forEach { runCatching { it.onState(event) } }
  }

  private fun emitProgress(task: TaskRecord, bytesPerSecond: Double) {
    val event = mapOf(
      "id" to task.id,
      "bytesWritten" to task.bytesWritten.toDouble(),
      "totalBytes" to task.totalBytes?.toDouble(),
      "bytesPerSecond" to bytesPerSecond,
    )
    listeners.forEach { runCatching { it.onProgress(event) } }
  }

  private fun persist() {
    val clock = SavedClock(platform.bootId(), platform.elapsed(), platform.now())
    runCatching { store.save(StoredState(settings, tasks.values.toList(), lastExitHandled, clock)) }.onFailure { platform.log("cannot save state: ${it.message}") }
  }

  companion object {
    const val PART_SUFFIX = ".part"
    const val VOLUME_UNAVAILABLE = "volume_unavailable"
    private const val TICK_MS = 500L
    const val CANCEL_PENDING = "cancel_pending"
    const val REMOVE_PENDING = "remove_pending"
    private const val DRAIN_TIMEOUT_MS = 30_000L
    private const val FAST_START_MS = 5_000L
  }
}
