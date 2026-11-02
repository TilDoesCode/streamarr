package expo.modules.embeddedserver

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URL
import java.util.ArrayDeque
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Process-wide supervisor of the Core Server child process: state machine, health polling, crash restarts with
 * backoff, credentials, and the status fan-out to the JS module, the foreground service and the OS ContentProvider.
 */
class ServerController private constructor(private val app: Context) {
  val settings = ServerSettings(app)
  val bundle = ServerBundle(app)
  val log = ServerLog(bundle.logDir)

  private val worker = Executors.newSingleThreadExecutor { Thread(it, "streamarr-server-supervisor") }
  private val main = Handler(Looper.getMainLooper())
  private val listeners = CopyOnWriteArraySet<(ServerStatus) -> Unit>()
  private val credentialsListeners = CopyOnWriteArraySet<(ServerCredentials) -> Unit>()
  private val lock = Any()

  private var status: ServerStatus = ServerStatus(
    state = ServerState.Stopped,
    port = settings.port,
    autostart = settings.autostart,
    dataPath = bundle.root.absolutePath,
    diskFreeBytes = bundle.diskFreeBytes(),
    bundleVersion = bundle.bundleVersion,
  )
  private var process: ServerProcess? = null
  private var generation = 0
  private var wanted = false
  private var spawnedAt = 0L
  private val restarts = ArrayDeque<Long>()
  private var restartCount = 0
  private var lastPasswordProbe = 0L
  private var service: EmbeddedServerService? = null
  private var changeNotifier: Runnable? = null

  init {
    watchNetwork()
  }

  fun status(): ServerStatus = synchronized(lock) { status.copy(diskFreeBytes = bundle.diskFreeBytes()) }

  fun addListener(listener: (ServerStatus) -> Unit) { listeners += listener }

  fun removeListener(listener: (ServerStatus) -> Unit) { listeners -= listener }

  fun addCredentialsListener(listener: (ServerCredentials) -> Unit) { credentialsListeners += listener }

  fun removeCredentialsListener(listener: (ServerCredentials) -> Unit) { credentialsListeners -= listener }

  fun logs(maxLines: Int): List<String> = log.tail(maxLines)

  /** Starts the foreground service, which runs the first attempt once it is in the foreground. */
  fun start(): ServerStatus {
    if (!bundle.present) throw ServerException(ServerException.BUNDLE_MISSING, "this build has no embedded server bundle")
    if (!bundle.host.exists()) throw ServerException(ServerException.BUNDLE_MISSING, "native host missing: ${bundle.host.absolutePath}")
    synchronized(lock) {
      if (status.state == ServerState.Starting || status.state == ServerState.Running) return status
      freePort(settings.port)
      wanted = true
      restarts.clear()
      restartCount = 0
      generation++
      update { it.copy(state = ServerState.Starting, lastError = null, restartCount = 0, port = settings.port) }
    }
    log.note("start requested")
    try {
      val intent = Intent(app, EmbeddedServerService::class.java).setAction(EmbeddedServerService.ACTION_START)
      androidx.core.content.ContextCompat.startForegroundService(app, intent)
    } catch (e: Exception) {
      val detail = "could not start the server service: ${e.message}"
      synchronized(lock) { fail(detail) }
      throw ServerException(ServerException.SERVICE_UNAVAILABLE, detail, e)
    }
    return status()
  }

  /** Stops the server and returns once the process is gone (`stop_failed` if it will not die). */
  fun stop(): ServerStatus {
    val running: ServerProcess?
    synchronized(lock) {
      if (status.state == ServerState.Stopped) return status
      wanted = false
      generation++
      running = process
      process = null
      update { it.copy(state = ServerState.Stopping) }
    }
    log.note("stop requested")
    val done = java.util.concurrent.CountDownLatch(1)
    worker.execute {
      try {
        running?.terminate(STOP_GRACE_MS)
      } finally {
        done.countDown()
      }
      main.post { service?.stopSelf() }
    }
    done.await(STOP_GRACE_MS + 10_000, java.util.concurrent.TimeUnit.MILLISECONDS)
    if (running?.isAlive == true) throw ServerException(ServerException.STOP_FAILED, "the server process did not exit")
    synchronized(lock) {
      if (!wanted) update { it.copy(state = ServerState.Stopped, runningPort = null, pid = null, startedAt = null, addresses = emptyList()) }
    }
    return status()
  }

