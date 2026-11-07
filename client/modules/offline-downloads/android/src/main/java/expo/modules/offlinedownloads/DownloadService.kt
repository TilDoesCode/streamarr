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
    if (host == null) host = ServiceHost(this, notifications).also { engine.attachHost(it) }
    return START_STICKY
  }

  /** Android 15+: the dataSync time budget is used up; the queue waits until the app is opened again. */
  override fun onTimeout(startId: Int, fgsType: Int) {
    detach()
    finish()
  }

  fun finish() {
    stopForeground(STOP_FOREGROUND_DETACH)
    stopSelf()
  }

  private fun detach() {
    host?.let { OfflineDownloads.engine(this).detachHost(it, HostStop.SYSTEM, systemReschedules = false) }
    host = null
  }

  override fun onDestroy() {
    detach()
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
