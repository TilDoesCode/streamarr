package expo.modules.offlinedownloads

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/** Android 13 and lower (or when the job cannot be scheduled): a dataSync foreground service runs the queue. */
class DownloadService : Service() {
  private var wakeLock: PowerManager.WakeLock? = null
  private var host: ServiceHost? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    running = true
    val engine = OfflineDownloads.engine(this)
    val notifications = Notifications(this)
    val notification = notifications.progress(engine.progressSnapshot())
    if (Build.VERSION.SDK_INT >= 29) startForeground(Notifications.NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    else startForeground(Notifications.NOTIFICATION_ID, notification)
    if (wakeLock == null) {
      wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "streamarr:downloads").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
    // A newer request (a sticky restart carries none) gets its own host; the engine releases the older one (N2-11).
    val token = intent?.getLongExtra(AndroidPlatform.EXTRA_HOST_TOKEN, 0) ?: 0
    val current = host
    if (current == null || token > current.token) {
      val created = ServiceHost(this, notifications, token)
      host = created
      engine.attachHost(created)
    }
    return START_STICKY
  }

  /** Android 15+: the dataSync time budget is used up; the queue waits until the app is opened again. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    detach()
    stopForeground(STOP_FOREGROUND_DETACH)
    stopSelf()
  }

  /** Only the current host ends the service: an older one the engine releases leaves its replacement running. */
  fun finish(token: Long) {
    if (host?.token != token) return
    host = null
    stopForeground(STOP_FOREGROUND_DETACH)
    stopSelf()
  }

  private fun detach() {
    host?.let { OfflineDownloads.engine(this).detachHost(it, HostStop.SYSTEM, systemReschedules = false) }
    host = null
  }

  override fun onDestroy() {
    running = false
    detach()
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    @Volatile var running = false
  }
}