  /** Stop, then start: a changed port applies. */
  fun restart(): ServerStatus {
    stop()
    return start()
  }

  fun setAutostart(enabled: Boolean): ServerStatus {
    settings.autostart = enabled
    synchronized(lock) { update { it.copy(autostart = enabled) } }
    return status()
  }

  /** Applies on the next start; the port actually bound (the next free one if needed) is `runningPort`. */
  fun setPort(port: Int): ServerStatus {
    if (port !in 1024..65535) throw ServerException(ServerException.START_FAILED, "port must be between 1024 and 65535")
    settings.port = port
    synchronized(lock) { update { it.copy(port = port) } }
    return status()
  }

  fun credentials(): ServerCredentials {
    probePasswordIfDue()
    return ServerCredentials(settings.adminUsername, if (settings.passwordChanged) null else settings.adminPassword)
  }

  /** New bootstrap password; a running server restarts so the server re-applies it. */
  fun resetAdminPassword(): ServerCredentials {
    val password = settings.rotateAdminPassword()
    settings.passwordChanged = false
    settings.resetPending = true
    log.note("admin password reset requested")
    val restart = synchronized(lock) { status.state == ServerState.Running || status.state == ServerState.Starting }
    if (restart) restartNow("password reset") else synchronized(lock) { update { it } }
    return ServerCredentials(settings.adminUsername, password).also { emitCredentials(it) }
  }

  private fun emitCredentials(credentials: ServerCredentials) {
    main.post { credentialsListeners.forEach { listener -> runCatching { listener(credentials) } } }
  }

  fun contractJson(): JSONObject {
    probePasswordIfDue()
    return status().toContractJson(settings.adminUsername, !settings.passwordChanged, bundle.serverVersion)
  }

  /** Called by the service once it is in the foreground. */
  fun onServiceStarted(service: EmbeddedServerService) {
    synchronized(lock) {
      this.service = service
      if (!wanted) {
        // The system restarted a sticky service after killing the process: honour the autostart setting.
        if (!settings.autostart) {
          main.post { service.stopSelf() }
          return
        }
        wanted = true
        generation++
        update { it.copy(state = ServerState.Starting, lastError = null) }
      }
      if (process != null) return
      val gen = generation
      worker.execute { attempt(gen) }
    }
  }

  fun onServiceDestroyed(service: EmbeddedServerService) {
    synchronized(lock) { if (this.service === service) this.service = null }
  }

  private fun restartNow(reason: String) {
    val running: ServerProcess?
    val gen: Int
    synchronized(lock) {
      generation++
      gen = generation
      running = process
      process = null
      update { it.copy(state = ServerState.Starting, runningPort = null, addresses = emptyList()) }
    }
    log.note("restarting: $reason")
    worker.execute {
      running?.terminate(STOP_GRACE_MS)
      attempt(gen)
    }
  }

