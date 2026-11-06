package expo.modules.offlinedownloads

import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.StatFs
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

class Volume(val id: String, val root: File, val removable: Boolean) {
  val uri: String get() = Uri.fromFile(root).toString().let { if (it.endsWith("/")) it else "$it/" }

  fun freeBytes(): Long = statFs()?.availableBytes ?: 0L

  fun totalBytes(): Long = statFs()?.totalBytes ?: 0L

  private fun statFs(): StatFs? {
    root.mkdirs()
    return runCatching { StatFs(root.absolutePath) }.getOrNull()
  }
}

/** App-private storage roots: internal files dir (not cache) plus app-specific dirs on secondary (SD/USB) storage. */
class Volumes(private val context: Context) {
  fun all(): List<Volume> {
    val external = context.getExternalFilesDirs(null).filterNotNull().mapIndexedNotNull { index, dir ->
      val emulated = runCatching { Environment.isExternalStorageEmulated(dir) }.getOrDefault(true)
      if (emulated) null else Volume("external-$index", File(dir, ROOT), runCatching { Environment.isExternalStorageRemovable(dir) }.getOrDefault(true))
    }
    return listOf(internal()) + external
  }

  fun internal() = Volume(INTERNAL, File(context.filesDir, ROOT), removable = false)

  fun get(id: String?): Volume {
    if (id == null || id == INTERNAL) return internal()
    return all().firstOrNull { it.id == id } ?: throw DownloadException("not_found", "unknown volume $id")
  }

  /** Resolves a relative path under a volume root and refuses anything that escapes it. */
  fun resolve(relativePath: String, volumeId: String?): File {
    val volume = get(volumeId)
    if (relativePath.isBlank()) throw DownloadException("invalid_argument", "empty path")
    val root = volume.root.canonicalFile
    val file = File(root, relativePath).canonicalFile
    if (file == root || !file.path.startsWith(root.path + File.separator)) {
      throw DownloadException("invalid_argument", "path escapes the download root: $relativePath")
    }
    return file
  }

  companion object {
    const val INTERNAL = "internal"
    const val ROOT = "downloads"
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

/** Settings and task registry in one JSON file, written atomically (temp file + rename). */
class TaskStore(context: Context) {
  private val file = File(File(context.filesDir, "offline-downloads"), "state.json")

  fun load(): Pair<Settings, List<TaskRecord>> {
    if (!file.exists()) return Settings() to emptyList()
    return runCatching {
      val json = JSONObject(file.readText())
      val tasks = json.optJSONArray("tasks")
      val list = (0 until (tasks?.length() ?: 0)).mapNotNull { index -> runCatching { TaskRecord.fromJson(tasks!!.getJSONObject(index)) }.getOrNull() }
      Settings.fromJson(json.optJSONObject("settings")) to list
    }.getOrElse { Settings() to emptyList() }
  }

  fun save(settings: Settings, tasks: Collection<TaskRecord>) {
    file.parentFile?.mkdirs()
    val temp = File(file.parentFile, "state.json.tmp")
    temp.writeText(JSONObject().put("version", 1).put("settings", settings.toJson()).put("tasks", tasksToJson(tasks)).toString())
    if (!temp.renameTo(file)) {
      file.delete()
      temp.renameTo(file)
    }
  }
}
