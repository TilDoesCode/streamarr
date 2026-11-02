package expo.modules.embeddedserver

import android.content.Context
import android.os.StatFs
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipInputStream
import org.json.JSONObject

/**
 * The server bundle shipped in the APK: exec'd binaries in the native library directory (the only place Android 10+
 * lets an app exec from) and the published .NET app in assets, extracted once per bundle version into the data directory.
 */
class ServerBundle(private val context: Context) {
  val manifest: JSONObject? = runCatching {
    JSONObject(context.assets.open("$ASSET_DIR/manifest.json").bufferedReader().readText())
  }.getOrNull()

  val present: Boolean get() = manifest != null
  val bundleVersion: String = manifest?.optString("bundleVersion")?.takeIf { it.isNotEmpty() } ?: "missing"
  val serverVersion: String? = manifest?.optString("serverVersion")?.takeIf { it.isNotEmpty() }

  val root = File(context.filesDir, "server")
  val dataDir = File(root, "data")
  val cacheDir = File(root, "cache")
  val logDir = File(root, "logs")
  val appDir = File(File(root, "bundles"), bundleVersion)

  private val nativeDir = File(context.applicationInfo.nativeLibraryDir)
  val host = File(nativeDir, "libstreamarr-host.so")
  val ffmpeg = File(nativeDir, "libffmpeg.so")
  val ffprobe = File(nativeDir, "libffprobe.so")
  val tunnelHelper: File? = File(nativeDir, "libstreamarr-tunnel.so").takeIf { it.exists() }
  val nativeLibraryDir: String get() = nativeDir.absolutePath

  fun diskFreeBytes(): Long? = runCatching { StatFs(root.absolutePath).availableBytes }.getOrNull()

  /** Extracts assets/embedded-server/server.zip into the versioned app directory (idempotent) and drops older bundles. */
  fun ensureExtracted(log: ServerLog): File {
    if (!present) throw IllegalStateException("This build has no embedded server bundle")
    if (!host.exists()) throw IllegalStateException("Native host missing: ${host.absolutePath}")
    val marker = File(appDir, COMPLETE_MARKER)
    if (marker.exists()) return appDir
    log.note("extracting server bundle $bundleVersion to ${appDir.absolutePath}")
    val staging = File(appDir.parentFile, "$bundleVersion.extracting")
    staging.deleteRecursively()
    staging.mkdirs()
    val canonical = staging.canonicalPath
    context.assets.open("$ASSET_DIR/server.zip").use { raw ->
      ZipInputStream(raw.buffered(1 shl 16)).use { zip ->
        var entry = zip.nextEntry
        while (entry != null) {
          val target = File(staging, entry.name)
          if (!target.canonicalPath.startsWith(canonical)) throw IllegalStateException("Bundle entry escapes the target: ${entry.name}")
          if (entry.isDirectory) {
            target.mkdirs()
          } else {
            target.parentFile?.mkdirs()
            FileOutputStream(target).use { out -> zip.copyTo(out, 1 shl 16) }
          }
          zip.closeEntry()
          entry = zip.nextEntry
        }
      }
    }
    appDir.deleteRecursively()
    if (!staging.renameTo(appDir)) throw IllegalStateException("Could not move the extracted bundle into place")
    File(appDir, COMPLETE_MARKER).writeText(bundleVersion)
    appDir.parentFile?.listFiles()?.filter { it.isDirectory && it != appDir }?.forEach { it.deleteRecursively() }
    log.note("bundle extracted")
    return appDir
  }

  companion object {
    const val ASSET_DIR = "embedded-server"
    private const val COMPLETE_MARKER = ".complete"
  }
}
