package expo.modules.embeddedserver

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat

/** Keeps the app process (and with it the Core Server child) alive while the server runs. */
class EmbeddedServerService : Service() {
  private lateinit var controller: ServerController
  private var wakeLock: PowerManager.WakeLock? = null
  private val listener: (ServerStatus) -> Unit = { status ->
    notificationManager().notify(NOTIFICATION_ID, notification(status))
    if (status.state == ServerState.Running) acquireWakeLock() else if (status.state == ServerState.Stopped || status.state == ServerState.Failed) releaseWakeLock()
  }

  override fun onCreate() {
    super.onCreate()
    controller = ServerController.get(this)
    ensureChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val status = controller.status()
    val notification = notification(status)
    if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(NOTIFICATION_ID, notification)
    if (intent?.action == ACTION_STOP) {
      controller.stop()
      return START_NOT_STICKY
    }
    controller.addListener(listener)
    controller.onServiceStarted(this)
    return START_STICKY
  }

  override fun onDestroy() {
    controller.removeListener(listener)
    controller.onServiceDestroyed(this)
    releaseWakeLock()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "streamarr:server").apply { acquire() }
  }

  private fun releaseWakeLock() {
    wakeLock?.takeIf { it.isHeld }?.release()
    wakeLock = null
  }

  private fun notificationManager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun ensureChannel() {
    val channel = NotificationChannel(CHANNEL_ID, "Streamarr Server", NotificationManager.IMPORTANCE_LOW).apply {
      description = "State of the media server running on this device"
      setShowBadge(false)
    }
    notificationManager().createNotificationChannel(channel)
  }

  private fun notification(status: ServerStatus): Notification {
    val text = when (status.state) {
      ServerState.Running -> (status.addresses.firstOrNull { it.kind != "loopback" } ?: status.addresses.firstOrNull())?.url ?: "Running"
      ServerState.Starting -> "Starting…"
      ServerState.Stopping -> "Stopping…"
      ServerState.Failed -> status.lastError ?: "Failed"
      ServerState.Stopped -> "Stopped"
    }
    val open = Intent(Intent.ACTION_VIEW, Uri.parse(ServerStateProvider.LOCAL_SERVER_LINK)).setPackage(packageName)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(applicationInfo.icon)
      .setContentTitle("Streamarr Server · ${status.state.wire}")
      .setContentText(text)
      .setContentIntent(PendingIntent.getActivity(this, 0, open, flags))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .build()
  }

  companion object {
    const val ACTION_START = "dev.streamarr.app.server.START"
    const val ACTION_STOP = "dev.streamarr.app.server.STOP"
    private const val CHANNEL_ID = "streamarr_server"
    private const val NOTIFICATION_ID = 0x5e71
  }
}
