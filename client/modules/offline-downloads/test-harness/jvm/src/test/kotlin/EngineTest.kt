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

    /** Shift the wall clock (rollback / jump) or the elapsed clock; `boot` changes on a simulated reboot. */
    @Volatile var wallShift = 0L
    @Volatile var elapsedShift = 0L
    @Volatile var boot: String? = "boot-1"

    override val stateDir = File(dir, "state")
    override fun now() = System.currentTimeMillis() + wallShift
    override fun elapsed() = TimeUnit.NANOSECONDS.toMillis(System.nanoTime()) + elapsedShift
    override fun bootId() = boot
    override fun log(message: String) { logs += message }
    override fun network() = net
    override fun observe(active: Boolean, onChange: () -> Unit) { this.onChange = if (active) onChange else null }
    override fun volumes() = listOf(Volume(Volumes.INTERNAL, File(dir, "internal"), false)) + extraVolumes
    override fun requestHost(replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Boolean {
      hostRequests += 1
      thread { engine.attachHost(Host()) }
      return true
    }
    override fun cancelHostRequest() {}
    override fun summary(finished: Int, failed: Int) {}
    override fun clearNotification() {}
    override fun lastExit() = exit
    override fun visible() = false

    class Host : TransferHost {
      override fun update(progress: ProgressSnapshot) {}
      override fun finish() {}
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

  /** Was REPRO_oldExternalVolumeIdNeverFindsItsMountedMedium (N2-05): v1 ids move only to the medium a path names. */
  @Test fun legacyExternalVolumeIdsAreReboundOnlyByTheirMedium() {
    val root = Fixtures.work("engine-legacy-volume")
    val sd = Volume("volume-ABCD-1234", File(root, "sd"), removable = true)
    File(sd.root, "movie.bin").apply { parentFile.mkdirs(); writeText("AAAAAAAA") }
    fun record(id: String, path: String, volume: String, state: String) =
      TaskRecord(id, Fixtures.url("never"), emptyMap(), path, volume, 8, null, null, state, bytesWritten = 8, totalBytes = 8).toJson()
    val tasks = JSONArray()
      .put(record("named", "movie.bin", "external-0", States.COMPLETED).put("uri", "file:///storage/ABCD-1234/Android/data/dev.streamarr.app/files/downloads/movie.bin"))
      .put(record("done", "other.bin", "external-0", States.COMPLETED))
      .put(record("pending", "next.bin", "external-1", States.RUNNING))
    File(root, "state").mkdirs()
    File(root, "state/state.json").writeText(JSONObject().put("version", 1).put("settings", Settings().toJson()).put("tasks", tasks).toString())
    val platform = FakePlatform(root).apply { extraVolumes += sd }
    val engine = DownloadEngine(platform).also { platform.engine = it; it.load() }
    val named = engine.get("named")!!
    assertEquals("volume-ABCD-1234", named["volumeId"])
    assertEquals(States.COMPLETED, named["state"])
    assertTrue((named["uri"] as String).endsWith("sd/movie.bin"))
    for (id in listOf("done", "pending")) {
      assertEquals(id, States.FAILED, engine.state(id))
      assertEquals(id, DownloadEngine.VOLUME_UNAVAILABLE, (engine.get(id)!!["error"] as Map<*, *>)["message"])
    }
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
    assertEquals(retryAt, (engine.get("a")!!["retryAt"] as Double).toLong())
    await("completed after the cooldown") { engine.state("a") == States.COMPLETED }
    assertTrue(System.currentTimeMillis() >= retryAt)
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

  @Test fun hostStoppedByTheUserPausesAndIsNotRescheduled() {
    val release = CountDownLatch(1)
    Fixtures.responses["hoststop"] = Fixture(200, mapOf("ETag" to "\"a\""), ByteArray(8), gated("AA", "AAAAAA", release))
    val (engine, _, _) = engine("hoststop")
    engine.start(spec("a", "hoststop"))
    await("running") { engine.state("a") == States.RUNNING }
    val host = FakePlatform.Host()
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
