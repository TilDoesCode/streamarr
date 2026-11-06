package expo.modules.offlinedownloads

import expo.modules.offlinedownloads.Fixtures.Fixture
import java.io.File
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

    override val stateDir = File(dir, "state")
    override fun now() = System.currentTimeMillis()
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

  /** Body that blocks after `head` until `release` opens. */
  private fun gated(head: String, tail: String, release: CountDownLatch): () -> InputStream = {
    object : InputStream() {
      var step = 0
      override fun read(): Int = error("bulk only")
      override fun read(b: ByteArray, off: Int, len: Int): Int = when (step++) {
        0 -> { head.toByteArray().copyInto(b, off); head.length }
        1 -> { release.await(20, TimeUnit.SECONDS); tail.toByteArray().copyInto(b, off); tail.length }
        else -> -1
      }
    }
  }

  private fun spec(id: String, host: String, path: String = "acc/$id.bin", size: Long = 8, volume: String = Volumes.INTERNAL) =
    mapOf("id" to id, "url" to Fixtures.url(host), "relativePath" to path, "expectedBytes" to size, "volumeId" to volume)

  private fun file(platform: FakePlatform, path: String) = File(platform.volumes().first().root, path)

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
