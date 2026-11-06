package expo.modules.offlinedownloads

import android.app.Notification
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** Where transfers run: the user-initiated job (API 34+) or the dataSync foreground service. */
interface TransferHost {
  fun show(notification: Notification)
  fun finish()
}

/** Process-wide download queue: owns the registry, runs transfers inside a host and survives without JS. */
class DownloadEngine private constructor(private val context: Context) : TransferListener {
  interface Listener {
    fun onProgress(event: Map<String, Any?>)
    fun onState(event: Map<String, Any?>)
  }

  private val lock = Any()
  private val store = TaskStore(context)
  val volumes = Volumes(context)
  private val notifications = Notifications(context)
  private val network = NetworkWatcher(context) { pumpSoon() }
  private val listeners = CopyOnWriteArraySet<Listener>()
  private val pool = Executors.newCachedThreadPool { runnable -> Thread(runnable, "offline-download").apply { isDaemon = true } }
  private val timer = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "offline-download-timer").apply { isDaemon = true } }
  private var settings = Settings()
  private val tasks = LinkedHashMap<String, TaskRecord>()
  private val transfers = HashMap<String, Transfer>()
  private val stopping = HashMap<String, Transfer>()
  private val speeds = HashMap<String, Speed>()
  private var host: TransferHost? = null
  private var hostRequested = false
  private var ticker: ScheduledFuture<*>? = null
  private var pendingPump: ScheduledFuture<*>? = null
  private var retryTimer: ScheduledFuture<*>? = null
  private var ticks = 0L
  private var finished = 0
  private var failed = 0

  private class Speed(var bytes: Long, var at: Long, var perSecond: Double = 0.0)

  private fun load() = synchronized(lock) {
    val (loadedSettings, loaded) = store.load()
    settings = loadedSettings
    loaded.forEach { task ->
      if (task.state == States.RUNNING) task.state = States.QUEUED
      if (task.isActive || task.state == States.PAUSED || task.state == States.FAILED) task.bytesWritten = partFile(task)?.length() ?: task.bytesWritten
      tasks[task.id] = task
    }
    pumpLocked()
  }

  fun addListener(listener: Listener) = listeners.add(listener)

  fun removeListener(listener: Listener) = listeners.remove(listener)

  // region API

  fun start(spec: Map<String, Any?>): Map<String, Any?> = synchronized(lock) {
    val id = spec["id"] as? String ?: throw DownloadException("invalid_argument", "id is required")
    tasks[id]?.let { return it.toMap(uri(it)) }
    val url = spec["url"] as? String ?: throw DownloadException("invalid_argument", "url is required")
    if (!url.startsWith("http://") && !url.startsWith("https://")) throw DownloadException("invalid_argument", "url must be http(s)")
    val relativePath = spec["relativePath"] as? String ?: throw DownloadException("invalid_argument", "relativePath is required")
    val volumeId = spec["volumeId"] as? String ?: Volumes.INTERNAL
    volumes.resolve(relativePath, volumeId)
    @Suppress("UNCHECKED_CAST")
    val headers = (spec["headers"] as? Map<String, Any?>)?.mapValues { it.value.toString() } ?: emptyMap()
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
    )
    tasks[id] = task
    emitState(task)
    persist()
    pumpLocked()
    task.toMap(uri(task))
  }

  fun pause(id: String) = synchronized(lock) {
    val task = need(id)
    if (!task.isActive) return
    stopTransfer(id, StopReason.PAUSE)
    setState(task, States.PAUSED)
    task.retryAt = null
    persist()
    pumpLocked()
  }

  fun resume(id: String, url: String?, headers: Map<String, String>?) = synchronized(lock) {
    val task = need(id)
    if (url != null) {
      if (!url.startsWith("http://") && !url.startsWith("https://")) throw DownloadException("invalid_argument", "url must be http(s)")
      task.url = url
    }
    if (headers != null) task.headers = headers
    when {
      task.state == States.PAUSED || task.state == States.FAILED -> {
        task.attempts = 0
        task.error = null
        task.retryAt = null
        setState(task, States.QUEUED)
      }
      task.state == States.RETRYING -> {
        task.retryAt = null
        setState(task, States.QUEUED)
      }
      task.state == States.RUNNING && (url != null || headers != null) -> stopTransfer(id, StopReason.UPDATE)
    }
    persist()
    pumpLocked()
  }

  fun cancel(id: String) = synchronized(lock) {
    val task = need(id)
    tasks.remove(id)
    if (transfers.containsKey(id)) stopTransfer(id, StopReason.CANCEL) else partFile(task)?.delete()
    task.error = DownloadError("cancelled", "cancelled")
    emitState(task, States.CANCELLED)
    persist()
    pumpLocked()
  }

  fun remove(id: String) = synchronized(lock) {
    val task = need(id)
    if (task.isActive || task.state == States.PAUSED) throw DownloadException("invalid_state", "download $id is ${task.state}")
    tasks.remove(id)
    persist()
  }

  fun list(): List<Map<String, Any?>> = synchronized(lock) { tasks.values.map { snapshot(it) } }

  fun get(id: String): Map<String, Any?>? = synchronized(lock) { tasks[id]?.let { snapshot(it) } }

  fun settings(): Settings = synchronized(lock) { settings }

  fun setWifiOnly(wifiOnly: Boolean) = synchronized(lock) {
    if (settings.wifiOnly == wifiOnly) return
    settings = settings.copy(wifiOnly = wifiOnly)
    persist()
    // The job's network constraint carries the setting: end a running job, replace a pending one.
    if (Build.VERSION.SDK_INT >= 34 && host is JobHost) releaseHost()
    if (Build.VERSION.SDK_INT >= 34 && host == null && tasks.values.any { it.isActive }) hostRequested = scheduleJob(replace = true)
    pumpLocked()
  }

  fun setMaxConcurrent(maxConcurrent: Int) = synchronized(lock) {
    settings = settings.copy(maxConcurrent = maxConcurrent.coerceIn(1, 6))
    persist()
    pumpLocked()
  }

  fun pump() = synchronized(lock) { pumpLocked() }

  /** A job left pending after the process died is not always started again; the visible app replaces it with a fresh one. */
  fun onForeground() = synchronized(lock) {
    if (Build.VERSION.SDK_INT >= 34 && host == null && tasks.values.any { it.isActive }) hostRequested = scheduleJob(replace = true)
    pumpLocked()
  }

  fun uri(task: TaskRecord): String = runCatching { Uri.fromFile(volumes.resolve(task.relativePath, task.volumeId)).toString() }.getOrDefault("")

  // endregion

  // region hosts

  fun attachJob(service: DownloadJobService, params: JobParameters) = synchronized(lock) {
    host = JobHost(service, params)
    hostRequested = true
    finished = 0
    failed = 0
    host?.show(notification())
    pumpLocked()
  }

  /** onStopJob: true asks JobScheduler to run the job again (the queue is not done). */
  fun detachJob(params: JobParameters, stopReason: Int): Boolean = synchronized(lock) {
    val current = host as? JobHost
    if (current == null || current.params.jobId != params.jobId) return false
    host = null
    val after = when {
      Build.VERSION.SDK_INT >= 31 && stopReason == JobParameters.STOP_REASON_USER -> States.PAUSED
      else -> blockedState() ?: States.QUEUED
    }
    stopAll(StopReason.HOST)
    tasks.values.filter { it.isActive && it.state != States.RETRYING }.forEach { setState(it, after) }
    stopTicker()
    persist()
    // A job the app cancelled or replaced is not rescheduled by the system.
    val cancelledByApp = Build.VERSION.SDK_INT >= 31 && stopReason == JobParameters.STOP_REASON_CANCELLED_BY_APP
    val reschedule = !cancelledByApp && tasks.values.any { it.isActive }
    hostRequested = reschedule
    if (cancelledByApp) pumpSoon()
    Log.i(TAG, "job stopped (reason $stopReason), reschedule=$reschedule")
    reschedule
  }

  fun attachService(service: DownloadService) = synchronized(lock) {
    if (host is ServiceHost) return
    host = ServiceHost(service)
    hostRequested = true
    finished = 0
    failed = 0
    pumpLocked()
  }

  fun detachService(service: DownloadService) = synchronized(lock) {
    if ((host as? ServiceHost)?.service !== service) return
    host = null
    hostRequested = false
    stopAll(StopReason.HOST)
    tasks.values.filter { it.isActive && it.state != States.RETRYING }.forEach { setState(it, States.QUEUED) }
    stopTicker()
    persist()
  }

  fun notification(): Notification = synchronized(lock) {
    notifications.progress(tasks.values.filter { it.isActive }, transfers.mapValues { it.value.bytes }, speeds.values.sumOf { it.perSecond }.toLong())
  }

  private fun ensureHost() {
    if (host != null || hostRequested) return
    hostRequested = true
    if (Build.VERSION.SDK_INT >= 34 && scheduleJob()) return
    try {
      ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
    } catch (error: Exception) {
      // Android 12+ refuses a foreground service from the background; the next app start (or foreground) retries.
      Log.w(TAG, "cannot start the download service: ${error.message}")
      hostRequested = false
    }
  }

  /** A pending or running job (also one JobScheduler restarted after the process died) is kept unless `replace`. */
  private fun scheduleJob(replace: Boolean = false): Boolean {
    if (Build.VERSION.SDK_INT < 34) return false
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (!replace && scheduler.getPendingJob(JOB_ID) != null) return true
    val request = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
      .apply { if (settings.wifiOnly) addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) }
      .build()
    val remaining = tasks.values.filter { it.isActive }.sumOf { ((it.totalBytes ?: 0L) - it.bytesWritten).coerceAtLeast(0L) }
    val info = JobInfo.Builder(JOB_ID, ComponentName(context, DownloadJobService::class.java))
      .setUserInitiated(true)
      .setRequiredNetwork(request)
      .setEstimatedNetworkBytes(if (remaining > 0) remaining else JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), 0)
      .build()
    return try {
      scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS
    } catch (error: Exception) {
      Log.w(TAG, "cannot schedule the user-initiated job: ${error.message}")
      false
    }
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
    network.stop()
    retryTimer?.cancel(false)
    val wasHosted = host != null
    host?.finish()
    host = null
    hostRequested = false
    if (Build.VERSION.SDK_INT >= 34) runCatching { context.getSystemService(JobScheduler::class.java).cancel(JOB_ID) }
    if (wasHosted) notifications.summary(finished, failed) else notifications.cancel()
    finished = 0
    failed = 0
  }

  // endregion

  // region queue

  private fun pumpSoon() {
    pendingPump?.cancel(false)
    pendingPump = timer.schedule({ pump() }, 300, TimeUnit.MILLISECONDS)
  }

  private fun blockedState(): String? = when (network.current()) {
    Net.NONE -> States.WAITING_NETWORK
    Net.METERED -> if (settings.wifiOnly) States.WAITING_WIFI else null
    Net.UNMETERED -> null
  }

  private fun pumpLocked() {
    val active = tasks.values.filter { it.isActive }
    if (active.isEmpty()) {
      if (transfers.isEmpty() && stopping.isEmpty()) goIdle()
      return
    }
    network.start()
    val blocked = blockedState()
    if (blocked != null) {
      transfers.keys.toList().forEach { stopTransfer(it, StopReason.NETWORK) }
      active.forEach { setState(it, blocked) }
      ensureHost()
      showNotification()
      persist()
      return
    }
    ensureHost()
    if (host == null) {
      active.filter { it.state == States.WAITING_NETWORK || it.state == States.WAITING_WIFI }.forEach { setState(it, States.QUEUED) }
      return
    }
    val now = System.currentTimeMillis()
    var slots = settings.maxConcurrent - transfers.size
    if (slots < 0) transfers.keys.toList().takeLast(-slots).forEach { stopTransfer(it, StopReason.CONCURRENCY) }
    var nextRetry: Long? = null
    for (task in active) {
      if (transfers.containsKey(task.id) || stopping.containsKey(task.id)) continue
      val retryAt = task.retryAt
      if (task.state == States.RETRYING && retryAt != null && retryAt > now) {
        nextRetry = minOf(nextRetry ?: retryAt, retryAt)
        continue
      }
      if (slots > 0) {
        if (startTransfer(task)) slots -= 1
      } else if (task.state != States.QUEUED) {
        setState(task, States.QUEUED)
      }
    }
    retryTimer?.cancel(false)
    nextRetry?.let { at -> retryTimer = timer.schedule({ pump() }, (at - now).coerceAtLeast(0), TimeUnit.MILLISECONDS) }
    if (transfers.isNotEmpty()) startTicker()
    showNotification()
    persist()
  }

  private fun startTransfer(task: TaskRecord): Boolean {
    val target = try {
      volumes.resolve(task.relativePath, task.volumeId)
    } catch (error: DownloadException) {
      fail(task, DownloadError("file_system", error.message ?: "volume unavailable"))
      return false
    }
    val transfer = Transfer(
      id = task.id,
      url = task.url,
      headers = task.headers,
      part = File(target.path + PART_SUFFIX),
      target = target,
      volume = volumes.get(task.volumeId),
      expectedBytes = task.expectedBytes,
      expectedEtag = task.expectedEtag,
      etag = task.etag,
      lastModified = task.lastModified,
      knownTotal = task.totalBytes,
      listener = this,
    )
    transfers[task.id] = transfer
    speeds[task.id] = Speed(task.bytesWritten, System.currentTimeMillis())
    task.retryAt = null
    setState(task, States.RUNNING)
    pool.execute(transfer)
    return true
  }

  private fun stopTransfer(id: String, reason: StopReason) {
    val transfer = transfers.remove(id) ?: return
    stopping[id] = transfer
    speeds.remove(id)
    transfer.stop(reason)
  }

  private fun stopAll(reason: StopReason) = transfers.keys.toList().forEach { stopTransfer(it, reason) }

  override fun onResponse(transfer: Transfer, totalBytes: Long?, etag: String?, lastModified: String?, fromZero: Boolean, restarted: Boolean) =
    synchronized(lock) {
      val task = tasks[transfer.id] ?: return
      if (transfers[transfer.id] !== transfer) return
      task.totalBytes = totalBytes
      task.error = null
      if (fromZero) {
        task.etag = etag
        task.lastModified = lastModified
      }
      if (restarted) {
        task.restarts += 1
        Log.i(TAG, "${task.id}: validator changed, starting over")
      }
      task.updatedAt = System.currentTimeMillis()
      emitState(task)
      persist()
    }

  override fun onEnded(transfer: Transfer, outcome: Outcome) = synchronized(lock) {
    if (transfers[transfer.id] === transfer) transfers.remove(transfer.id)
    if (stopping[transfer.id] === transfer) stopping.remove(transfer.id)
    speeds.remove(transfer.id)
    val task = tasks[transfer.id]
    if (task == null) {
      transfer.part.delete()
      pumpLocked()
      return
    }
    task.bytesWritten = if (transfer.part.exists()) transfer.part.length() else transfer.bytes
    when (outcome) {
      is Outcome.Completed -> {
        task.bytesWritten = volumes.resolve(task.relativePath, task.volumeId).length()
        task.totalBytes = task.bytesWritten
        task.attempts = 0
        task.error = null
        finished += 1
        setState(task, States.COMPLETED)
        emitProgress(task, 0.0)
      }
      is Outcome.Stopped -> when (outcome.reason) {
        StopReason.CONCURRENCY, StopReason.UPDATE -> if (task.isActive) setState(task, States.QUEUED)
        else -> Unit
      }
      is Outcome.Failed -> onFailed(task, transfer, outcome)
    }
    persist()
    pumpLocked()
  }

  private fun onFailed(task: TaskRecord, transfer: Transfer, outcome: Outcome.Failed) {
    if (!task.isActive) return
    if (transfer.bytes - transfer.startBytes >= PROGRESS_RESETS_ATTEMPTS) task.attempts = 0
    if (outcome.retryable && network.current() == Net.NONE) {
      task.error = outcome.error
      setState(task, States.WAITING_NETWORK)
      return
    }
    // A Retry-After answer means the server is up and schedules us: it does not use up an attempt.
    if (outcome.retryAfterMs == null) task.attempts += 1
    task.error = outcome.error
    if (outcome.retryable && task.attempts < MAX_ATTEMPTS) {
      val delay = outcome.retryAfterMs ?: minOf(MAX_BACKOFF_MS, BASE_BACKOFF_MS shl (task.attempts - 1).coerceAtMost(10))
      task.retryAt = System.currentTimeMillis() + delay
      Log.i(TAG, "${task.id}: ${outcome.error.message}, retry ${task.attempts} in ${delay}ms")
      setState(task, States.RETRYING)
    } else {
      fail(task, outcome.error)
    }
  }

  private fun fail(task: TaskRecord, error: DownloadError) {
    task.error = error
    task.retryAt = null
    failed += 1
    Log.w(TAG, "${task.id} failed: ${error.kind} ${error.message}")
    setState(task, States.FAILED)
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
    val now = System.currentTimeMillis()
    for ((id, transfer) in transfers) {
      val task = tasks[id] ?: continue
      val bytes = transfer.bytes
      val speed = speeds.getOrPut(id) { Speed(bytes, now) }
      val elapsed = (now - speed.at).coerceAtLeast(1)
      val instant = (bytes - speed.bytes).coerceAtLeast(0) * 1000.0 / elapsed
      speed.perSecond = if (speed.perSecond == 0.0) instant else speed.perSecond * 0.7 + instant * 0.3
      speed.bytes = bytes
      speed.at = now
      if (bytes != task.bytesWritten) {
        task.bytesWritten = bytes
        emitProgress(task, speed.perSecond)
      }
    }
    ticks += 1
    if (ticks % 2 == 0L) showNotification()
    if (ticks % 20 == 0L) persist()
  }

  private fun showNotification() {
    val current = host ?: return
    current.show(notification())
  }

  // endregion

  private fun need(id: String) = tasks[id] ?: throw DownloadException("not_found", "no download $id")

  private fun partFile(task: TaskRecord): File? =
    runCatching { File(volumes.resolve(task.relativePath, task.volumeId).path + PART_SUFFIX) }.getOrNull()

  private fun snapshot(task: TaskRecord): Map<String, Any?> {
    transfers[task.id]?.let { task.bytesWritten = it.bytes }
    return task.toMap(uri(task))
  }

  private fun setState(task: TaskRecord, state: String) {
    if (task.state == state) return
    task.state = state
    task.updatedAt = System.currentTimeMillis()
    emitState(task)
  }

  private fun emitState(task: TaskRecord, state: String = task.state) {
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
    runCatching { store.save(settings, tasks.values) }.onFailure { Log.w(TAG, "cannot save state: ${it.message}") }
  }

  private inner class JobHost(val service: DownloadJobService, val params: JobParameters) : TransferHost {
    private var shown = false

    override fun show(notification: Notification) {
      if (Build.VERSION.SDK_INT < 34) return
      if (!shown) {
        service.setNotification(params, Notifications.NOTIFICATION_ID, notification, android.app.job.JobService.JOB_END_NOTIFICATION_POLICY_DETACH)
        shown = true
      } else {
        notifications.show(notification)
      }
    }

    override fun finish() = service.jobFinished(params, false)
  }

  private inner class ServiceHost(val service: DownloadService) : TransferHost {
    override fun show(notification: Notification) {
      notifications.show(notification)
    }

    override fun finish() = service.finish()
  }

  companion object {
    private const val TAG = "OfflineDownloads"
    const val JOB_ID = 0x0d1a
    const val PART_SUFFIX = ".part"
    private const val TICK_MS = 500L
    private const val MAX_ATTEMPTS = 8
    private const val BASE_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 60_000L
    private const val PROGRESS_RESETS_ATTEMPTS = 1L shl 20

    @Volatile private var instance: DownloadEngine? = null

    fun get(context: Context): DownloadEngine =
      instance ?: synchronized(this) { instance ?: DownloadEngine(context.applicationContext).also { instance = it; it.load() } }
  }
}