  private fun attempt(gen: Int) {
    try {
      val appDir = bundle.ensureExtracted(log)
      val port = freePort(settings.port)
      val environment = environment(appDir, port)
      val command = listOf(bundle.host.absolutePath, File(appDir, SERVER_DLL).absolutePath, "--contentRoot", appDir.absolutePath)
      bundle.dataDir.mkdirs()
      bundle.cacheDir.mkdirs()
      File(bundle.cacheDir, "tmp").mkdirs()
      val started: ServerProcess
      synchronized(lock) {
        if (gen != generation) return
        log.note("spawning ${command.joinToString(" ")} on port $port")
        started = ServerProcess.start(command, environment, appDir, log)
        process = started
        spawnedAt = System.currentTimeMillis()
        update { it.copy(state = ServerState.Starting, pid = started.pid) }
      }
      Thread({ watch(gen, started) }, "streamarr-server-watch").apply { isDaemon = true }.start()
      waitForHealth(gen, started, port)
    } catch (e: Exception) {
      Log.w(TAG, "server start failed", e)
      val detail = if (e is ServerException) e.message ?: e.toString() else "${ServerException.START_FAILED}: ${e.message ?: e}"
      log.note(detail)
      synchronized(lock) { if (gen == generation) fail(detail) }
    }
  }

  private fun waitForHealth(gen: Int, started: ServerProcess, port: Int) {
    val deadline = System.currentTimeMillis() + START_TIMEOUT_MS
    while (System.currentTimeMillis() < deadline) {
      if (!started.isAlive) return
      val health = health(port)
      if (health != null) {
        synchronized(lock) {
          if (gen != generation) return
          settings.markStartedOnce()
          settings.resetPending = false
          if (!settings.autostart && !status.autostart) update { it.copy(autostart = settings.autostart) }
          update {
            it.copy(
              state = ServerState.Running,
              runningPort = port,
              startedAt = System.currentTimeMillis(),
              version = health.optString("version").substringBefore('+').ifEmpty { null },
              addresses = Addresses.enumerate(port),
              lastError = null,
            )
          }
        }
        log.note("healthy on port $port")
        Thread({ monitor(gen, started, port) }, "streamarr-server-health").apply { isDaemon = true }.start()
        return
      }
      Thread.sleep(500)
    }
    log.note("no health response within ${START_TIMEOUT_MS / 1000}s")
    synchronized(lock) { if (gen == generation) { process = null } }
    started.terminate(STOP_GRACE_MS)
    onExited(gen, started, hung = true)
  }

  private fun monitor(gen: Int, started: ServerProcess, port: Int) {
    var failures = 0
    while (started.isAlive) {
      Thread.sleep(HEALTH_INTERVAL_MS)
      synchronized(lock) { if (gen != generation) return }
      if (health(port) != null) {
        failures = 0
        continue
      }
      if (++failures < HEALTH_FAILURES) continue
      log.note("health check failed $failures times, restarting")
      synchronized(lock) { if (gen == generation) process = null }
      started.terminate(STOP_GRACE_MS)
      onExited(gen, started, hung = true)
      return
    }
  }

  private fun watch(gen: Int, started: ServerProcess) {
    while (started.isAlive) started.waitFor(60_000)
    onExited(gen, started, hung = false)
  }

  private fun onExited(gen: Int, started: ServerProcess, hung: Boolean) {
    val code = started.exitCode()
    synchronized(lock) {
      if (gen != generation) return
      process = null
      if (!wanted) {
        update { it.copy(state = ServerState.Stopped, runningPort = null, pid = null, startedAt = null, addresses = emptyList()) }
        return
      }
      val lifetime = System.currentTimeMillis() - spawnedAt
      val detail = if (hung) "The server stopped responding" else "The server exited with code $code"
      log.note("$detail after ${lifetime / 1000}s")
      if (!hung && lifetime < ICU_FAILURE_WINDOW_MS && !settings.invariantGlobalization && log.contains("ICU")) {
        settings.invariantGlobalization = true
        log.note("no usable ICU on this device, switching to invariant globalization")
        scheduleRestart(gen, 0)
        return
      }
      val now = System.currentTimeMillis()
      while (restarts.isNotEmpty() && now - restarts.first() > RESTART_WINDOW_MS) restarts.pollFirst()
      if (restarts.size >= MAX_RESTARTS) {
        fail("$detail; gave up after $MAX_RESTARTS restarts in ${RESTART_WINDOW_MS / 60_000} minutes. ${log.lastErrorHint() ?: ""}".trim())
        return
      }
      restarts.addLast(now)
      restartCount++
      val delay = RESTART_BASE_DELAY_MS shl (restarts.size - 1)
      update { it.copy(state = ServerState.Starting, runningPort = null, pid = null, startedAt = null, addresses = emptyList(), restartCount = restartCount, lastError = detail) }
      scheduleRestart(gen, delay)
    }
  }

