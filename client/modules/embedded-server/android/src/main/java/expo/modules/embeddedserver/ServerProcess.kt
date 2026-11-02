package expo.modules.embeddedserver

import java.io.File
import java.util.concurrent.TimeUnit

/** One spawned Core Server process with its output pumped into the log. */
class ServerProcess private constructor(private val process: Process, val pid: Int?) {
  val isAlive: Boolean get() = process.isAlive

  fun waitFor(timeoutMs: Long): Boolean = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS)

  fun exitCode(): Int? = runCatching { process.exitValue() }.getOrNull()

  /** SIGTERM, then SIGKILL after the grace period; waits until the process is gone. */
  fun terminate(graceMs: Long) {
    if (!process.isAlive) return
    process.destroy()
    if (!process.waitFor(graceMs, TimeUnit.MILLISECONDS)) {
      process.destroyForcibly()
      process.waitFor(5, TimeUnit.SECONDS)
    }
  }

  companion object {
    fun start(command: List<String>, environment: Map<String, String>, workingDir: File, log: ServerLog): ServerProcess {
      val builder = ProcessBuilder(command).directory(workingDir).redirectErrorStream(true)
      builder.environment().putAll(environment)
      val process = builder.start()
      Thread({
        try {
          process.inputStream.bufferedReader().forEachLine { log.append(it) }
        } catch (_: Exception) {
        }
      }, "streamarr-server-log").apply { isDaemon = true }.start()
      return ServerProcess(process, pidOf(process))
    }

    // Android's java.lang.Process has no pid(); the implementation class keeps it in a private field.
    private fun pidOf(process: Process): Int? = runCatching {
      process.javaClass.getDeclaredField("pid").apply { isAccessible = true }.getInt(process)
    }.getOrNull()
  }
}
