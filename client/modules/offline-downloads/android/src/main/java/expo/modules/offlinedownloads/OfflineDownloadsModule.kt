package expo.modules.offlinedownloads

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class OfflineDownloadsModule : Module() {
  private val context: Context get() = appContext.reactContext?.applicationContext ?: throw CodedException("not_supported: no context")
  private val engine: DownloadEngine get() = DownloadEngine.get(context)

  private val listener = object : DownloadEngine.Listener {
    override fun onProgress(event: Map<String, Any?>) = sendEvent("onProgress", event)
    override fun onState(event: Map<String, Any?>) = sendEvent("onState", event)
  }

  /** Engine errors keep their code as the message prefix ("not_found: …"), which the JS wrapper maps. */
  private inline fun <T> guarded(block: () -> T): T = try {
    block()
  } catch (error: DownloadException) {
    throw CodedException(error.code, error.message, null)
  }

  override fun definition() = ModuleDefinition {
    Name("OfflineDownloads")

    Events("onProgress", "onState")

    Constant("rootUri") { engine.volumes.internal().uri }

    OnCreate { engine.addListener(listener) }

    OnDestroy { engine.removeListener(listener) }

    // A foreground app may start the service / schedule the job that the background could not.
    OnActivityEntersForeground { engine.onForeground() }

    AsyncFunction("storage") { volumeId: String? ->
      guarded {
        val volume = engine.volumes.get(volumeId)
        mapOf("freeBytes" to volume.freeBytes().toDouble(), "totalBytes" to volume.totalBytes().toDouble())
      }
    }

    AsyncFunction("volumes") {
      engine.volumes.all().map {
        mapOf("id" to it.id, "uri" to it.uri, "removable" to it.removable, "freeBytes" to it.freeBytes().toDouble(), "totalBytes" to it.totalBytes().toDouble())
      }
    }

    AsyncFunction("start") { spec: Map<String, Any?> -> guarded { engine.start(spec) } }
    AsyncFunction("pause") { id: String -> guarded { engine.pause(id) } }
    AsyncFunction("resume") { id: String, url: String?, headers: Map<String, String>? -> guarded { engine.resume(id, url, headers) } }
    AsyncFunction("cancel") { id: String -> guarded { engine.cancel(id) } }
    AsyncFunction("remove") { id: String -> guarded { engine.remove(id) } }
    AsyncFunction("list") { engine.list() }
    AsyncFunction("get") { id: String -> engine.get(id) }

    AsyncFunction("getSettings") {
      val settings = engine.settings()
      mapOf("wifiOnly" to settings.wifiOnly, "maxConcurrent" to settings.maxConcurrent)
    }
    AsyncFunction("setWifiOnly") { wifiOnly: Boolean -> engine.setWifiOnly(wifiOnly) }
    AsyncFunction("setMaxConcurrent") { maxConcurrent: Int -> engine.setMaxConcurrent(maxConcurrent) }

    AsyncFunction("getNotificationPermission") { notificationPermission() }

    AsyncFunction("requestNotificationPermission") { promise: Promise ->
      val permissions = appContext.permissions
      if (Build.VERSION.SDK_INT < 33 || permissions == null) {
        promise.resolve(notificationPermission())
        return@AsyncFunction
      }
      permissions.askForPermissions({ result ->
        promise.resolve(result[Manifest.permission.POST_NOTIFICATIONS]?.status?.status ?: notificationPermission())
      }, Manifest.permission.POST_NOTIFICATIONS)
    }

    Function("uriFor") { relativePath: String, volumeId: String? -> guarded { android.net.Uri.fromFile(engine.volumes.resolve(relativePath, volumeId)).toString() } }

    AsyncFunction("contentUriFor") { relativePath: String, volumeId: String?, grantPackage: String? ->
      guarded {
        if (volumeId != null && volumeId != Volumes.INTERNAL) throw DownloadException("invalid_argument", "content URIs exist for the internal volume only")
        val file = engine.volumes.resolve(relativePath, volumeId)
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.offline-downloads", file)
        if (grantPackage != null) context.grantUriPermission(grantPackage, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        uri.toString()
      }
    }

    AsyncFunction("exists") Coroutine { relativePath: String, volumeId: String? ->
      withContext(Dispatchers.IO) { guarded { engine.volumes.resolve(relativePath, volumeId).exists() } }
    }

    AsyncFunction("fileSize") Coroutine { relativePath: String, volumeId: String? ->
      withContext(Dispatchers.IO) { guarded { engine.volumes.resolve(relativePath, volumeId).takeIf { it.isFile }?.length()?.toDouble() } }
    }

    AsyncFunction("deletePath") Coroutine { relativePath: String, volumeId: String? ->
      withContext(Dispatchers.IO) { guarded { Files.delete(engine.volumes.resolve(relativePath, volumeId)) } }
    }

    AsyncFunction("move") Coroutine { from: String, to: String, volumeId: String? ->
      withContext(Dispatchers.IO) { guarded { Files.move(engine.volumes.resolve(from, volumeId), engine.volumes.resolve(to, volumeId)) } }
    }

    AsyncFunction("sha256") Coroutine { relativePath: String, volumeId: String? ->
      withContext(Dispatchers.IO) { guarded { Files.sha256(engine.volumes.resolve(relativePath, volumeId)) } }
    }
  }

  private fun notificationPermission(): String = when {
    Build.VERSION.SDK_INT >= 33 &&
      ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED ->
      if (appContext.currentActivity?.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS) == true) "denied" else "undetermined"
    NotificationManagerCompat.from(context).areNotificationsEnabled() -> "granted"
    else -> "denied"
  }
}
