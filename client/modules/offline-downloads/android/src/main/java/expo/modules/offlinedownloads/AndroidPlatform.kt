package expo.modules.offlinedownloads

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Environment
import android.os.PersistableBundle
import android.os.SystemClock
import android.os.storage.StorageManager
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import java.io.File
import java.util.UUID

/** The engine singleton of this process. */
object OfflineDownloads {
  @Volatile private var instance: DownloadEngine? = null

  fun engine(context: Context): DownloadEngine =
    instance ?: synchronized(this) {
      instance ?: DownloadEngine(AndroidPlatform(context.applicationContext)).also {
        instance = it
        it.load()
      }
    }
}

class AndroidPlatform(private val context: Context) : EnginePlatform {
  private val notifications = Notifications(context)
  private var network: NetworkWatcher? = null
  private var volumeReceiver: BroadcastReceiver? = null

  override val stateDir: File = File(context.filesDir, "offline-downloads")

  override fun now() = System.currentTimeMillis()

  override fun elapsed() = SystemClock.elapsedRealtime()

  override fun bootId(): String? =
    runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT).toString() }.getOrNull()

  override fun log(message: String) {
    Log.i(TAG, message)
  }

  override fun network(): Net = (network ?: NetworkWatcher(context) {}).current()

  override fun observe(active: Boolean, onChange: () -> Unit) {
    if (!active) {
      network?.stop()
      network = null
      volumeReceiver?.let { runCatching { context.unregisterReceiver(it) } }
      volumeReceiver = null
      return
    }
    if (network == null) network = NetworkWatcher(context, onChange).also { it.start() }
    if (volumeReceiver == null) {
      val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = onChange()
      }
      val filter = IntentFilter().apply {
        listOf(Intent.ACTION_MEDIA_MOUNTED, Intent.ACTION_MEDIA_UNMOUNTED, Intent.ACTION_MEDIA_EJECT, Intent.ACTION_MEDIA_REMOVED, Intent.ACTION_MEDIA_BAD_REMOVAL)
          .forEach { addAction(it) }
        addDataScheme("file")
      }
      // MEDIA_* are protected system broadcasts.
      ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
      volumeReceiver = receiver
    }
  }

  /** Internal storage plus app-specific dirs on mounted SD/USB volumes, keyed by the volume UUID (N1-14). */
  override fun volumes(): List<Volume> {
    val internal = Volume(Volumes.INTERNAL, File(context.filesDir, Volumes.ROOT), removable = false)
    val storage = context.getSystemService(StorageManager::class.java)
    val external = context.getExternalFilesDirs(null).filterNotNull().mapNotNull { dir ->
      if (runCatching { Environment.isExternalStorageEmulated(dir) }.getOrDefault(true)) return@mapNotNull null
      if (Environment.getExternalStorageState(dir) != Environment.MEDIA_MOUNTED) return@mapNotNull null
      val volume = runCatching { storage.getStorageVolume(dir) }.getOrNull() ?: return@mapNotNull null
      val uuid = volume.uuid ?: return@mapNotNull null
      Volume("volume-$uuid", File(dir, Volumes.ROOT), volume.isRemovable)
    }
    return listOf(internal) + external.distinctBy { it.id }
  }

  override fun requestHost(replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Boolean {
    if (Build.VERSION.SDK_INT >= 34 && scheduleJob(replace, wifiOnly, estimatedBytes)) return true
    return try {
      ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
      true
    } catch (error: Exception) {
      // Android 12+ refuses a foreground service from the background; the next foreground retries.
      Log.w(TAG, "cannot start the download service: ${error.message}")
      false
    }
  }

  /** A pending or running job (also one JobScheduler restarted after the process died) is kept unless `replace`. */
  private fun scheduleJob(replace: Boolean, wifiOnly: Boolean, estimatedBytes: Long): Boolean {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (!replace && scheduler.getPendingJob(JOB_ID) != null) return true
    val request = NetworkRequest.Builder()
      .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_RESTRICTED)
      .apply { if (wifiOnly) addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED) }
      .build()
    val info = JobInfo.Builder(JOB_ID, ComponentName(context, DownloadJobService::class.java))
      .setUserInitiated(true)
      .setRequiredNetwork(request)
      .setEstimatedNetworkBytes(if (estimatedBytes > 0) estimatedBytes else JobInfo.NETWORK_BYTES_UNKNOWN.toLong(), 0)
      // Every schedule replaces the job of the same id: the token tells its stop apart from the replacement's.
      .setExtras(PersistableBundle().apply { putString(EXTRA_EXECUTION, UUID.randomUUID().toString()) })
      .build()
    return try {
      scheduler.schedule(info) == JobScheduler.RESULT_SUCCESS
    } catch (error: Exception) {
      Log.w(TAG, "cannot schedule the user-initiated job: ${error.message}")
      false
    }
  }

  override fun cancelHostRequest() {
    if (Build.VERSION.SDK_INT >= 34) runCatching { context.getSystemService(JobScheduler::class.java).cancel(JOB_ID) }
  }

  override fun summary(finished: Int, failed: Int) = notifications.summary(finished, failed)

  override fun clearNotification() = notifications.cancel()

  override fun visible(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  /** Task Manager "Stop" and force stop show up as user-requested exits (N1-13). */
  override fun lastExit(): ExitInfo? {
    if (Build.VERSION.SDK_INT < 30) return null
    val manager = context.getSystemService(ActivityManager::class.java)
    val info = runCatching { manager.getHistoricalProcessExitReasons(context.packageName, 0, 1) }.getOrNull()?.firstOrNull() ?: return null
    val userStop = info.reason == ApplicationExitInfo.REASON_USER_REQUESTED || info.reason == REASON_USER_STOPPED
    return ExitInfo(info.timestamp, userStop, "reason ${info.reason}, ${info.description}")
  }

  companion object {
    const val TAG = "OfflineDownloads"
    const val JOB_ID = 0x0d1a
    const val EXTRA_EXECUTION = "execution"
    /** ApplicationExitInfo.REASON_USER_STOPPED (API 35). */
    private const val REASON_USER_STOPPED = 11
  }
}

class JobHost(private val service: JobService, val params: JobParameters, private val notifications: Notifications) : TransferHost {
  private var shown = false

  override fun update(progress: ProgressSnapshot) {
    if (Build.VERSION.SDK_INT < 34) return
    val notification = notifications.progress(progress)
    if (!shown) {
      service.setNotification(params, Notifications.NOTIFICATION_ID, notification, JobService.JOB_END_NOTIFICATION_POLICY_DETACH)
      shown = true
    } else {
      notifications.show(notification)
    }
  }

  override fun finish() = service.jobFinished(params, false)
}

class ServiceHost(private val service: DownloadService, private val notifications: Notifications) : TransferHost {
  override fun update(progress: ProgressSnapshot) {
    notifications.show(notifications.progress(progress))
  }

  override fun finish() = service.finish()
}
