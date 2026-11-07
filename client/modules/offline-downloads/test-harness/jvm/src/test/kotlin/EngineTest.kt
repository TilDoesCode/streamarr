package expo.modules.offlinedownloads

import expo.modules.offlinedownloads.Fixtures.Fixture
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.BeforeClass
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test

/** The actual DownloadEngine on the host JVM with a fake platform: queue, ownership, publication, retries, volumes. */
class EngineTest {
  companion object {
    @JvmStatic @BeforeClass fun setUp() = Fixtures.install()
  }

  class FakePlatform(private val dir: File) : EnginePlatform {
    lateinit var engine: DownloadEngine
    @Volatile var net = Net.UNMETERED
    @Volatile var exit: ExitInfo? = null
    val extraVolumes = CopyOnWriteArrayList<Volume>()
    val logs = CopyOnWriteArrayList<String>()
    @Volatile var onChange: (() -> Unit)? = null
    @Volatile var hostRequests = 0
    val warns = CopyOnWriteArrayList<String>()

    /** A small JobScheduler: one job (state + token); `autoHost` starts each scheduled job at once, else `startJob()`. */
    @Volatile var autoHost = true
    @Volatile var visibleApp = false
    @Volatile var job = HostJob.NONE
    @Volatile var jobToken: Long? = null
    val requests = CopyOnWriteArrayList<Pair<Long, Boolean>>()
    @Volatile var cancels = 0

    /** Shift the wall clock (rollback / jump) or the elapsed clock; `boot` changes on a simulated reboot. */
    @Volatile var wallShift = 0L
    @Volatile var elapsedShift = 0L
    @Volatile var boot: String? = "boot-1"

    override val stateDir = File(dir, "state")
    override fun now() = System.currentTimeMillis() + wallShift
    override fun elapsed() = TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) + elapsedShift
    override fun bootId() = boot
    override fun log(message: String) { logs += message }
    override fun warn(message: String) { warns += message; logs += message }
    override fun network() = net
    override fun observe(active: Boolean, onChange: () -> Unit) { this.onChange = if (active) onChange else null }
    override fun volumes() = listOf(Volume(Volumes.INTERNAL, File(dir, "internal"), false)) + extraVolumes
    override fun requestHost(token: Long, replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Long? {
      hostRequests += 1
      requests += token to replace
      if (!replace && job != HostJob.NONE) return jobToken
      job = HostJob.PENDING
      jobToken = token
      if (autoHost) thread { startJob() }
      return token
    }
    override fun hostJob() = job
    override fun cancelHostRequest() {
      cancels += 1
      job = HostJob.NONE
      jobToken = null
    }

    /** JobScheduler starts the scheduled job: its host attaches with the job's token. */
    fun startJob(): Host {
      val host = Host(jobToken ?: error("no job scheduled"))
      job = HostJob.RUNNING
      engine.attachHost(host)
      return host
    }
    override fun summary(finished: Int, failed: Int) {}
    override fun clearNotification() {}
    override fun lastExit() = exit
    override fun visible() = visibleApp

    inner class Host(override val token: Long) : TransferHost {
      @Volatile var finished = false
      override fun update(progress: ProgressSnapshot) {}
      override fun finish() {
        finished = true
        if (jobToken == token) {
          job = HostJob.NONE
          jobToken = null
        }
      }
    }
  }

  class Events : DownloadEngine.Listener {
    val all = CopyOnWriteArrayList<String>()
    override fun onProgress(event: Map<String, Any?>) { all += "progress:${event["id"]}:${(event["bytesWritten"] as Double).toLong()}" }
    override fun onState(event: Map<String, Any?>) { all += "state:${event["id"]}:${event["state"]}" }
  }

  private fun engine(name: String, configure: (FakePlatform) -> Unit = {}): Triple<DownloadEngine, FakePlatform, Events> {
    val root = Fixtures.work("engine-$name")
    val platform = FakePlatform(root).also(configure)
    val engine = DownloadEngine(platform)
    platform.engine = engine
    val events = Events()
    engine.addListener(events)
    engine.load()
    return Triple(engine, platform, events)
  }

  private fun await(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
    val until = System.currentTimeMillis() + timeoutMs
    while (!condition()) {
      if (System.currentTimeMillis() > until) fail("timed out waiting for $what")
      Thread.sleep(10)
    }
  }

  private fun DownloadEngine.state(id: String) = get(id)?.get("state")

  /** Body that blocks after `head` until `release` opens (a read nothing can interrupt); `entered` marks the block. */
  private fun gated(head: String, tail: String, release: CountDownLatch, entered: CountDownLatch? = null): () -> InputStream = {
    object : InputStream() {
      var step = 0
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int = when (step++) {
        0 -> { head.toByteArray().copyInto(b, off); head.length }
        1 -> { entered?.countDown(); release.await(20, TimeUnit.SECONDS); tail.toByteArray().copyInto(b, off); tail.length }
        else -> -1
      }
    }
  }