  private fun scheduleRestart(gen: Int, delayMs: Long) {
    log.note("restart in ${delayMs}ms")
    worker.execute {
      if (delayMs > 0) Thread.sleep(delayMs)
      synchronized(lock) { if (gen != generation) return@execute }
      attempt(gen)
    }
  }

  private fun fail(message: String) {
    wanted = false
    update { it.copy(state = ServerState.Failed, lastError = message, runningPort = null, pid = null, startedAt = null, addresses = emptyList()) }
    main.post { service?.stopSelf() }
  }

  private fun environment(appDir: File, port: Int): Map<String, String> {
    val data = bundle.dataDir.absolutePath
    val cache = bundle.cacheDir.absolutePath
    val env = linkedMapOf(
      "HOME" to data,
      "TMPDIR" to "$cache/tmp",
      "LD_LIBRARY_PATH" to "${appDir.absolutePath}:${bundle.nativeLibraryDir}",
      "DOTNET_gcServer" to "0",
      "DOTNET_GCConserveMemory" to "5",
      "DOTNET_CLI_TELEMETRY_OPTOUT" to "1",
      "ASPNETCORE_URLS" to "http://0.0.0.0:$port",
      "ASPNETCORE_ENVIRONMENT" to "Production",
      "Streamarr__Host" to "android",
      "Streamarr__ConnectionString" to "Data Source=$data/streamarr.db",
      "Streamarr__DataProtectionKeysPath" to "$data/keys",
      "Streamarr__NzbCachePath" to "$data/nzb",
      "Streamarr__Repair__WorkspacePath" to "$cache/repair",
      "Streamarr__PreDownload__CachePath" to "$cache/predownload",
      "Streamarr__Transcoding__WorkspacePath" to "$cache/transcode",
      "Streamarr__Transcoding__SamplesPath" to "$cache/transcoding-samples",
      "Streamarr__Transcoding__LocalSourceBaseUrl" to "http://127.0.0.1:$port",
      "Streamarr__Transcoding__FfmpegPath" to bundle.ffmpeg.absolutePath,
      "Streamarr__Transcoding__FfprobePath" to bundle.ffprobe.absolutePath,
      "Streamarr__FfprobePath" to bundle.ffprobe.absolutePath,
      "Streamarr__Admin__Username" to settings.adminUsername,
      "Streamarr__Admin__Password" to settings.adminPassword,
      "Streamarr__ApiKey" to settings.apiKey,
    )
    if (settings.resetPending) env["Streamarr__Admin__ResetOnStart"] = "true"
    bundle.tunnelHelper?.let { env["Streamarr__Tunnels__HelperPath"] = it.absolutePath }
    if (settings.invariantGlobalization) {
      env["DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"] = "1"
      env["DOTNET_SYSTEM_GLOBALIZATION_PREDEFINED_CULTURES_ONLY"] = "0"
    }
    return env
  }

  private fun health(port: Int): JSONObject? = runCatching {
    val connection = URL("http://127.0.0.1:$port/api/v1/health").openConnection() as HttpURLConnection
    connection.connectTimeout = 2_000
    connection.readTimeout = 3_000
    try {
      if (connection.responseCode != 200) null else JSONObject(connection.inputStream.bufferedReader().readText())
    } finally {
      connection.disconnect()
    }
  }.getOrNull()

