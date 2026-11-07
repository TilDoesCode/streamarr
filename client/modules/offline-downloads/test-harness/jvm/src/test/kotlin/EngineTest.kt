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
    /** What the notification slots saw: batch summaries, clears of the progress slot, storage notes (N4-02). */
    val summaries = CopyOnWriteArrayList<Pair<Int, Int>>()
    @Volatile var clears = 0
    val storageNotes = CopyOnWriteArrayList<Int>()
    val observing get() = onChange != null
    override fun summary(finished: Int, failed: Int) { summaries += finished to failed }
    override fun clearNotification() { clears += 1 }
    override fun waitingForStorage(count: Int) { storageNotes += count }
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
    assertFalse("tombstones own nothing: their emptied directory goes (N7-02)", file(platform, "acc/w").exists())
    val tombstones = engine.list()
    assertEquals(listOf("a", "b"), tombstones.map { it["id"] })
    tombstones.forEach { task ->
      assertEquals(States.CANCELLED, task["state"])
      assertEquals(0.0, task["bytesWritten"])
      assertNull(task["error"])
    }
    assertEquals("acc/w/movie.bin", tombstones[0]["relativePath"])
    assertEquals(Fixtures.url("tomb-a"), tombstones[0]["url"])

    // Process death while a's worker still drained: its partial (and directory) is left behind.
    file(platform, "acc/w/movie.bin.part").apply { parentFile.mkdirs() }.writeText("AAAA")
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
    // Since D-01 every way out syncs; a failing sync (dying card) still leaves an earlier attempt's bytes unsynced.
    Transfer.sync = { throw java.io.SyncFailedException("sync failed") }
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
    // After a reboot (power loss) only the synced checkpoint counts; the same boot would adopt the bytes (D-01).
    assertEquals(0.0, relaunch(platform.stateDir.parentFile) { it.boot = "boot-2" }.get("a")!!["bytesWritten"])
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

  private fun disposalCount(platform: FakePlatform) =
    JSONObject(File(platform.stateDir, "state.json").readText()).getJSONArray("disposals").length()

  /** Was REPRO_N4_pendingDisposalOnAMissingCardSuppressesTheSummaryForever: a queued partial is no work to show (N4-02). */
  @Test fun aQueuedPartialOnAMissingCardNeverHoldsBackTheSummary() {
    Fixtures.responses["gone-cut"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    Fixtures.responses["gone-ok"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val (engine, platform, _) = engine("gone-card")
    val sd = Volume("volume-AAAA-0001", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("sd", "gone-cut", "sd.bin", volume = sd.id))
    await("retrying") { engine.state("sd") == States.RETRYING }
    platform.extraVolumes.clear()
    engine.pump()
    assertEquals("the download waits for its card", listOf(1), platform.storageNotes.toList())
    val clearsBefore = platform.clears
    engine.remove("sd")
    assertEquals(1, disposalCount(platform))
    assertTrue("its note goes with it", platform.clears > clearsBefore)
    platform.summaries.clear()
    engine.start(spec("int", "gone-ok", "int.bin"))
    await("completed") { engine.state("int") == States.COMPLETED }
    await("summary") { platform.summaries.isNotEmpty() }
    assertEquals(listOf(1 to 0), platform.summaries.toList())
    assertTrue("only the storage is still watched", platform.observing)
    assertEquals("the queued partial shows nothing", listOf(1), platform.storageNotes.toList())
    // After a relaunch the first idle pump clears a progress notification the old process left behind.
    val again = FakePlatform(platform.stateDir.parentFile)
    val next = DownloadEngine(again).also { again.engine = it; it.load() }
    next.pump()
    assertTrue(again.clears >= 1)
    Fixtures.responses["gone-ok2"] = Fixture(200, mapOf("ETag" to "\"c\""), "CCCCCCCC".toByteArray())
    next.start(spec("int2", "gone-ok2", "int2.bin"))
    await("completed after relaunch") { next.state("int2") == States.COMPLETED }
    await("summary after relaunch") { again.summaries.isNotEmpty() }
    assertEquals(listOf(1 to 0), again.summaries.toList())
    assertEquals(1, disposalCount(again))
  }

  /** N4-02: downloads whose card is missing get one plain note (no actions); it goes when they continue or are removed. */
  @Test fun downloadsWaitingForAMissingCardShowOnePlainNote() {
    Fixtures.responses["wait-cut"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    val (engine, platform, _) = engine("wait-card")
    val sd = Volume("volume-AAAA-0002", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "wait-cut", "a.bin", volume = sd.id))
    engine.start(spec("b", "wait-cut", "b.bin", volume = sd.id))
    await("retrying") { engine.state("a") == States.RETRYING && engine.state("b") == States.RETRYING }
    platform.summaries.clear()
    platform.extraVolumes.clear()
    repeat(3) { engine.pump() }
    assertEquals("not a failure of the batch", listOf(0 to 0), platform.summaries.toList())
    assertEquals("one note, not one per pump", listOf(2), platform.storageNotes.toList())
    assertTrue(platform.observing)
    engine.remove("a")
    assertEquals(listOf(2, 1), platform.storageNotes.toList())
    engine.remove("b")
    engine.pump()
    assertTrue(platform.clears > 0)
    assertEquals(listOf(2, 1), platform.storageNotes.toList())
  }

  /** N4-02: a queued partial whose card never returns is dropped after 7 days with one log line; nothing is watched then. */
  @Test fun aDisposalWhoseCardNeverReturnsExpiresAfterSevenDays() {
    Fixtures.responses["ttl-cut"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), cut("AAAA"))
    val (engine, platform, _) = engine("ttl-card")
    val sd = Volume("volume-AAAA-0003", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "ttl-cut", "a.bin", volume = sd.id))
    await("retrying") { engine.state("a") == States.RETRYING }
    platform.extraVolumes.clear()
    engine.pump()
    engine.cancel("a")
    platform.wallShift = 7L * 24 * 60 * 60 * 1000 - 60_000
    engine.pump()
    assertEquals(1, disposalCount(platform))
    assertTrue(platform.observing)
    platform.wallShift = 7L * 24 * 60 * 60 * 1000 + 1
    engine.pump()
    assertEquals(0, disposalCount(platform))
    assertFalse(platform.observing)
    assertEquals(1, platform.logs.count { it == "a: queued partial on ${sd.id} dropped, the volume has been missing for 7 days" })
    engine.cancel("a")
    assertEquals("not_found", code { engine.cancel("a") })
  }

  /** Was REPRO_N4_legacyAllDotSegmentTaskOwnsNothing: a pre-N3-03 path with an all-dot/space segment fails at load and owns its folder. */
  @Test fun aLegacyDotSegmentTaskFailsAtLoadAndOwnsItsFolder() {
    val root = Fixtures.work("legacy-dots")
    val internal = File(root, "internal")
    File(internal, "acc/ /x.bin.part").apply { parentFile.mkdirs(); writeText("PPPP") }
    File(internal, "acc/.../y.bin").apply { parentFile.mkdirs(); writeText("DONE") }
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("paused", Fixtures.url("never"), emptyMap(), "acc/ /x.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, bytesWritten = 4, etag = "\"a\"", checkpoint = 4),
      TaskRecord("done", Fixtures.url("never"), emptyMap(), "acc/.../y.bin", Volumes.INTERNAL, 8, null, null, States.COMPLETED, bytesWritten = 8, totalBytes = 8),
    )))
    var platform: FakePlatform? = null
    val engine = relaunch(root) { platform = it }
    for (id in listOf("paused", "done")) {
      assertEquals(id, States.FAILED, engine.state(id))
      assertEquals(id, mapOf("kind" to "file_system", "message" to DownloadEngine.INVALID_LEGACY_PATH), (engine.get(id)!!["error"] as Map<*, *>).filterKeys { it != "retryAfterMs" && it != "httpStatus" })
    }
    assertEquals(2, platform!!.logs.count { it.contains(DownloadEngine.INVALID_LEGACY_PATH) })
    assertEquals("invalid_state", code { engine.deletePath("acc", null) })
    assertEquals("invalid_state", code { engine.move("acc", "elsewhere", null) })
    assertEquals("PPPP", File(internal, "acc/ /x.bin.part").readText())
    assertEquals("invalid_argument", code { engine.resume("paused", null, null) })
    engine.remove("paused")
    assertFalse(File(internal, "acc/ /x.bin.part").exists())
    assertEquals("invalid_state", code { engine.deletePath("acc", null) })
    engine.remove("done")
    engine.deletePath("acc", null)
    assertFalse(File(internal, "acc").exists())
  }

  /** Serves `bytes` of 'A', then blocks until the connection is closed (a stop) and fails like a dropped socket. */
  private fun stallAfter(bytes: Int, entered: CountDownLatch, onRead: () -> Unit = {}): () -> InputStream = {
    object : InputStream() {
      val closed = CountDownLatch(1)
      var sent = 0
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (sent < bytes) {
          onRead()
          val n = minOf(len, 64 * 1024, bytes - sent)
          b.fill('A'.code.toByte(), off, off + n)
          sent += n
          return n
        }
        entered.countDown()
        closed.await(20, TimeUnit.SECONDS)
        throw IOException("socket closed")
      }
      override fun close() = closed.countDown()
    }
  }

  /** The files at this moment, as a process death leaves them (the kernel keeps written pages on the same boot). */
  private fun crashImage(root: File, name: String): File = Fixtures.work(name).also { root.copyRecursively(it, overwrite = true) }

  private fun savedTask(root: File, id: String) =
    JSONObject(File(root, "state/state.json").readText()).getJSONArray("tasks").let { tasks -> (0 until tasks.length()).map { tasks.getJSONObject(it) }.single { it.getString("id") == id } }

  /** D-01 (DL-C1 device finding): a pause syncs the part before its checkpoint is persisted; a reboot keeps it too. */
  @Test fun aPauseSyncsThePartAndPersistsItsCheckpoint() {
    val total = 1_000_000
    val entered = CountDownLatch(1)
    Fixtures.responses["pause-sync"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(total), stallAfter(685_360, entered))
    val (engine, platform, events) = engine("pause-sync")
    val root = platform.stateDir.parentFile
    val atSync = CountDownLatch(1)
    val synced = CountDownLatch(1)
    Transfer.nowMs = { 0L }
    // The first sync of this test is the worker's way out after the pause: hold it to read what was persisted before.
    Transfer.sync = { fd -> if (atSync.count > 0) { atSync.countDown(); synced.await(10, TimeUnit.SECONDS) }; fd.sync() }
    try {
      engine.start(spec("a", "pause-sync", size = total.toLong()))
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      await("the record knows the unsynced bytes") { "progress:a:685360" in events.all }
      engine.pause("a")
      assertTrue("the worker syncs on its way out", atSync.await(5, TimeUnit.SECONDS))
      val atPause = savedTask(root, "a")
      assertEquals(States.PAUSED, atPause.getString("state"))
      assertTrue("never newer than its bytes: $atPause", atPause.getLong("bytesWritten") <= atPause.optLong("checkpoint", 0))
      synced.countDown()
      await("checkpoint persisted") { savedTask(root, "a").optLong("checkpoint") == 685_360L }
      assertEquals(685_360L, savedTask(root, "a").getLong("bytesWritten"))
    } finally {
      synced.countDown()
      Transfer.sync = { it.sync() }
      Transfer.nowMs = { System.nanoTime() / 1_000_000 }
    }
    // Even a reboot (only synced bytes count) keeps the paused bytes; Resume continues there.
    val image = crashImage(root, "pause-sync-image")
    Fixtures.responses["pause-sync"] = Fixtures.partial("bytes 685360-${total - 1}/$total", body = "B".repeat(total - 685_360))
    Fixtures.requests.remove("pause-sync")
    val again = relaunch(image) { it.boot = "boot-2" }
    assertEquals(685_360.0, again.get("a")!!["bytesWritten"])
    again.resume("a", null, null)
    await("completed") { again.state("a") == States.COMPLETED }
    assertEquals("bytes=685360-", Fixtures.requests["pause-sync"]!!.single()["Range"])
    assertEquals(total.toLong(), File(image, "internal/acc/a.bin").length())
  }

  /** D-01: a process death mid-transfer (no sync yet) keeps every written byte on the same boot; a reboot trims to the checkpoint. */
  @Test fun aProcessDeathKeepsTheWrittenBytesOnTheSameBootOnly() {
    val total = 1_048_580
    val entered = CountDownLatch(1)
    Fixtures.responses["death"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(total), stallAfter(1_048_576, entered))
    val (engine, platform, _) = engine("death")
    val root = platform.stateDir.parentFile
    Transfer.nowMs = { 0L }
    val image = try {
      engine.start(spec("a", "death", size = total.toLong()))
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      crashImage(root, "death-image")
    } finally {
      Transfer.nowMs = { System.nanoTime() / 1_000_000 }
    }
    engine.cancel("a")
    assertEquals("nothing was synced before the death", 0L, savedTask(image, "a").optLong("checkpoint", 0))
    assertEquals(1_048_576L, File(image, "internal/acc/a.bin.part").length())
    // Offline relaunches: the copies load and recover but start no transfer.
    fun variant(name: String, configure: (FakePlatform) -> Unit): Pair<DownloadEngine, File> {
      val copy = crashImage(image, name)
      return relaunch(copy) { it.net = Net.NONE; configure(it) } to copy
    }
    val (same, sameRoot) = variant("death-same") {}
    assertEquals(1_048_576.0, same.get("a")!!["bytesWritten"])
    assertEquals("adopted, then synced and persisted", 1_048_576L, savedTask(sameRoot, "a").getLong("checkpoint"))
    for ((name, configure) in listOf<Pair<String, (FakePlatform) -> Unit>>(
      "death-reboot" to { it.boot = "boot-2" },
      "death-unknown" to { it.boot = null },
      "death-elapsed" to { it.elapsedShift = -TimeUnit.DAYS.toMillis(3650) },
    )) {
      val (other, otherRoot) = variant(name, configure)
      assertEquals(name, 0.0, other.get("a")!!["bytesWritten"])
      assertEquals(name, 0L, File(otherRoot, "internal/acc/a.bin.part").length())
    }
    // The adopted bytes continue with Range + If-Range after the death.
    Fixtures.responses["death"] = Fixtures.partial("bytes 1048576-1048579/$total", body = "BBBB")
    Fixtures.requests.remove("death")
    val resumedRoot = crashImage(image, "death-resume")
    val resumed = relaunch(resumedRoot)
    await("completed") { resumed.state("a") == States.COMPLETED }
    assertEquals("bytes=1048576-", Fixtures.requests["death"]!!.last()["Range"])
    assertEquals("\"a\"", Fixtures.requests["death"]!!.last()["If-Range"])
    assertEquals(total.toLong(), File(resumedRoot, "internal/acc/a.bin").length())
  }

  /** D-01: a sync that fails at load leaves the checkpoint where it was, so a later reboot still trims to synced bytes. */
  @Test fun aSameBootAdoptionRaisesTheCheckpointOnlyAfterItsSync() {
    val root = Fixtures.work("adopt-sync")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, etag = "\"a\"", checkpoint = 2, totalBytes = 8),
    ), clock = SavedClock("boot-1", 0, 0)))
    File(root, "internal/acc").mkdirs()
    File(root, "internal/acc/a.bin.part").writeText("AAAAAA")
    Transfer.sync = { throw java.io.SyncFailedException("sync failed") }
    try {
      assertEquals(6.0, relaunch(root).get("a")!!["bytesWritten"])
    } finally {
      Transfer.sync = { it.sync() }
    }
    assertEquals(2L, savedTask(root, "a").getLong("checkpoint"))
    assertEquals(2.0, relaunch(root) { it.boot = "boot-2" }.get("a")!!["bytesWritten"])
    File(root, "internal/acc/a.bin.part").writeText("AAAAAAAAAA")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, etag = "\"a\"", checkpoint = 2, totalBytes = 8),
    ), clock = SavedClock("boot-1", 0, 0)))
    assertEquals("capped at the total", 8.0, relaunch(root).get("a")!!["bytesWritten"])
    assertEquals(8L, savedTask(root, "a").getLong("checkpoint"))
  }

  /** D-01: a running transfer syncs and persists its checkpoint every 5 s (and every 8 MiB), not only every 16 MiB. */
  @Test fun aRunningTransferCheckpointsEveryFiveSeconds() {
    var clock = 0L
    val entered = CountDownLatch(1)
    Fixtures.responses["cadence"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(4 * 1024 * 1024), stallAfter(6 * 64 * 1024, entered) { clock += 1_000 })
    val (engine, platform, _) = engine("cadence")
    val root = platform.stateDir.parentFile
    Transfer.nowMs = { clock }
    try {
      engine.start(spec("a", "cadence", size = 4L * 1024 * 1024))
      assertTrue(entered.await(5, TimeUnit.SECONDS))
      // The 5th read is 5 s after the start: 5 x 64 KiB were synced and persisted right away.
      assertEquals(5L * 64 * 1024, savedTask(root, "a").optLong("checkpoint", 0))
    } finally {
      Transfer.nowMs = { System.nanoTime() / 1_000_000 }
    }
    engine.cancel("a")
    val fast = CountDownLatch(1)
    Fixtures.responses["cadence-mib"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(12 * 1024 * 1024), stallAfter(9 * 1024 * 1024, fast))
    Transfer.nowMs = { 0L }
    try {
      engine.start(spec("b", "cadence-mib", size = 12L * 1024 * 1024))
      assertTrue(fast.await(10, TimeUnit.SECONDS))
      assertEquals("every 8 MiB", 8L * 1024 * 1024, savedTask(root, "b").optLong("checkpoint", 0))
    } finally {
      Transfer.nowMs = { System.nanoTime() / 1_000_000 }
    }
    engine.cancel("b")
  }

  /** N1-02 under D-01: a death between the truncate for a new version and the persisted validator never mixes bytes. */
  @Test fun aDeathBetweenTruncateAndPersistNeverMixesValidators() {
    val root = Fixtures.work("truncate-death")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("truncate-death"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.QUEUED, etag = "\"a\"", checkpoint = 4, totalBytes = 8),
    ), clock = SavedClock("boot-1", 0, 0)))
    File(root, "internal/acc").mkdirs()
    val part = File(root, "internal/acc/a.bin.part").apply { writeText("AAAA") }
    Fixtures.responses["truncate-death"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    var image: File? = null
    Transfer.sync = { fd -> if (image == null && part.exists() && part.length() == 0L) image = crashImage(root, "truncate-death-image"); fd.sync() }
    try {
      val engine = relaunch(root)
      await("completed") { engine.state("a") == States.COMPLETED }
    } finally {
      Transfer.sync = { it.sync() }
    }
    val crashed = image ?: error("no truncate seen")
    assertEquals("the validator was not persisted yet", "\"a\"", savedTask(crashed, "a").getString("etag"))
    Fixtures.responses["truncate-death"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray())
    val again = relaunch(crashed)
    await("completed after the death") { again.state("a") == States.COMPLETED }
    assertEquals("BBBBBBBB", File(crashed, "internal/acc/a.bin").readText())
  }

  /** D-02: every path that drops the bytes on disk counts exactly one restart and resets bytesWritten; a 403 keeps them. */
  @Test fun everyDropOfTheBytesOnDiskCountsOneRestart() {
    data class Case(val name: String, val etag: String?, val pinned: String?, val answer: Fixture, val settled: String)
    val cases = listOf(
      Case("no strong validator", "W/\"a\"", null, Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray()), States.COMPLETED),
      Case("200 to the Range", "\"a\"", null, Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray()), States.COMPLETED),
      Case("206 elsewhere", "\"a\"", null, Fixtures.partial("bytes 5-7/8", body = "BBB"), States.RETRYING),
      Case("206 with another ETag", "\"a\"", null, Fixtures.partial("bytes 4-7/8", etag = "\"b\""), States.RETRYING),
      Case("416", "\"a\"", null, Fixture(416, emptyMap(), ByteArray(0)), States.FAILED),
      Case("pinned ETag changed", "\"a\"", "\"a\"", Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBB".toByteArray()), States.FAILED),
    )
    for ((index, case) in cases.withIndex()) {
      val host = "drop$index"
      val root = Fixtures.work("drop-$index")
      TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
        TaskRecord("a", Fixtures.url(host), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, case.pinned, null, States.QUEUED, bytesWritten = 4,
          etag = case.etag, checkpoint = 4, totalBytes = 8),
      ), clock = SavedClock("boot-1", 0, 0)))
      File(root, "internal/acc").mkdirs()
      File(root, "internal/acc/a.bin.part").writeText("AAAA")
      Fixtures.responses[host] = case.answer
      val engine = relaunch(root)
      await(case.name) { engine.state("a") == case.settled }
      val task = engine.get("a")!!
      assertEquals(case.name, 1, (task["restarts"] as Number).toInt())
      if (case.settled != States.COMPLETED) assertEquals(case.name, 0.0, task["bytesWritten"])
      engine.pause("a")
    }
    // A 403 (downloads not allowed) keeps the bytes: no restart, and the renewed URL continues with Range + If-Range.
    val root = Fixtures.work("drop-403")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("drop403"), emptyMap(), "acc/a.bin", Volumes.INTERNAL, 8, null, null, States.QUEUED, bytesWritten = 4,
        etag = "\"a\"", checkpoint = 4, totalBytes = 8),
    ), clock = SavedClock("boot-1", 0, 0)))
    File(root, "internal/acc").mkdirs()
    File(root, "internal/acc/a.bin.part").writeText("AAAA")
    Fixtures.responses["drop403"] = Fixture(403, mapOf("Content-Type" to "application/json"), "{\"code\":\"downloads_not_allowed\"}".toByteArray())
    val engine = relaunch(root)
    await("failed 403") { engine.state("a") == States.FAILED }
    assertEquals(listOf(4.0, 0), engine.get("a")!!.let { listOf(it["bytesWritten"], (it["restarts"] as Number).toInt()) })
    Fixtures.responses["drop403-renewed"] = Fixtures.partial("bytes 4-7/8", body = "BBBB")
    engine.resume("a", Fixtures.url("drop403-renewed"), null)
    await("completed") { engine.state("a") == States.COMPLETED }
    assertEquals("bytes=4-", Fixtures.requests["drop403-renewed"]!!.single()["Range"])
    assertEquals("\"a\"", Fixtures.requests["drop403-renewed"]!!.single()["If-Range"])
    assertEquals(0, (engine.get("a")!!["restarts"] as Number).toInt())
    assertEquals("AAAABBBB", File(root, "internal/acc/a.bin").readText())
  }

  /** A part of 4 synced bytes plus 4 the card reported but never received (zeros after a surprise removal). */
  private fun lostPagesState(root: File, volume: String, state: String, host: String) {
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url(host), emptyMap(), "m.bin", volume, 12, null, null, state, bytesWritten = 4, totalBytes = 12, etag = "\"a\"", checkpoint = 4),
    ), clock = SavedClock("boot-1", 0, 0)))
  }

  private fun shown(file: File) = file.readBytes().joinToString("") { if (it == 0.toByte()) "0" else it.toInt().toChar().toString() }

  /** Was REPRO_N5_sameBootAdoptsUnsyncedBytesOnARemovableCard: a removable card trims to its checkpoint on the same boot too. */
  @Test fun aRemovableCardNeverAdoptsBytesPastItsCheckpoint() {
    val root = Fixtures.work("lost-pages")
    val sd = Volume("volume-5D01-0001", File(root, "sd"), removable = true)
    File(sd.root, "m.bin.part").apply { parentFile.mkdirs(); writeBytes("AAAA".toByteArray() + ByteArray(4)) }
    lostPagesState(root, sd.id, States.PAUSED, "lost-pages")
    val engine = relaunch(root) { it.extraVolumes += sd }
    assertEquals("trimmed to the synced checkpoint", 4.0, engine.get("a")!!["bytesWritten"])
    Fixtures.responses["lost-pages"] = Fixtures.partial("bytes 4-11/12", body = "BBBBCCCC")
    Fixtures.requests.remove("lost-pages")
    engine.resume("a", null, null)
    await("completed") { engine.state("a") == States.COMPLETED }
    assertEquals("bytes=4-", Fixtures.requests["lost-pages"]!!.single()["Range"])
    assertEquals("AAAABBBBCCCC", shown(File(sd.root, "m.bin")))
    // Internal storage on the same boot still adopts what the kernel holds (D-01).
    val internalRoot = Fixtures.work("kept-pages")
    File(internalRoot, "internal").mkdirs()
    File(internalRoot, "internal/m.bin.part").writeBytes("AAAABBBB".toByteArray())
    lostPagesState(internalRoot, Volumes.INTERNAL, States.PAUSED, "kept-pages")
    assertEquals(8.0, relaunch(internalRoot).get("a")!!["bytesWritten"])
  }

  /** N5-01: a card that leaves and returns within one process trims to the checkpoint before the next request. */
  @Test fun aCardThatReturnsInTheSameProcessTrimsBeforeTheNextRequest() {
    val root = Fixtures.work("card-returns")
    val sd = Volume("volume-5D01-0002", File(root, "sd"), removable = true)
    File(sd.root, "m.bin.part").apply { parentFile.mkdirs(); writeBytes("AAAA".toByteArray() + ByteArray(4)) }
    lostPagesState(root, sd.id, States.QUEUED, "card-returns")
    Fixtures.responses["card-returns"] = Fixtures.partial("bytes 4-11/12", body = "BBBBCCCC")
    Fixtures.requests.remove("card-returns")
    var platform: FakePlatform? = null
    val engine = relaunch(root) { platform = it }
    assertEquals(States.FAILED, engine.state("a"))
    assertEquals(8L, File(sd.root, "m.bin.part").length())
    platform!!.extraVolumes += sd
    engine.pump()
    await("completed after the return") { engine.state("a") == States.COMPLETED }
    assertEquals("bytes=4-", Fixtures.requests["card-returns"]!!.single()["Range"])
    assertEquals("AAAABBBBCCCC", shown(File(sd.root, "m.bin")))
    assertEquals(0, (engine.get("a")!!["restarts"] as Number).toInt())
  }

  /** N5-01: the trim waits for a worker still ending on the returned card; the next request then starts at the checkpoint. */
  @Test fun aWorkerStillEndingOnTheReturnedCardHoldsBackTheTrim() {
    val entered = CountDownLatch(1)
    val release = CountDownLatch(1)
    // 'AAAA', then a read that outlives the closed socket (a write hung on the vanished card) until released.
    val hung: () -> InputStream = {
      object : InputStream() {
        var step = 0
        override fun read(): Int = error("bulk only")
        override fun read(b: ByteArray, off: Int, len: Int): Int {
          if (step++ == 0) {
            "AAAA".toByteArray().copyInto(b, off)
            return 4
          }
          entered.countDown()
          release.await(10, TimeUnit.SECONDS)
          throw IOException("card gone")
        }
      }
    }
    Fixtures.responses["hung-card"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(12), hung)
    val (engine, platform, _) = engine("hung-card")
    val sd = Volume("volume-5D01-0003", File(platform.stateDir.parentFile, "sd"), removable = true)
    platform.extraVolumes += sd
    engine.start(spec("a", "hung-card", "m.bin", size = 12, volume = sd.id))
    assertTrue(entered.await(5, TimeUnit.SECONDS))
    platform.extraVolumes.clear()
    engine.pump()
    assertEquals(States.FAILED, engine.state("a"))
    // The card comes back with 4 bytes it reports but never received.
    val part = File(sd.root, "m.bin.part")
    part.appendBytes(ByteArray(4))
    platform.extraVolumes += sd
    engine.pump()
    assertEquals("no trim while the worker still ends", 8L, part.length())
    Fixtures.responses["hung-card"] = Fixtures.partial("bytes 4-11/12", body = "BBBBCCCC")
    Fixtures.requests.remove("hung-card")
    release.countDown()
    await("completed") { engine.state("a") == States.COMPLETED }
    assertEquals("bytes=4-", Fixtures.requests["hung-card"]!!.single()["Range"])
    assertEquals("AAAABBBBCCCC", shown(File(sd.root, "m.bin")))
  }

  /** Was REPRO_N5_aVanishedPartLosesItsBytesWithoutARestart: a part deleted between launches counts one restart (D-02). */
  @Test fun aVanishedPartCountsOneRestart() {
    val root = Fixtures.work("vanished")
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("vanished"), emptyMap(), "v.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED, bytesWritten = 4, totalBytes = 8,
        etag = "\"a\"", checkpoint = 4),
    ), clock = SavedClock("boot-1", 0, 0)))
    val engine = relaunch(root)
    val loaded = engine.get("a")!!
    assertEquals(0.0, loaded["bytesWritten"])
    assertEquals(1, (loaded["restarts"] as Number).toInt())
    Fixtures.responses["vanished"] = Fixture(200, mapOf("ETag" to "\"a\""), "AAAAAAAA".toByteArray())
    engine.resume("a", null, null)
    await("completed") { engine.state("a") == States.COMPLETED }
    assertEquals("one restart, not two", 1, (engine.get("a")!!["restarts"] as Number).toInt())
    assertEquals(1, (relaunch(root).get("a")!!["restarts"] as Number).toInt())
  }

  /** Was REPRO_N6_aNewDownloadCountsARestartForAQueuedPartialItInherits: the queued partial goes before the new task starts. */
  @Test fun aNewDownloadNeverInheritsAQueuedPartial() {
    val root = Fixtures.work("inherit")
    val sd = Volume("volume-6E01-0001", File(root, "sd"), removable = true)
    File(sd.root, "m.bin.part").apply { parentFile.mkdirs(); writeText("AAAA") }
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "m.bin", sd.id, 12, null, null, States.PAUSED, bytesWritten = 4, totalBytes = 12,
        etag = "\"a\"", checkpoint = 4),
    ), clock = SavedClock("boot-1", 0, 0)))
    var platform: FakePlatform? = null
    val engine = relaunch(root) { it.extraVolumes += sd; platform = it }
    platform!!.extraVolumes.clear()
    engine.pump()
    engine.cancel("a")
    assertEquals(1, disposalCount(platform!!))
    // The card is back, but no pump ran yet: the new download on the same path must not take A's bytes.
    platform!!.extraVolumes += sd
    Fixtures.responses["inherit-b"] = Fixture(200, mapOf("ETag" to "\"b\""), "BBBBBBBBBBBB".toByteArray())
    engine.start(spec("b", "inherit-b", "m.bin", size = 12, volume = sd.id))
    await("completed") { engine.state("b") == States.COMPLETED }
    assertEquals(0, (engine.get("b")!!["restarts"] as Number).toInt())
    assertEquals("BBBBBBBBBBBB", File(sd.root, "m.bin").readText())
    assertEquals(0, disposalCount(platform!!))
    assertEquals("A's partial was deleted, not truncated by B", 1, platform!!.logs.count { it == "a: queued partial on ${sd.id} deleted" })
  }

  /** N6-03: a stray part a new task truncates is not its own; only the task's own bytes count a restart (iOS parity). */
  @Test fun aStrayPartANewTaskTruncatesIsNoRestart() {
    val (engine, platform, _) = engine("stray")
    file(platform, "acc/s.bin.part").apply { parentFile.mkdirs(); writeText("ZZZZ") }
    Fixtures.responses["stray"] = Fixture(200, mapOf("ETag" to "\"s\""), "SSSSSSSS".toByteArray())
    engine.start(spec("s", "stray", "acc/s.bin"))
    await("completed") { engine.state("s") == States.COMPLETED }
    assertEquals(0, (engine.get("s")!!["restarts"] as Number).toInt())
    assertEquals("SSSSSSSS", file(platform, "acc/s.bin").readText())
  }

  /** Was REPRO_N7_aDisposalLeavesItsDirectoryAndTheAncestorDownloadCannotPublish: the emptied directory goes with the partial. */
  @Test fun aDisposalTakesItsEmptiedDirectoryAndTheAncestorDownloadPublishes() {
    val root = Fixtures.work("ancestor")
    val sd = Volume("volume-7E01-0001", File(root, "sd"), removable = true)
    File(sd.root, "show/m.bin.part").apply { parentFile.mkdirs(); writeText("AAAA") }
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("old", Fixtures.url("never"), emptyMap(), "show/m.bin", sd.id, 12, null, null, States.PAUSED, bytesWritten = 4, totalBytes = 12,
        etag = "\"a\"", checkpoint = 4),
    ), clock = SavedClock("boot-1", 0, 0)))
    var platform: FakePlatform? = null
    val engine = relaunch(root) { it.extraVolumes += sd; platform = it }
    platform!!.extraVolumes.clear()
    engine.pump()
    engine.cancel("old")
    assertEquals(1, disposalCount(platform!!))
    platform!!.extraVolumes += sd
    Fixtures.responses["ancestor-a"] = Fixture(200, mapOf("ETag" to "\"s\""), "SSSSSSSSSSSS".toByteArray())
    engine.start(spec("a", "ancestor-a", "show", size = 12, volume = sd.id))
    await("completed") { engine.state("a") == States.COMPLETED || engine.state("a") == States.FAILED }
    assertEquals(States.COMPLETED, engine.state("a"))
    assertEquals("SSSSSSSSSSSS", File(sd.root, "show").readText())
    assertEquals(0, disposalCount(platform!!))
  }

  /** N7-02: a directory at the final path or its partial is refused at start, before any request. */
  @Test fun aDownloadOntoADirectoryIsRefusedBeforeItStarts() {
    val (engine, platform, _) = engine("onto-dir")
    file(platform, "acc/movie/extra.txt").apply { parentFile.mkdirs(); writeText("X") }
    file(platform, "acc/clip.bin.part").mkdirs()
    Fixtures.requests.remove("onto-dir")
    assertEquals("invalid_state: path acc/movie is a directory", message { engine.start(spec("a", "onto-dir", "acc/movie")) })
    assertEquals("invalid_state", code { engine.start(spec("b", "onto-dir", "acc/clip.bin")) })
    assertEquals(null, engine.get("a"))
    assertEquals(null, engine.get("b"))
    assertNull(Fixtures.requests["onto-dir"])
    assertEquals("X", file(platform, "acc/movie/extra.txt").readText())
  }

  /** N7-02: pruning stops at the first non-empty directory and never takes one a registered download's path lies in. */
  @Test fun pruningStopsAtContentAndAtAnotherDownloadsDirectory() {
    val root = Fixtures.work("prune")
    val internal = File(root, "internal")
    File(internal, "acc/x/y/a.bin.part").apply { parentFile.mkdirs(); writeText("AAAA") }
    File(internal, "acc/x/keep.txt").writeText("K")
    File(internal, "acc/w/c.bin.part").apply { parentFile.mkdirs(); writeText("CCCC") }
    TaskStore(File(root, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("a", Fixtures.url("never"), emptyMap(), "acc/x/y/a.bin", Volumes.INTERNAL, 8, null, null, States.FAILED, bytesWritten = 4,
        totalBytes = 8, etag = "\"a\"", checkpoint = 4),
      TaskRecord("c", Fixtures.url("never"), emptyMap(), "acc/w/c.bin", Volumes.INTERNAL, 8, null, null, States.FAILED, bytesWritten = 4,
        totalBytes = 8, etag = "\"a\"", checkpoint = 4),
      TaskRecord("b", Fixtures.url("never"), emptyMap(), "acc/w/b.bin", Volumes.INTERNAL, 8, null, null, States.PAUSED),
    ), clock = SavedClock("boot-1", 0, 0)))
    val engine = relaunch(root)
    engine.remove("a")
    assertFalse("the emptied directory goes", File(internal, "acc/x/y").exists())
    assertTrue("a directory with content stays", File(internal, "acc/x/keep.txt").exists())
    engine.remove("c")
    assertFalse(File(internal, "acc/w/c.bin.part").exists())
    assertTrue("b's path lies in acc/w", File(internal, "acc/w").isDirectory)
    engine.cancel("b")
    // A volume whose only content was this partial keeps its (now empty) root.
    val solo = Fixtures.work("prune-solo")
    File(solo, "internal/solo/s.bin.part").apply { parentFile.mkdirs(); writeText("SSSS") }
    TaskStore(File(solo, "state")).save(StoredState(Settings(), listOf(
      TaskRecord("s", Fixtures.url("never"), emptyMap(), "solo/s.bin", Volumes.INTERNAL, 8, null, null, States.FAILED, bytesWritten = 4,
        totalBytes = 8, etag = "\"a\"", checkpoint = 4),
    ), clock = SavedClock("boot-1", 0, 0)))
    relaunch(solo).remove("s")
    assertFalse(File(solo, "internal/solo").exists())
    assertTrue("the volume root is never pruned", File(solo, "internal").isDirectory)
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
