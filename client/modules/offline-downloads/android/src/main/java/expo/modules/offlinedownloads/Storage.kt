package expo.modules.offlinedownloads

import android.net.Uri
import android.os.Build
import android.os.StatFs
import org.json.JSONArray
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

    /** Ownership key: `a//b/./c` → `a/b/c`, case-insensitive and without trailing dots/spaces, as SD cards (FAT/exFAT) are. */
    /** A segment of only dots or spaces (accepted before N3-03, dev installs only). */
    fun hasEmptySegment(relativePath: String) = relativePath.split('/').any { it.isNotEmpty() && it != "." && it != ".." && it.trimEnd('.', ' ').isEmpty() }

    /** Such a legacy path owns the folder before that segment (none at the top), so no parent delete reaches it (N4-03). */
    fun legacyClaimKey(volumeId: String, relativePath: String): String? {
      val prefix = relativePath.split('/').filter { it.isNotEmpty() && it != "." }.map { it.trimEnd('.', ' ') }.takeWhile { it.isNotEmpty() }
      return if (prefix.isEmpty()) null else "$volumeId:${prefix.joinToString("/").lowercase()}"
    }

    fun claimKey(volumeId: String, relativePath: String): String {
      val parts = relativePath.split('/').filter { it.isNotEmpty() && it != "." }
      if (parts.isEmpty()) throw DownloadException("invalid_argument", "empty path")
      if (".." in parts) throw DownloadException("invalid_argument", "path escapes the download root: $relativePath")
      val stripped = parts.map { it.trimEnd('.', ' ') }
      if (stripped.any { it.isEmpty() }) throw DownloadException("invalid_argument", "empty path segment: $relativePath")
      return "$volumeId:${stripped.joinToString("/").lowercase()}"
    }

    /** A segment ending in a dot or space would alias another name on FAT/exFAT media (N3-03). */
    fun requirePortable(relativePath: String) {
      val bad = relativePath.split('/').firstOrNull { it.isNotEmpty() && it != "." && (it.endsWith('.') || it.endsWith(' ')) }
      if (bad != null) throw DownloadException("invalid_argument", "a path segment may not end in a dot or space: $relativePath")
    }
  }
}

class DownloadException(val code: String, detail: String) : Exception("$code: $detail")

object Files {
  fun delete(file: File) {
    if (file.isDirectory) file.deleteRecursively() else file.delete()
  }

  /** Replaces a file target (atomic within a directory, a rename on one volume across them); a directory target, an empty one too, is refused (N9-02). */
  fun move(from: File, to: File) {
    if (!from.exists()) throw DownloadException("not_found", "missing ${from.name}")
    if (to.isDirectory) throw DownloadException("invalid_state", "${to.name} is a directory")
    to.parentFile?.mkdirs()
    if (!from.renameTo(to)) {
      if (to.exists() && !to.isDirectory) to.delete()
      if (!from.renameTo(to)) throw DownloadException("io", "rename ${from.name} -> ${to.name} failed")
    }
    syncDirectory(to.parentFile)
  }

  /** Persists a rename/create in a directory (skipped below API 26, where java.nio.file is missing). */
  fun syncDirectory(dir: File?) {
    if (dir == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
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

/** Elapsed clock, boot identity and wall clock at the save: waits are restored against them (N2-04). */
data class SavedClock(val bootId: String?, val elapsed: Long, val wall: Long)

/** A partial that must go once its volume is mounted and its worker ended; `owner` is the task it belonged to (N3-05). */
/** `since`: wall-clock ms it was queued (0 in state saved before N4-02: the load stamps it). */
data class Disposal(val volumeId: String, val relativePath: String, val owner: String, val since: Long = 0)

/** Everything the engine persists; `legacyUnresolved`: v1 tasks on an `external-<n>` volume (N2-05). */
data class StoredState(
  val settings: Settings,
  val tasks: List<TaskRecord>,
  val lastExitHandled: Long = 0,
  val clock: SavedClock? = null,
  val version: Int = TaskStore.VERSION,
  val legacyUnresolved: Set<String> = emptySet(),
  /** Last host token handed out: a job JobScheduler restarts after a process death still orders correctly (N2-11). */
  val hostToken: Long = 0,
  val disposals: List<Disposal> = emptyList(),
  /** Ids whose cancel/remove already took effect (disposal done): a retried call resolves instead of `not_found`. */
  val settled: List<String> = emptyList(),
)

/** Settings, task registry and exit bookkeeping in one JSON file, written durably. */
class TaskStore(dir: File) {
  private val file = File(dir, "state.json")

  fun load(): StoredState {
    if (!file.exists()) return StoredState(Settings(), emptyList())
    return runCatching {
      val json = JSONObject(file.readText())
      val version = json.optInt("version", 1)
      val array = json.optJSONArray("tasks")
      val legacy = mutableSetOf<String>()
      val list = (0 until (array?.length() ?: 0)).mapNotNull { index ->
        runCatching {
          val raw = array!!.getJSONObject(index)
          if (version < 2) migrateVolume(raw)?.let { legacy += it }
          TaskRecord.fromJson(raw)
        }.getOrNull()
      }
      val clock = json.optJSONObject("clock")?.let {
        SavedClock(if (it.isNull("bootId")) null else it.optString("bootId"), it.getLong("elapsed"), it.getLong("wall"))
      }
      val disposals = json.optJSONArray("disposals")?.let { array ->
        (0 until array.length()).mapNotNull { index ->
          array.optJSONObject(index)?.let { Disposal(it.getString("volumeId"), it.getString("relativePath"), it.getString("owner"), it.optLong("since", 0)) }
        }
      } ?: emptyList()
      val settled = json.optJSONArray("settled")?.let { array -> (0 until array.length()).map { array.getString(it) } } ?: emptyList()
      StoredState(
        Settings.fromJson(json.optJSONObject("settings")), list, json.optLong("lastExitHandled", 0), clock, version, legacy,
        json.optLong("hostToken", 0), disposals, settled,
      )
    }.getOrElse { StoredState(Settings(), emptyList()) }
  }

  fun save(state: StoredState) {
    val json = JSONObject()
      .put("version", VERSION)
      .put("settings", state.settings.toJson())
      .put("tasks", tasksToJson(state.tasks))
      .put("lastExitHandled", state.lastExitHandled)
      .put("hostToken", state.hostToken)
      .put("disposals", JSONArray(state.disposals.map { JSONObject().put("volumeId", it.volumeId).put("relativePath", it.relativePath).put("owner", it.owner).put("since", it.since) }))
      .put("settled", JSONArray(state.settled))
    state.clock?.let { json.put("clock", JSONObject().put("bootId", it.bootId ?: JSONObject.NULL).put("elapsed", it.elapsed).put("wall", it.wall)) }
    Files.writeDurably(file, json.toString())
  }

  companion object {
    /** 1: positional `external-<n>` volume ids; 2: `volume-<uuid>`, wall-clock waits; 3: elapsed-clock waits. */
    const val VERSION = 3
    private val EXTERNAL = Regex("""^external-\d+$""")

    /** A v1 record on a positional `external-<n>` id names no medium: never rebound, it becomes `volume_unavailable` (N3-10). */
    private fun migrateVolume(raw: JSONObject): String? =
      if (EXTERNAL.matches(raw.optString("volumeId"))) raw.getString("id") else null
  }
}