  // A failed login with the generated password means the admin changed it in the web UI.
  private fun probePasswordIfDue() {
    val running = synchronized(lock) { status.state == ServerState.Running }
    val now = System.currentTimeMillis()
    if (!running || now - lastPasswordProbe < PASSWORD_PROBE_INTERVAL_MS) return
    lastPasswordProbe = now
    val port = status().runningPort ?: return
    val code = runCatching {
      val connection = URL("http://127.0.0.1:$port/api/v1/auth/login").openConnection() as HttpURLConnection
      connection.connectTimeout = 2_000
      connection.readTimeout = 5_000
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "application/json")
      val body = JSONObject().put("username", settings.adminUsername).put("password", settings.adminPassword).toString()
      connection.outputStream.use { it.write(body.toByteArray()) }
      try { connection.responseCode } finally { connection.disconnect() }
    }.getOrNull() ?: return
    val changed = when (code) {
      200 -> false
      401 -> true
      else -> return
    }
    if (changed != settings.passwordChanged) {
      settings.passwordChanged = changed
      synchronized(lock) { update { it } }
      emitCredentials(ServerCredentials(settings.adminUsername, if (changed) null else settings.adminPassword))
    }
  }

  private fun freePort(preferred: Int): Int {
    for (port in preferred until preferred + PORT_SEARCH_RANGE) {
      val free = runCatching { ServerSocket().use { it.reuseAddress = true; it.bind(InetSocketAddress("0.0.0.0", port)) }; true }.getOrDefault(false)
      if (free) return port
    }
    throw ServerException(ServerException.PORT_IN_USE, "no free port between $preferred and ${preferred + PORT_SEARCH_RANGE - 1}")
  }

  private fun watchNetwork() {
    val connectivity = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
    runCatching {
      connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = refreshAddresses()
        override fun onLost(network: Network) = refreshAddresses()
        override fun onLinkPropertiesChanged(network: Network, linkProperties: android.net.LinkProperties) = refreshAddresses()
      })
    }
  }

  private fun refreshAddresses() {
    synchronized(lock) {
      if (status.state != ServerState.Running) return
      val addresses = Addresses.enumerate(status.runningPort ?: status.port)
      if (addresses != status.addresses) update { it.copy(addresses = addresses) }
    }
  }

  // Always called with the lock held; listeners run on the main thread with a fresh snapshot.
  private fun update(change: (ServerStatus) -> ServerStatus) {
    status = change(status)
    val snapshot = status
    main.post {
      listeners.forEach { listener -> runCatching { listener(snapshot) } }
      notifyProvider()
    }
  }

  private fun notifyProvider() {
    if (changeNotifier != null) return
    changeNotifier = Runnable {
      changeNotifier = null
      runCatching { app.contentResolver.notifyChange(ServerStateProvider.STATE_URI, null) }
    }.also { main.postDelayed(it, PROVIDER_DEBOUNCE_MS) }
  }

  companion object {
    private const val TAG = "EmbeddedServer"
    private const val SERVER_DLL = "Streamarr.Server.dll"
    private const val START_TIMEOUT_MS = 120_000L
    private const val STOP_GRACE_MS = 10_000L
    private const val HEALTH_INTERVAL_MS = 15_000L
    private const val HEALTH_FAILURES = 3
    private const val MAX_RESTARTS = 5
    private const val RESTART_WINDOW_MS = 10 * 60_000L
    private const val RESTART_BASE_DELAY_MS = 1_000L
    private const val ICU_FAILURE_WINDOW_MS = 20_000L
    private const val PASSWORD_PROBE_INTERVAL_MS = 30_000L
    private const val PORT_SEARCH_RANGE = 20
    private const val PROVIDER_DEBOUNCE_MS = 150L

    @Volatile private var instance: ServerController? = null

    fun get(context: Context): ServerController = instance ?: synchronized(this) {
      instance ?: ServerController(context.applicationContext).also { instance = it }
    }
  }
}