  /** Like a socket that stalls after `head`: the read blocks until the connection is closed, then fails. */
  private fun stalled(head: String, entered: CountDownLatch): () -> InputStream = {
    object : InputStream() {
      val closed = CountDownLatch(1)
      var step = 0
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (step++ == 0) {
          head.toByteArray().copyInto(b, off)
          return head.length
        }
        entered.countDown()
        closed.await(20, TimeUnit.SECONDS)
        throw IOException("socket closed")
      }
      override fun close() = closed.countDown()
    }
  }

  private fun code(block: () -> Unit) = (runCatching(block).exceptionOrNull() as? DownloadException)?.code

  private fun message(block: () -> Unit) = runCatching(block).exceptionOrNull()?.message

  private fun spec(id: String, host: String, path: String = "acc/$id.bin", size: Long = 8, volume: String = Volumes.INTERNAL) =
    mapOf("id" to id, "url" to Fixtures.url(host), "relativePath" to path, "expectedBytes" to size, "volumeId" to volume)

  private fun file(platform: FakePlatform, path: String) = File(platform.volumes().first().root, path)

  /** A body that delivers `head`, then the connection drops. */
  private fun cut(head: String): () -> InputStream = {
    object : InputStream() {
      var step = 0
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (step++ > 0) throw IOException("connection reset")
        head.toByteArray().copyInto(b, off)
        return head.length
      }
    }
  }

  /** N2-12 parity with iOS: a revoked capability's 4xx body is never content; the kept bytes continue under a new URL. */
  private fun revokedRetryKeepsTheBytes(status: Int, code: String) {
    val name = "revoked-$status"
    Fixtures.responses[name] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    val (engine, platform, _) = engine(name)
    engine.start(spec("a", name))
    await("retrying after the cut") { engine.state("a") == States.RETRYING }
    val body = "{\"code\":\"$code\"}".toByteArray()
    Fixtures.responses[name] = Fixture(status, mapOf("Content-Type" to "application/json"), body)
    engine.resume("a", null, null)
    await("failed $status") { engine.state("a") == States.FAILED }
    val failed = engine.get("a")!!
    assertEquals(status, ((failed["error"] as Map<*, *>)["httpStatus"] as Number).toInt())
    assertEquals(4.0, failed["bytesWritten"])
    assertEquals("AAAA", file(platform, "acc/a.bin.part").readText())
    // Read with read(buf, off, len) only (the stub has no readNBytes, as on Android 7–12, N3-08); redacted and capped (N3-07).
    assertTrue(platform.logs.joinToString("\n"), platform.logs.contains("a: HTTP $status type=application/json length=${body.size} body: {\"code\":\"$code\"}"))
    assertEquals("bytes=4-", Fixtures.requests[name]!!.last()["Range"])
    Fixtures.responses["$name-renewed"] = Fixtures.partial("bytes 4-7/8", body = "BBBB")
    engine.resume("a", Fixtures.url("$name-renewed"), null)
    await("completed under the renewed URL") { engine.state("a") == States.COMPLETED }
    val renewed = Fixtures.requests["$name-renewed"]!!.single()
    assertEquals("bytes=4-", renewed["Range"])
    assertEquals("\"a\"", renewed["If-Range"])
    assertEquals("AAAABBBB", file(platform, "acc/a.bin").readText())
    assertEquals(0, (engine.get("a")!!["restarts"] as Number).toInt())
  }

  @Test fun aRevokedCapabilitysGoneAnswerKeepsThePartialForTheRenewedUrl() = revokedRetryKeepsTheBytes(410, "capability_revoked")

  @Test fun aForbiddenAnswerKeepsThePartialForTheRenewedUrl() = revokedRetryKeepsTheBytes(403, "downloads_not_allowed")

  /** Was BUG_twoWritersOnePathFirstTaskPublishesOtherTasksBytes (N1-03). */
  @Test fun aPathBelongsToOneTask() {
    val release = CountDownLatch(1)
    Fixtures.responses["owner-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    val (engine, _, _) = engine("owner")
    engine.start(spec("a", "owner-a", "acc/w/movie.bin"))
    await("a running") { engine.state("a") == States.RUNNING }
    val error = runCatching { engine.start(spec("b", "owner-a", "ACC/w//./movie.bin")) }.exceptionOrNull()
    assertEquals("invalid_state: path ACC/w//./movie.bin belongs to download a", error?.message)
    release.countDown()
    await("a completed") { engine.state("a") == States.COMPLETED }
    assertTrue(runCatching { engine.start(spec("b", "owner-a", "acc/w/movie.bin")) }.exceptionOrNull()?.message!!.startsWith("invalid_state"))
    engine.remove("a")
    engine.start(spec("b", "owner-a", "acc/w/movie.bin"))
  }

  /** Was BUG_cancelBetweenRenameAndCallbackLeavesFinal (N1-07): a cancelled generation never publishes. */
  @Test fun cancelRacingTheLastByteLeavesNoFile() {
    Fixtures.responses["race"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    val (engine, platform, events) = engine("race")
    val cancelled = CountDownLatch(1)
    engine.beforeOutcome = { _, outcome ->
      if (outcome is Outcome.Ready) {
        thread { engine.cancel("a"); cancelled.countDown() }
        await("cancel registered") { engine.get("a") == null }
      }
    }
    engine.start(spec("a", "race"))
    assertTrue(cancelled.await(10, TimeUnit.SECONDS))
    assertFalse(file(platform, "acc/a.bin").exists())
    assertFalse(file(platform, "acc/a.bin.part").exists())
    assertTrue("state:a:cancelled" in events.all)
    assertFalse("state:a:completed" in events.all)
    engine.start(spec("a2", "race", "acc/a.bin"))
  }

  /** Was BUG_moveLivePartPublishesIncompleteFileOutsideTask (N1-07). */
  @Test fun liveFilesCannotBeMovedOrDeleted() {
    val release = CountDownLatch(1)
    Fixtures.responses["live"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("BB", "BBBBBB", release))
    val (engine, platform, _) = engine("live")
    engine.start(spec("a", "live", "acc/w/a.bin"))
    await("running") { engine.state("a") == States.RUNNING }
    for (attempt in listOf<() -> Unit>(
      { engine.move("acc/w/a.bin.part", "published.bin", null) },
      { engine.move("other.bin", "acc/w/a.bin", null) },
      { engine.deletePath("acc/w", null) },
      { engine.deletePath("acc/w/a.bin.part", null) },
      { engine.deletePath("acc", null) },
    )) {
      assertTrue(runCatching(attempt).exceptionOrNull()?.message!!.startsWith("invalid_state"))
    }
    release.countDown()
    await("completed") { engine.state("a") == States.COMPLETED }
    engine.deletePath("acc/w", null)
    assertFalse(file(platform, "acc/w").exists())
  }

  @Test fun cancelResolvesAfterTheWorkerEnded() {
    val release = CountDownLatch(1)
    Fixtures.responses["drain"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    val (engine, platform, _) = engine("drain")
    engine.start(spec("a", "drain"))
    await("running") { engine.state("a") == States.RUNNING }
    thread { Thread.sleep(200); release.countDown() }
    engine.cancel("a")
    assertFalse(file(platform, "acc/a.bin.part").exists())
    assertFalse(file(platform, "acc/a.bin").exists())
    engine.start(spec("a", "drain"))
  }

  private fun relaunch(root: File, configure: (FakePlatform) -> Unit = {}): DownloadEngine {
    val platform = FakePlatform(root).also(configure)
    return DownloadEngine(platform).also { platform.engine = it; it.load() }
  }

  /** Fix round 1c: the notification's Cancel survives a process death as a tombstone until remove. */
  @Test fun notificationCancelLeavesATombstoneAcrossARestart() {
    val release = CountDownLatch(1)
    Fixtures.responses["tomb-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    val (engine, platform, events) = engine("tombstone")
    engine.setMaxConcurrent(1)
    engine.start(spec("a", "tomb-a", "acc/w/movie.bin"))
    await("a running") { engine.state("a") == States.RUNNING }
    engine.start(spec("b", "tomb-b", "acc/w/queued.bin"))
    file(platform, "acc/w/queued.bin.part").writeText("BB")
    engine.start(spec("d", "tomb-b", "acc/w/app.bin"))
    engine.cancel("d")
    thread { Thread.sleep(200); release.countDown() }
    engine.cancelAll()
    assertTrue(events.all.containsAll(listOf("state:a:cancelled", "state:b:cancelled", "state:d:cancelled")))
    assertFalse(events.all.contains("state:b:running"))
    for (path in listOf("acc/w/movie.bin.part", "acc/w/movie.bin", "acc/w/queued.bin.part")) assertFalse(path, file(platform, path).exists())
    val tombstones = engine.list()
    assertEquals(listOf("a", "b"), tombstones.map { it["id"] })
    tombstones.forEach { task ->
      assertEquals(States.CANCELLED, task["state"])
      assertEquals(0.0, task["bytesWritten"])
      assertNull(task["error"])
    }
    assertEquals("acc/w/movie.bin", tombstones[0]["relativePath"])
    assertEquals(Fixtures.url("tomb-a"), tombstones[0]["url"])

    // Process death while a's worker still drained: its partial is left behind.
    file(platform, "acc/w/movie.bin.part").writeText("AAAA")
    val root = platform.stateDir.parentFile
    val next = relaunch(root)
    assertEquals(listOf("a" to States.CANCELLED, "b" to States.CANCELLED), next.list().map { it["id"] to it["state"] })
    assertTrue(next.list().all { it["bytesWritten"] == 0.0 && it["error"] == null })
    assertFalse(file(platform, "acc/w/movie.bin.part").exists())
    assertEquals(States.CANCELLED, next.start(spec("a", "tomb-a", "acc/w/movie.bin"))["state"])
    next.remove("b")
    next.remove("b")
    next.remove("never-known")

    val third = relaunch(root)
    assertEquals(listOf("a"), third.list().map { it["id"] })
    third.remove("a")
    assertEquals(emptyList<Any>(), relaunch(root).list())
  }

  /** Fix round 1c: once the path is free, cancel(tombstone) only forgets it and never touches the newer download. */
  @Test fun cancellingATombstoneNeverTouchesTheNextDownloadOnItsPath() {
    val first = CountDownLatch(1)
    val second = CountDownLatch(1)
    Fixtures.responses["path-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", first))
    Fixtures.responses["path-c"] = Fixture(200, mapOf("ETag" to "\"c\""), ByteArray(8), gated("CCCC", "CCCC", second))
    val (engine, platform, events) = engine("tombstone-path")
    engine.start(spec("a", "path-a", "acc/w/movie.bin"))
    await("a running") { engine.state("a") == States.RUNNING }
    thread { Thread.sleep(200); first.countDown() }
    engine.cancelAll()
    engine.start(spec("c", "path-c", "ACC/w/movie.bin"))
    await("c wrote") { file(platform, "acc/w/movie.bin.part").length() == 4L }
    engine.cancel("a")
    assertNull(engine.get("a"))
    assertEquals(1, events.all.count { it == "state:a:cancelled" })
    assertEquals("CCCC", file(platform, "acc/w/movie.bin.part").readText())
    second.countDown()
    await("c completed") { engine.state("c") == States.COMPLETED }
    assertEquals("CCCCCCCC", file(platform, "acc/w/movie.bin").readText())
  }

  /** Fix round 1c: a relaunch deletes a tombstone's leftover partial only while no newer task owns the path. */
  @Test fun aRelaunchNeverDeletesThePartialOfANewerDownload() {
    val root = Fixtures.work("engine-tombstone-load")
    val internal = File(root, "internal")
    File(internal, "acc/w").mkdirs()
    File(internal, "acc/w/movie.bin.part").writeText("CCCC")
    File(internal, "acc/w/old.bin.part").writeText("OO")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/w/movie.bin", Volumes.INTERNAL, 8, null, null, States.CANCELLED),
      TaskRecord("c", Fixtures.url("never"), emptyMap(), "ACC/w/movie.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, bytesWritten = 4, checkpoint = 4),
      TaskRecord("z", Fixtures.url("never"), emptyMap(), "acc/w/old.bin", Volumes.INTERNAL, 8, null, null, States.CANCELLED, bytesWritten = 2),
    )))
    val engine = relaunch(root)
    assertEquals("CCCC", File(internal, "acc/w/movie.bin.part").readText())
    assertEquals(4.0, engine.get("c")!!["bytesWritten"])
    assertFalse(File(internal, "acc/w/old.bin.part").exists())
    assertEquals(listOf(0.0, 0.0), listOf("a", "z").map { engine.get(it)!!["bytesWritten"] })
  }

  /** Was REPRO_partAliasPublishesAnotherTasksBytes (N2-01): a task owns its final and its staging path. */
  @Test fun aTaskOwnsItsStagingPathAndTheDirectoriesAround() {
    val release = CountDownLatch(1)
    Fixtures.responses["alias-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    Fixtures.responses["alias-b"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val (engine, platform, _) = engine("alias")
    engine.start(spec("a", "alias-a", "acc/movie.bin"))
    await("a running") { engine.state("a") == States.RUNNING }
    assertEquals("invalid_argument", code { engine.start(spec("b1", "alias-b", "acc/movie.bin.part")) })
    assertEquals("invalid_argument", code { engine.start(spec("b2", "alias-b", "ACC//Movie.Bin.PART")) })
    for (path in listOf("acc/movie.bin.part/x", "acc/movie.bin/x", "ACC/Movie.bin", "acc")) {
      assertEquals(path, "invalid_state", code { engine.start(spec("b-$path", "alias-b", path)) })
    }
    engine.start(spec("c", "alias-b", "acc/movie.bin2"))
    release.countDown()
    await("a completed") { engine.state("a") == States.COMPLETED }
    assertEquals("AAAAAAAA", file(platform, "acc/movie.bin").readText())
    assertFalse(file(platform, "acc/movie.bin.part").exists())
  }

  /** Was REPRO_failedTaskRemovalReleasesAStillWritingPath (N2-02): a failed task keeps its path until its worker ended. */
  @Test fun aFailedTaskKeepsItsPathUntilItsWorkerEnded() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    Fixtures.responses["stopping"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    Fixtures.responses["replacement"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val (engine, platform, _) = engine("stopping-remove")
    val sd = Volume("volume-ABCD-1234", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "stopping", "movie.bin", volume = sd.id))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    platform.extraVolumes.clear()
    engine.pump()
    assertEquals(States.FAILED, engine.state("a"))
    val removed = CountDownLatch(1)
    thread { engine.remove("a"); removed.countDown() }
    assertFalse("remove waits for the worker", removed.await(300, TimeUnit.MILLISECONDS))
    platform.extraVolumes += sd
    assertEquals("invalid_state", code { engine.start(spec("b", "replacement", "movie.bin", volume = sd.id)) })
    release.countDown()
    assertTrue(removed.await(5, TimeUnit.SECONDS))
    assertFalse(File(sd.root, "movie.bin.part").exists())
    engine.start(spec("b", "replacement", "movie.bin", volume = sd.id))
    await("b completed") { engine.state("b") == States.COMPLETED }
    Thread.sleep(200)
    assertEquals("BBBBBBBB", File(sd.root, "movie.bin").readText())
  }

  /** N2-02 guard: once stopped, a worker whose blocked read returns data writes nothing more. */
  @Test fun aStoppedWorkerWritesNothingMore() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    val ended = CountDownLatch(1)
    Fixtures.responses["guard"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    val (engine, platform, _) = engine("write-guard")
    engine.beforeOutcome = { _, _ -> ended.countDown() }
    engine.start(spec("a", "guard"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    engine.pause("a")
    release.countDown()
    assertTrue(ended.await(5, TimeUnit.SECONDS))
    assertEquals("AAAA", file(platform, "acc/a.bin.part").readText())
  }

  /** N2-06: cancel force-closes a stalled read and resolves once the worker ended. */
  @Test fun cancelForceClosesAStalledRead() {
    val entered = CountDownLatch(1)
    Fixtures.responses["stall"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), stalled("AAAA", entered))
    val (engine, platform, _) = engine("stall")
    engine.start(spec("a", "stall"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    val started = System.nanoTime()
    engine.cancel("a")
    assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 2_000)
    assertFalse(file(platform, "acc/a.bin.part").exists())
    engine.start(spec("b", "stall", "acc/a.bin"))
  }

  /** Was REPRO_cancelResolvesBeforeCleanupAfterTenSecondTimeout (N2-06): a timeout is never reported as done. */
  @Test fun cancelOfAWorkerThatCannotEndRejectsAndKeepsTheClaim() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    Fixtures.responses["unending"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    val (engine, platform, _) = engine("unending")
    engine.drainTimeoutMs = 300
    engine.start(spec("a", "unending"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    assertEquals("io: cancel_pending", message { engine.cancel("a") })
    assertTrue(file(platform, "acc/a.bin.part").exists())
    assertEquals("invalid_state", code { engine.start(spec("b", "unending", "acc/a.bin")) })
    assertEquals("io: cancel_pending", message { engine.cancel("a") })
    release.countDown()
    await("worker ended") { !file(platform, "acc/a.bin.part").exists() }
    engine.cancel("a")
    assertEquals("not_found", code { engine.cancel("a") })
    engine.start(spec("b", "unending", "acc/a.bin"))
  }

  /** N2-05, N3-10: genuine v1 records (id, url, relativePath, volumeId) name no medium, so they become volume_unavailable. */
  @Test fun legacyExternalVolumeIdsBecomeVolumeUnavailable() {
    val root = Fixtures.work("engine-legacy-volume")
    val sd = Volume("volume-ABCD-1234", File(root, "sd"), removable = true)
    File(sd.root, "movie.bin").apply { parentFile.mkdirs(); writeText("AAAAAAAA") }
    fun v1(id: String, path: String, volume: String, state: String) = JSONObject()
      .put("id", id).put("url", Fixtures.url("never")).put("headers", JSONObject()).put("relativePath", path).put("volumeId", volume)
      .put("expectedBytes", 8).put("state", state).put("bytesWritten", 8).put("totalBytes", 8).put("restarts", 0).put("attempts", 0)
      .put("createdAt", 1).put("updatedAt", 1)
    val tasks = JSONArray()
      .put(v1("done", "movie.bin", "external-0", States.COMPLETED))
      .put(v1("pending", "next.bin", "external-1", States.RUNNING))
      .put(v1("inside", "local.bin", Volumes.INTERNAL, States.COMPLETED))
    File(root, "state").mkdirs()
    File(root, "state/state.json").writeText(JSONObject().put("version", 1).put("settings", Settings().toJson()).put("tasks", tasks).toString())
    val platform = FakePlatform(root).apply { extraVolumes += sd }
    val engine = DownloadEngine(platform).also { platform.engine = it; it.load() }
    for (id in listOf("done", "pending")) {
      assertEquals(id, States.FAILED, engine.state(id))
      assertEquals(id, DownloadEngine.VOLUME_UNAVAILABLE, (engine.get(id)!!["error"] as Map<*, *>)["message"])
      assertEquals("never rebound by list order", engine.get(id)!!["volumeId"].toString().startsWith("external-"), true)
    }
    assertEquals(States.COMPLETED, engine.state("inside"))
    assertEquals("the card's file is not touched", "AAAAAAAA", File(sd.root, "movie.bin").readText())
    repeat(3) { engine.pump() }
    assertEquals(States.FAILED, engine.state("pending"))
    assertEquals(1, platform.logs.count { it.contains("nothing identifies the volume") })
    assertEquals(3, JSONObject(File(root, "state/state.json").readText()).getInt("version"))
    val again = FakePlatform(root).apply { extraVolumes += sd }
    DownloadEngine(again).also { again.engine = it; it.load() }
    assertEquals(0, again.logs.count { it.contains("nothing identifies the volume") })
  }

  /** Was REPRO_wallRollbackExtendsAnHourCooldownByADay (N2-04): waits run on the elapsed clock. */
  @Test fun wallClockJumpsNeitherExtendNorShortenACooldown() {
    Fixtures.responses["clock"] = Fixture(429, mapOf("Retry-After" to "3600"), ByteArray(0))
    val (engine, platform, _) = engine("wall-clock")
    engine.start(spec("a", "clock"))
    await("retrying") { engine.state("a") == States.RETRYING }
    fun left() = (engine.get("a")!!["retryAt"] as Double) - platform.now()
    assertEquals(3_600_000.0, left(), 2_000.0)
    platform.wallShift = -24 * 3_600_000L
    engine.pump()
    assertEquals(States.RETRYING, engine.state("a"))
    assertEquals(3_600_000.0, left(), 2_000.0)
    platform.wallShift = 48 * 3_600_000L
    engine.pump()
    assertEquals(States.RETRYING, engine.state("a"))
    assertEquals(3_600_000.0, left(), 2_000.0)
    Fixtures.responses["clock"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    platform.elapsedShift += 3_600_000
    engine.pump()
    await("completed after the elapsed hour") { engine.state("a") == States.COMPLETED }
  }

  /** N2-04: the executor's clock stops in deep sleep; a pending retry still wakes within maxWakeMs and decides on elapsed(). */
  @Test fun aRetryWakesUpAfterASleepWithoutAPump() {
    Fixtures.responses["wake"] = Fixture(429, mapOf("Retry-After" to "3600"), ByteArray(0))
    val (engine, platform, _) = engine("wake")
    engine.maxWakeMs = 50
    engine.start(spec("a", "wake"))
    await("retrying") { engine.state("a") == States.RETRYING }
    Thread.sleep(200)
    assertEquals(States.RETRYING, engine.state("a"))
    Fixtures.responses["wake"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    // The device slept an hour: only elapsed() moved, nothing calls pump().
    platform.elapsedShift += 3_600_000
    await("completed through the wake-up alone", 3_000) { engine.state("a") == States.COMPLETED }
  }

  /** N2-04: a persisted wait keeps its deadline on the same boot; after a reboot a wall rollback never extends it. */
  @Test fun aWaitSurvivesARestartAndARebootWithoutGrowing() {
    Fixtures.responses["restart"] = Fixture(429, mapOf("Retry-After" to "3600"), ByteArray(0))
    val (engine, platform, _) = engine("wait-restart")
    engine.start(spec("a", "restart"))
    await("retrying") { engine.state("a") == States.RETRYING }
    val root = platform.stateDir.parentFile
    val sameBoot = FakePlatform(root).apply { elapsedShift = 600_000; wallShift = -86_400_000 }
    val restarted = DownloadEngine(sameBoot).also { sameBoot.engine = it; it.load() }
    assertEquals(3_000_000.0, (restarted.get("a")!!["retryAt"] as Double) - sameBoot.now(), 3_000.0)
    val rebooted = FakePlatform(root).apply { boot = "boot-2"; elapsedShift = -TimeUnit.NANOSECONDS.toMillis(System.nanoTime()); wallShift = -2 * 86_400_000L }
    val afterReboot = DownloadEngine(rebooted).also { rebooted.engine = it; it.load() }
    val left = (afterReboot.get("a")!!["retryAt"] as Double) - rebooted.now()
    assertTrue("a wall rollback never extends the wait: $left", left in 2_990_000.0..3_003_000.0)
    assertEquals(States.RETRYING, afterReboot.state("a"))
  }

  @Test fun completedThenOneFinalProgress() {
    Fixtures.responses["order"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    val (engine, _, events) = engine("order")
    engine.start(spec("a", "order"))
    await("completed") { engine.state("a") == States.COMPLETED }
    val tail = events.all.dropWhile { it != "state:a:completed" }
    assertEquals(listOf("state:a:completed", "progress:a:8"), tail)
  }

  /** N1-08: a server cooldown survives network changes; Retry-After answers keep the attempts. */
  @Test fun networkChangesNeverShortenAServerCooldown() {
    Fixtures.responses["cool"] = Fixture(429, mapOf("Retry-After" to "3"), byteArrayOf())
    val (engine, platform, _) = engine("cool")
    engine.start(spec("a", "cool"))
    await("retrying") { engine.state("a") == States.RETRYING }
    val task = engine.get("a")!!
    val retryAt = (task["retryAt"] as Double).toLong()
    assertEquals(0, task["attempts"])
    assertEquals(3000.0, (task["error"] as Map<*, *>)["retryAfterMs"])
    platform.net = Net.NONE
    engine.pump()
    assertEquals(States.WAITING_NETWORK, engine.state("a"))
    Fixtures.responses["cool"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    platform.net = Net.UNMETERED
    engine.pump()
    assertEquals(States.RETRYING, engine.state("a"))
    // retryAt is a display value recomputed on every read (N2-04): equal within a few ms, never earlier.
    assertEquals(retryAt.toDouble(), engine.get("a")!!["retryAt"] as Double, 20.0)
    await("completed after the cooldown") { engine.state("a") == States.COMPLETED }
    assertTrue(System.currentTimeMillis() >= retryAt - 20)
  }

  /** N1-08: an invalid 206 drops the partial, counts as an ordinary attempt and a restart (no Retry-After). */
  @Test fun invalidPartialIsAnOrdinaryAttemptAndARestart() {
    Fixtures.responses["invalid"] = Fixtures.partial("bytes 4-7/*")
    val root = Fixtures.work("engine-invalid")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(TaskRecord("a", Fixtures.url("invalid"), emptyMap(), "acc/a.bin",
      Volumes.INTERNAL, 8, null, null, States.PAUSED, bytesWritten = 4, totalBytes = 8, etag = "\"a\"", checkpoint = 4))))
    File(root, "internal/acc").mkdirs()
    File(root, "internal/acc/a.bin.part").writeText("AAAA")
    val platform = FakePlatform(root)
    val engine = DownloadEngine(platform).also { platform.engine = it }
    engine.load()
    engine.resume("a", null, null)
    await("retrying") { engine.state("a") == States.RETRYING }
    val task = engine.get("a")!!
    assertEquals(1, task["attempts"])
    assertEquals(1, task["restarts"])
    assertNull((task["error"] as Map<*, *>)["retryAfterMs"])
    assertNull(task["etag"])
    assertFalse(File(root, "internal/acc/a.bin.part").exists())
  }

  /** N1-13: Task Manager "Stop" (no onStopJob) pauses unfinished tasks on the next start; other exits re-queue. */
  @Test fun userStopExitPausesUnfinishedTasks() {
    val root = Fixtures.work("engine-userstop")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.RUNNING),
      TaskRecord("b", Fixtures.url("never"), emptyMap(), "acc/b.bin", Volumes.INTERNAL, 8, null, null, States.RETRYING, retryAt = Long.MAX_VALUE),
    ), lastExitHandled = 1))
    val platform = FakePlatform(root).apply { exit = ExitInfo(2, userStop = true, description = "user requested") }
    val engine = DownloadEngine(platform).also { platform.engine = it }
    engine.load()
    assertEquals(States.PAUSED, engine.state("a"))
    assertEquals(States.PAUSED, engine.state("b"))
    assertEquals(0, platform.hostRequests)

    val again = FakePlatform(root).apply { exit = ExitInfo(2, userStop = true, description = "same exit, already handled") }
    val next = DownloadEngine(again).also { again.engine = it }
    next.load()
    assertEquals(States.PAUSED, next.state("a"))
  }

  /** N2-11 (DL-C1, device): a blocked task resumed with a new URL as the app comes to the front gets one job, never two. */
  @Test fun aResumeAtForegroundNeverReplacesTheJobItJustScheduled() {
    Fixtures.responses["fg"] = Fixture(403, mapOf("Content-Type" to "application/json"), "{}".toByteArray())
    val (engine, platform, _) = engine("fg-resume") { it.autoHost = false; it.visibleApp = true }
    engine.start(spec("a", "fg"))
    platform.startJob()
    await("failed 403") { engine.state("a") == States.FAILED }
    val release = CountDownLatch(1)
    Fixtures.responses["fg-renewed"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    val before = platform.requests.size
    engine.resume("a", Fixtures.url("fg-renewed"), null)
    engine.onForeground()
    engine.pump()
    assertEquals("one request, no replace", listOf(false), platform.requests.drop(before).map { it.second })
    platform.startJob()
    await("running", 5_000) { engine.state("a") == States.RUNNING }
    release.countDown()
    await("completed") { engine.state("a") == States.COMPLETED }
  }

  /** N2-11: the replaced execution's stop (and a late start) arrive after the replacement attached; neither touches it. */
  @Test fun aReplacedHostsLateStopNeverClearsTheNewHost() {
    val entered = CountDownLatch(1)
    Fixtures.responses["late"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), stalled("AAAA", entered))
    val (engine, platform, _) = engine("late-stop") { it.autoHost = false; it.visibleApp = true }
    val slots = HostSlots<FakePlatform.Host>()
    fun start() = platform.Host(platform.jobToken!!).also { slots.started(it); platform.job = HostJob.RUNNING; engine.attachHost(it) }
    engine.start(spec("a", "late"))
    val first = start()
    await("running on the first host") { engine.state("a") == States.RUNNING }
    // Wi-Fi only changes the job's constraint: the engine releases the first host and replaces the job.
    engine.setWifiOnly(false)
    val second = start()
    assertTrue(second.token > first.token)
    await("running on the second host") { engine.state("a") == States.RUNNING }
    val requests = platform.requests.size
    val stale = slots.stopped(first.token)
    assertSame(first, stale)
    assertFalse(engine.detachHost(stale!!, HostStop.CANCELLED_BY_APP, systemReschedules = true))
    val lateStart = platform.Host(first.token)
    engine.attachHost(lateStart)
    assertTrue(lateStart.finished)
    assertFalse(second.finished)
    Thread.sleep(400)
    assertEquals(States.RUNNING, engine.state("a"))
    assertEquals(requests, platform.requests.size)
    assertTrue(platform.logs.any { it.startsWith("stale host ${first.token} stopped") })
    engine.cancel("a")
  }

  /** N2-11: runnable work, a request outstanding and no host for 15 s: a visible app cancels the job and asks again, once. */
  @Test fun aHostRequestNobodyAnswersIsReplacedAfter15Seconds() {
    Fixtures.responses["heal"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    val (engine, platform, _) = engine("heal") { it.autoHost = false; it.visibleApp = true }
    engine.start(spec("a", "heal"))
    val first = platform.jobToken!!
    engine.list()
    engine.onForeground()
    assertEquals(1, platform.requests.size)
    val cancels = platform.cancels
    platform.elapsedShift += 16_000
    platform.visibleApp = false
    engine.list()
    assertEquals("a background app cannot schedule a user-initiated job", 1, platform.requests.size)
    platform.visibleApp = true
    engine.list()
    assertEquals(cancels + 1, platform.cancels)
    assertEquals(2, platform.requests.size)
    assertTrue(platform.jobToken!! > first)
    engine.list()
    engine.onForeground()
    assertEquals("a fresh request waits its own 15 s", 2, platform.requests.size)
    assertEquals(1, platform.warns.size)
    platform.startJob()
    await("completed") { engine.state("a") == States.COMPLETED }
  }

  /** N2-11: the visible fast start replaces a stopped job only while JobScheduler holds it in backoff, never one about to start. */
  @Test fun aStoppedJobIsReplacedOnlyWhileHeldInBackoff() {
    val entered = CountDownLatch(1)
    Fixtures.responses["backoff"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), stalled("AAAA", entered))
    val (engine, platform, _) = engine("backoff") { it.autoHost = false; it.visibleApp = true }
    engine.start(spec("a", "backoff"))
    val first = platform.startJob()
    await("running") { engine.state("a") == States.RUNNING }
    assertTrue(engine.detachHost(first, HostStop.SYSTEM, systemReschedules = true))
    platform.job = HostJob.PENDING
    engine.pump()
    assertEquals("a job about to start is never replaced", 1, platform.requests.size)
    platform.job = HostJob.BACKOFF
    engine.pump()
    assertEquals(listOf(false, true), platform.requests.map { it.second })
    platform.startJob()
    await("running again") { engine.state("a") == States.RUNNING }
    engine.cancel("a")
  }

  /** N2-11 (DL-C1: job "active", Ready false, no host): a job still listed after its host stopped for good is replaced. */
  @Test fun aJobStillListedAfterItsHostStoppedForGoodIsReplaced() {
    val entered = CountDownLatch(1)
    Fixtures.responses["dead"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), stalled("AAAA", entered))
    val (engine, platform, _) = engine("dead-job") { it.autoHost = false; it.visibleApp = true }
    engine.start(spec("a", "dead"))
    val first = platform.startJob()
    await("running") { engine.state("a") == States.RUNNING }
    assertFalse(engine.detachHost(first, HostStop.CANCELLED_BY_APP, systemReschedules = true))
    engine.pump()
    assertEquals(listOf(false, false, true), platform.requests.map { it.second })
    platform.startJob()
    await("running on the replacement") { engine.state("a") == States.RUNNING }
    engine.cancel("a")
  }

  @Test fun hostStoppedByTheUserPausesAndIsNotRescheduled() {
    val release = CountDownLatch(1)
    Fixtures.responses["hoststop"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AA", "AAAAAA", release))
    val (engine, platform, _) = engine("hoststop")
    engine.start(spec("a", "hoststop"))
    await("running") { engine.state("a") == States.RUNNING }
    val host = platform.Host(1_000)
    engine.attachHost(host)
    assertFalse(engine.detachHost(host, HostStop.USER, systemReschedules = true))
    assertEquals(States.PAUSED, engine.state("a"))
    release.countDown()
  }

  /** N1-14: a missing volume fails its tasks with volume_unavailable; they continue when it returns. */
  @Test fun missingVolumeWaitsForItsReturn() {
    val release = CountDownLatch(1)
    Fixtures.responses["sd"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release))
    val (engine, platform, _) = engine("sd")
    val sd = Volume("volume-1A2B-3C4D", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "sd", volume = sd.id))
    await("running") { engine.state("a") == States.RUNNING }
    platform.extraVolumes.clear()
    engine.pump()
    assertEquals(States.FAILED, engine.state("a"))
    assertEquals(DownloadEngine.VOLUME_UNAVAILABLE, (engine.get("a")!!["error"] as Map<*, *>)["message"])
    assertTrue(runCatching { engine.start(spec("b", "sd", volume = sd.id)) }.exceptionOrNull()?.message!!.startsWith("not_found"))
    Fixtures.responses["sd"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    release.countDown()
    platform.extraVolumes += sd
    engine.pump()
    await("completed on the returned volume") { engine.state("a") == States.COMPLETED }
    assertEquals("AAAAAAAA", File(sd.root, "acc/a.bin").readText())
  }

  /** N1-16: two downloads cannot both count on the same free bytes. */
  @Test fun freeSpaceIsReservedAcrossRunningTasks() {
    val big = 512L * 1024 * 1024
    System.setProperty("harness.freeBytes", (big + HttpPolicy.RESERVE_BYTES + big / 2).toString())
    try {
      val release = CountDownLatch(1)
      Fixtures.responses["space"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(0), gated("A", "", release), length = big)
      val (engine, _, _) = engine("space")
      engine.start(spec("a", "space", size = big))
      await("a running") { engine.get("a")?.get("totalBytes") != null && engine.state("a") == States.RUNNING }
      Thread.sleep(200)
      engine.start(spec("b", "space", size = big))
      await("b failed") { engine.state("b") == States.FAILED }
      assertEquals("disk_full", (engine.get("b")!!["error"] as Map<*, *>)["kind"])
      engine.pause("a")
      release.countDown()
    } finally {
      System.clearProperty("harness.freeBytes")
    }
  }

  /** N1-15: after a crash only the checkpointed (fsynced) prefix of a part is kept. */
  @Test fun recoveryKeepsOnlyTheCheckpointedPrefix() {
    val root = Fixtures.work("engine-checkpoint")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, etag = "\"a\"", checkpoint = 4),
    )))
    File(root, "internal/acc").mkdirs()
    File(root, "internal/acc/a.bin.part").writeText("AAAA????")
    val platform = FakePlatform(root)
    val engine = DownloadEngine(platform).also { platform.engine = it }
    engine.load()
    assertEquals("AAAA", File(root, "internal/acc/a.bin.part").readText())
    assertEquals(4.0, engine.get("a")!!["bytesWritten"])
  }

  /** Was REPRO_N3_moveOntoAPausedPartPublishesForeignBytes (N3-02): a task owns its paths whatever its state. */
  @Test fun pausedRetryingFailedAndQueuedTasksKeepTheirPaths() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    val ended = CountDownLatch(1)
    Fixtures.responses["held-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    Fixtures.responses["held-b"] = Fixture(200, mapOf("ETag" to "\"b\""), ByteArray(8), cut("BBBB"))
    val (engine, platform, _) = engine("held")
    engine.beforeOutcome = { transfer, _ -> if (transfer.id == "a") ended.countDown() }
    engine.start(spec("a", "held-a", "acc/a/movie.bin"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    engine.pause("a")
    release.countDown()
    assertTrue(ended.await(5, TimeUnit.SECONDS))
    engine.start(spec("b", "held-b", "acc/b/movie.bin"))
    await("b retrying") { engine.state("b") == States.RETRYING }
    file(platform, "foreign.bin").writeText("XXXX")
    fun refused(dir: String) {
      for (attempt in listOf<() -> Unit>(
        { engine.move("foreign.bin", "$dir/movie.bin.part", null) },
        { engine.move("foreign.bin", "$dir/MOVIE.bin", null) },
        { engine.move("$dir/movie.bin.part", "published.bin", null) },
        { engine.deletePath("$dir/movie.bin.part", null) },
        { engine.deletePath(dir, null) },
      )) assertEquals(dir, "invalid_state", code(attempt))
    }
    refused("acc/a")
    refused("acc/b")
    Fixtures.responses["held-b"] = Fixture(403, emptyMap(), "{}".toByteArray())
    engine.resume("b", null, null)
    await("b failed") { engine.state("b") == States.FAILED }
    refused("acc/b")
    val running = CountDownLatch(1)
    val hold = CountDownLatch(1)
    Fixtures.responses["held-r"] = Fixture(200, mapOf("ETag" to "\"r\""), ByteArray(8), gated("RRRR", "RRRR", hold, running))
    engine.setMaxConcurrent(1)
    engine.start(spec("r", "held-r", "acc/r/movie.bin"))
    assertTrue(running.await(5, TimeUnit.SECONDS))
    engine.start(spec("c", "never", "acc/c/movie.bin"))
    assertEquals(States.QUEUED, engine.state("c"))
    refused("acc/c")
    platform.net = Net.NONE
    engine.pump()
    assertEquals(States.WAITING_NETWORK, engine.state("c"))
    refused("acc/c")
    assertEquals("AAAA", file(platform, "acc/a/movie.bin.part").readText())
    assertEquals("BBBB", file(platform, "acc/b/movie.bin.part").readText())
    platform.net = Net.UNMETERED
    engine.cancel("c")
    thread { Thread.sleep(100); hold.countDown() }
    engine.cancel("r")
    Fixtures.responses["held-a"] = Fixtures.partial("bytes 4-7/8", body = "AAAA")
    engine.resume("a", null, null)
    await("a completed") { engine.state("a") == States.COMPLETED }
    assertEquals("only the server's bytes", "AAAAAAAA", file(platform, "acc/a/movie.bin").readText())
    engine.deletePath("acc/a/movie.bin", null)
  }

  /** Was REPRO_N3_trailingDotAliasesAreSeparateClaims (N3-03): FAT and exFAT ignore trailing dots and spaces, so no segment has one. */
  @Test fun pathSegmentsEndingInADotOrSpaceAreRejectedOnEveryVolume() {
    val (engine, platform, _) = engine("trailing-dot") { it.autoHost = false }
    val sd = Volume("volume-1234-ABCD", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "never", "show/movie.bin", volume = sd.id))
    for (volume in listOf(sd.id, Volumes.INTERNAL)) {
      for (path in listOf("show/movie.bin.", "show/movie.bin.part.", "show./movie.bin", "show /movie.bin", "show/movie.bin ", "show/movie.bin. .")) {
        assertEquals("$volume $path", "invalid_argument", code { engine.start(spec("b", "never", path, volume = volume)) })
      }
    }
    File(sd.root, "x.bin").apply { parentFile.mkdirs() }.writeText("X")
    assertEquals("invalid_state", code { engine.move("x.bin", "show/movie.bin.", sd.id) })
    assertEquals("invalid_state", code { engine.move("x.bin", "show./movie.bin.part", sd.id) })
    assertEquals("invalid_state", code { engine.deletePath("SHOW. ", sd.id) })
    assertEquals(listOf("a"), engine.list().map { it["id"] })
  }

  /** Was REPRO_N3_errorBodyEchoingTheCapabilityReachesTheLog (N3-07): the request path never reaches the log. */
  @Test fun anErrorBodyEchoingTheRequestIsRedactedInTheLog() {
    val path = "/api/v1/download/DUMMY-CAPABILITY-0123456789"
    val body = "<p>The requested URL $path was not found on this server.</p>"
    Fixtures.responses["echo"] = Fixture(404, emptyMap(), body.toByteArray())
    val (engine, platform, _) = engine("error-echo")
    engine.start(spec("a", "echo") + ("url" to Fixtures.url("echo", "$path?sig=0f0f0f")))
    await("failed") { engine.state("a") == States.FAILED }
    val line = platform.logs.single { it.startsWith("a: HTTP 404") }
    // The 27-char capability is a long token, redacted before the URL pieces (N4-01): the plain path prefix stays.
    assertEquals("a: HTTP 404 type=none length=99 body: <p>The requested URL /api/v1/download/[redacted] was not found on this server.</p>", line)
    assertTrue(platform.logs.none { it.contains("DUMMY-CAPABILITY") || it.contains("0f0f0f") })
  }

  /** Was REPRO_N3_processDeathDuringCancelPendingOrphansThePartial (N3-05): the disposal is persisted until the part is gone. */
  @Test fun aProcessDeathDuringCancelPendingStillDeletesThePartial() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    Fixtures.responses["orphan"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    Fixtures.responses["orphan-next"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val (engine, platform, _) = engine("orphan")
    engine.start(spec("a", "orphan", "acc/movie.bin"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    engine.drainTimeoutMs = 50
    assertEquals("io: cancel_pending", message { engine.cancel("a") })
    val saved = JSONObject(File(platform.stateDir, "state.json").readText()).getJSONArray("disposals")
    assertEquals("a", saved.getJSONObject(0).getString("owner"))
    try {
      // The process dies here: the worker of the first engine never ends.
      val root = platform.stateDir.parentFile
      val next = relaunch(root)
      assertEquals(emptyList<Any>(), next.list())
      assertFalse(file(platform, "acc/movie.bin.part").exists())
      next.cancel("a")
      assertEquals("not_found", code { next.cancel("a") })
      assertEquals(0, JSONObject(File(platform.stateDir, "state.json").readText()).getJSONArray("disposals").length())
      next.start(spec("b", "orphan-next", "acc/movie.bin"))
      await("b completed") { next.state("b") == States.COMPLETED }
      assertEquals("BBBBBBBB", file(platform, "acc/movie.bin").readText())
    } finally {
      release.countDown()
    }
  }

  /** N3-05 guard: a persisted disposal never deletes the part of a newer task on its path. */
  @Test fun aDisposalNeverDeletesTheBytesOfANewerTask() {
    val root = Fixtures.work("engine-disposal-newer")
    val internal = File(root, "internal")
    File(internal, "acc").mkdirs()
    File(internal, "acc/movie.bin.part").writeText("CCCC")
    File(internal, "acc/old.bin.part").writeText("OO")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("c", Fixtures.url("never"), emptyMap(), "ACC/Movie.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, etag = "\"c\"", bytesWritten = 4, checkpoint = 4),
    ), disposals = listOf(Disposal(Volumes.INTERNAL, "acc/movie.bin", "a"), Disposal(Volumes.INTERNAL, "acc/old.bin", "z"))))
    val engine = relaunch(root)
    assertEquals("CCCC", File(internal, "acc/movie.bin.part").readText())
    assertFalse(File(internal, "acc/old.bin.part").exists())
    assertEquals(4.0, engine.get("c")!!["bytesWritten"])
    engine.cancel("z")
    assertEquals(0, JSONObject(File(root, "state/state.json").readText()).getJSONArray("disposals").length())
  }

  /** Was REPRO_N3_removeWhileTheVolumeIsMissingOrphansThePartial (N3-05): the part goes when the card returns, also after a relaunch. */
  @Test fun removeOrCancelWhileTheVolumeIsMissingDeletesThePartialOnItsReturn() {
    Fixtures.responses["missing-a"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    Fixtures.responses["missing-b"] = Fixture(200, mapOf("ETag" to "\"b\""), ByteArray(8), cut("BBBB"))
    val (engine, platform, _) = engine("missing-dispose")
    val sd = Volume("volume-5678-EF01", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "missing-a", "movie.bin", volume = sd.id))
    engine.start(spec("b", "missing-b", "other.bin", volume = sd.id))
    await("both retrying") { engine.state("a") == States.RETRYING && engine.state("b") == States.RETRYING }
    platform.extraVolumes.clear()
    engine.pump()
    assertEquals(listOf(States.FAILED, States.FAILED), listOf(engine.state("a"), engine.state("b")))
    engine.remove("a")
    engine.cancel("b")
    assertEquals(emptyList<Any>(), engine.list())
    val root = platform.stateDir.parentFile
    val again = FakePlatform(root)
    val next = DownloadEngine(again).also { again.engine = it; it.load() }
    next.cancel("b")
    next.remove("a")
    assertEquals("AAAA", File(sd.root, "movie.bin.part").readText())
    again.extraVolumes += sd
    next.pump()
    assertFalse(File(sd.root, "movie.bin.part").exists())
    assertFalse(File(sd.root, "other.bin.part").exists())
    assertEquals(1, again.logs.count { it == "a: queued partial on ${sd.id} deleted" })
    next.cancel("b")
    assertEquals("not_found", code { next.cancel("b") })
  }

  /** Was REPRO_N3_checkpointCoversBytesThatWereNeverSynced (N3-04): an earlier attempt's bytes count as durable only after a sync. */
  @Test fun aNewAttemptSyncsTheOldPartBeforeItsCheckpointCoversIt() {
    Fixtures.responses["unsynced"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    val (engine, platform, _) = engine("unsynced")
    fun saved() = JSONObject(File(platform.stateDir, "state.json").readText()).getJSONArray("tasks").getJSONObject(0).optLong("checkpoint", -1)
    engine.start(spec("a", "unsynced"))
    await("retrying after the reset") { engine.state("a") == States.RETRYING }
    assertEquals("the broken-off attempt synced nothing", 0L, saved())
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    val blocked = object : InputStream() {
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int { entered.countDown(); release.await(20, TimeUnit.SECONDS); return -1 }
    }
    Fixtures.responses["unsynced"] = Fixtures.partial("bytes 4-7/8", body = "AAAA").copy(input = { blocked })
    val ended = CountDownLatch(1)
    engine.beforeOutcome = { _, _ -> ended.countDown() }
    Transfer.sync = { throw java.io.SyncFailedException("sync failed") }
    try {
      engine.resume("a", null, null)
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      engine.pause("a")
      release.countDown()
      assertTrue(ended.await(5, TimeUnit.SECONDS))
      await("paused") { engine.state("a") == States.PAUSED }
      assertEquals("no sync succeeded: nothing is durable", 0L, saved())
    } finally {
      Transfer.sync = { it.sync() }
    }
    assertEquals(0.0, relaunch(platform.stateDir.parentFile).get("a")!!["bytesWritten"])
  }

  /** Was REPRO_N3_cancelOfADrainingTombstoneResolvesWhileThePathIsStillClaimed (N3-06): cancel waits for the drain like remove. */
  @Test fun cancellingADrainingTombstoneWaitsForItsWorker() {
    val release = CountDownLatch(1)
    val entered = CountDownLatch(1)
    Fixtures.responses["tomb-drain"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AAAA", "AAAA", release, entered))
    Fixtures.responses["tomb-next"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val (engine, platform, _) = engine("tombstone-cancel")
    engine.start(spec("t", "tomb-drain", "acc/movie.bin"))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    engine.drainTimeoutMs = 50
    assertFalse(engine.cancelAll())
    assertEquals("io: cancel_pending", message { engine.cancel("t") })
    assertNull(engine.get("t"))
    assertEquals("invalid_state", code { engine.start(spec("n", "tomb-next", "acc/movie.bin")) })
    assertEquals("io: cancel_pending", message { engine.cancel("t") })
    engine.drainTimeoutMs = 5_000
    thread { Thread.sleep(200); release.countDown() }
    engine.cancel("t")
    assertFalse(file(platform, "acc/movie.bin.part").exists())
    engine.start(spec("n", "tomb-next", "acc/movie.bin"))
    await("n completed") { engine.state("n") == States.COMPLETED }
    assertEquals("BBBBBBBB", file(platform, "acc/movie.bin").readText())
  }

  /** N3-11: a stop between opening a connection and handing it over still closes it. */
  @Test fun aStopDuringConnectClosesTheNewConnection() {
    val connecting = CountDownLatch(1)
    val closed = CountDownLatch(1)
    val original = Transfer.connect
    val (engine, _, _) = engine("handoff")
    engine.drainTimeoutMs = 2_000
    Transfer.connect = { url ->
      if (url.host != "handoff.fixture") original(url) else {
        connecting.countDown()
        await("cancel registered") { engine.get("a") == null }
        object : java.net.HttpURLConnection(url) {
          override fun getResponseCode(): Int { closed.await(10, TimeUnit.SECONDS); throw IOException("socket closed") }
          override fun connect() {}
          override fun disconnect() = closed.countDown()
          override fun usingProxy() = false
        }
      }
    }
    try {
      engine.start(spec("a", "handoff"))
      assertTrue(connecting.await(5, TimeUnit.SECONDS))
      val started = System.nanoTime()
      engine.cancel("a")
      assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 1_500)
      assertEquals(0, closed.count)
    } finally {
      Transfer.connect = original
    }
  }

  /** N3-11: a write hung in the kernel blocks neither engine calls nor the stop. */
  @Test fun aHungWriteNeverBlocksTheEngine() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    Fixtures.responses["hung"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    val (engine, platform, _) = engine("hung-write")
    Transfer.beforeWrite = { transfer -> if (transfer.part.path.contains("engine-hung-write")) { entered.countDown(); release.await(10, TimeUnit.SECONDS) } }
    try {
      engine.start(spec("a", "hung"))
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      val calls = thread {
        engine.pause("a")
        engine.list()
        engine.get("a")
        engine.pump()
      }
      calls.join(1_000)
      assertFalse("engine calls wait for the write", calls.isAlive)
      assertEquals(States.PAUSED, engine.state("a"))
    } finally {
      release.countDown()
      Transfer.beforeWrite = {}
    }
    await("worker ended") { file(platform, "acc/a.bin.part").length() == 8L }
  }

  @Test fun headersOutsideTheAllowlistAreRejected() {
    val (engine, _, _) = engine("headers")
    val error = runCatching { engine.start(spec("a", "never") + ("headers" to mapOf("Authorization" to "Bearer x"))) }.exceptionOrNull()
    assertEquals("invalid_argument: headers not allowed: Authorization", error?.message)
  }

  @Test fun publisherValidatesSizeAndValidator() {
    val root = Fixtures.work("publisher")
    val part = File(root, "a.part").apply { writeText("AAAAAAAA") }
    val target = File(root, "a")
    assertEquals("size_mismatch", (Publisher.publish(part, target, 8, 9, "\"a\"", null, "\"a\"") as Outcome.Failed).error.kind)
    assertEquals("validator_changed", (Publisher.publish(part, target, 8, 8, "\"b\"", "\"a\"", "\"b\"") as Outcome.Failed).error.kind)
    assertEquals("validator_changed", (Publisher.publish(part, target, 8, 8, null, "\"a\"", null) as Outcome.Failed).error.kind)
    assertTrue(Publisher.publish(part, target, 8, 8, "\"a\"", "\"a\"", "\"a\"") is Outcome.Ready)
    assertEquals("AAAAAAAA", target.readText())
  }
}
