package expo.modules.offlinedownloads

import android.net.Uri
import android.os.StatFs
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.nio.channels.FileChannel
import java.nio.file.StandardOpenOption
import java.security.MessageDigest

/** A storage root: `internal` (app files dir) or `volume-<uuid>` (app-specific dir on an SD card / USB volume). */
class Volume(val id: String, val root: File, val removable: Boolean) {
  val uri: String get() = Uri.fromFile(root).toString().let { if (it.endsWith("/")) it else "$it/" }

  fun freeBytes(): Long = statFs()?.availableBytes ?: 0L

  fun totalBytes(): Long = statFs()?.totalBytes ?: 0L

  private fun statFs(): StatFs? {
    root.mkdirs()
    return runCatching { StatFs(root.absolutePath) }.getOrNull()
  }
}

/** Mounted volumes, internal first; ids are stable per medium and never reassigned (N1-14). */
class Volumes(private val source: () -> List<Volume>) {
  fun all(): List<Volume> = source()

  fun internal(): Volume = all().first { it.id == INTERNAL }

  fun find(id: String?): Volume? = all().firstOrNull { it.id == (id ?: INTERNAL) }

  fun get(id: String?): Volume = find(id) ?: throw DownloadException("not_found", "unknown volume $id")

  /** Resolves a relative path under a volume root and refuses anything that escapes it. */
  fun resolve(relativePath: String, volumeId: String?): File = resolveIn(get(volumeId), relativePath)

  companion object {
    const val INTERNAL = "internal"
    const val ROOT = "downloads"

    fun resolveIn(volume: Volume, relativePath: String): File {
      if (relativePath.isBlank()) throw DownloadException("invalid_argument", "empty path")
      val root = volume.root.canonicalFile
      val file = File(root, relativePath).canonicalFile
      if (file == root || !file.path.startsWith(root.path + File.separator)) {
        throw DownloadException("invalid_argument", "path escapes the download root: $relativePath")
      }
      return file
    }

    /** Ownership key of a relative path: `a//b/./c` → `a/b/c`, case-insensitive (SD cards are). */
    fun claimKey(volumeId: String, relativePath: String): String {
      val parts = relativePath.split('/').filter { it.isNotEmpty() && it != "." }
      if (parts.isEmpty()) throw DownloadException("invalid_argument", "empty path")
      if (".." in parts) throw DownloadException("invalid_argument", "path escapes the download root: $relativePath")
      return "$volumeId:${parts.joinToString("/").lowercase()}"
    }
  }
}

class DownloadException(val code: String, detail: String) : Exception("$code: $detail")

object Files {
  fun delete(file: File) {
    if (file.isDirectory) file.deleteRecursively() else file.delete()
  }

  /** Same-directory rename replaces the target atomically; across directories it is still a rename on one volume. */
  fun move(from: File, to: File) {
    if (!from.exists()) throw DownloadException("not_found", "missing ${from.name}")
    to.parentFile?.mkdirs()
    if (!from.renameTo(to)) {
      if (to.exists() && !to.isDirectory) to.delete()
      if (!from.renameTo(to)) throw DownloadException("io", "rename ${from.name} -> ${to.name} failed")
    }
    syncDirectory(to.parentFile)
  }

  /** Persists a rename/create in a directory (skipped where java.nio is missing, API < 26). */
  fun syncDirectory(dir: File?) {
    if (dir == null) return
    runCatching { FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) } }
  }

  /** Temp file, fsync, rename, fsync of the directory: the old or the new content survives a crash, never a mix. */
  fun writeDurably(file: File, text: String) {
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, "${file.name}.tmp")
    FileOutputStream(temp).use { out ->
      out.write(text.toByteArray())
      out.flush()
      out.fd.sync()
    }
    if (!temp.renameTo(file)) {
      file.delete()
      if (!temp.renameTo(file)) throw DownloadException("io", "cannot replace ${file.name}")
    }
    syncDirectory(file.parentFile)
  }

  fun sha256(file: File): String {
    if (!file.isFile) throw DownloadException("not_found", "missing ${file.name}")
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(1 shl 20)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}

/** The one completion path (N1-04): the part must have the proven size and validator before it becomes the file. */
object Publisher {
  fun publish(part: File, target: File, total: Long, expectedBytes: Long?, etag: String?, pinnedEtag: String?, recordedEtag: String?): Outcome {
    val length = part.length()
    if (!part.isFile || length != total) return Outcome.Failed(DownloadError("size_mismatch", "part has $length of $total bytes"), false, droppedPartial = true)
    if (expectedBytes != null && total != expectedBytes) {
      return Outcome.Failed(DownloadError("size_mismatch", "size $total, expected $expectedBytes"), false, droppedPartial = true)
    }
    if (pinnedEtag != null && etag != pinnedEtag) {
      return Outcome.Failed(DownloadError("validator_changed", "ETag $etag, expected $pinnedEtag"), false, droppedPartial = true)
    }
    if (recordedEtag != null && etag != null && etag != recordedEtag) {
      return Outcome.Failed(DownloadError("validator_changed", "ETag $etag, bytes on disk were $recordedEtag"), false, droppedPartial = true)
    }
    return try {
      Files.move(part, target)
      Outcome.Ready(total, etag)
    } catch (error: Exception) {
      Outcome.Failed(DownloadError("file_system", error.message ?: "move failed"), false)
    }
  }
}

/** Everything the engine persists. */
data class StoredState(val settings: Settings, val tasks: List<TaskRecord>, val lastExitHandled: Long = 0)

/** Settings, task registry and exit bookkeeping in one JSON file, written durably. */
class TaskStore(dir: File) {
  private val file = File(dir, "state.json")

  fun load(): StoredState {
    if (!file.exists()) return StoredState(Settings(), emptyList())
    return runCatching {
      val json = JSONObject(file.readText())
      val tasks = json.optJSONArray("tasks")
      val list = (0 until (tasks?.length() ?: 0)).mapNotNull { index -> runCatching { TaskRecord.fromJson(tasks!!.getJSONObject(index)) }.getOrNull() }
      StoredState(Settings.fromJson(json.optJSONObject("settings")), list, json.optLong("lastExitHandled", 0))
    }.getOrElse { StoredState(Settings(), emptyList()) }
  }

  fun save(state: StoredState) {
    val json = JSONObject()
      .put("version", 2)
      .put("settings", state.settings.toJson())
      .put("tasks", tasksToJson(state.tasks))
      .put("lastExitHandled", state.lastExitHandled)
    Files.writeDurably(file, json.toString())
  }
}
