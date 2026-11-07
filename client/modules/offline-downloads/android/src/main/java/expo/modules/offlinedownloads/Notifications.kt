package expo.modules.offlinedownloads

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.Formatter
import androidx.core.app.NotificationCompat

/** One ongoing notification for the whole queue, plus a summary once it is empty. */
class Notifications(private val context: Context) {
  private val manager = context.getSystemService(NotificationManager::class.java)

  fun ensureChannel() {
    val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.offline_downloads_channel), NotificationManager.IMPORTANCE_LOW).apply {
      description = context.getString(R.string.offline_downloads_channel_description)
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  fun progress(snapshot: ProgressSnapshot): Notification {
    val tasks = snapshot.tasks
    val live = snapshot.live
    val bytesPerSecond = snapshot.bytesPerSecond
    ensureChannel()
    val running = tasks.filter { it.state == States.RUNNING }
    val title = when {
      running.size == 1 -> running[0].title ?: context.getString(R.string.offline_downloads_downloading)
      running.size > 1 -> context.resources.getQuantityString(R.plurals.offline_downloads_downloading_count, running.size, running.size)
      else -> context.resources.getQuantityString(R.plurals.offline_downloads_downloading_count, tasks.size, tasks.size)
    }
    val done = tasks.sumOf { live[it.id] ?: it.bytesWritten }
    val total = tasks.sumOf { it.totalBytes ?: it.expectedBytes ?: 0L }
    val known = tasks.all { (it.totalBytes ?: it.expectedBytes) != null }
    val text = when {
      running.isNotEmpty() && known -> context.getString(R.string.offline_downloads_progress, size(done), size(total)) +
        (if (bytesPerSecond > 0) " · ${size(bytesPerSecond)}/s" else "")
      running.isNotEmpty() -> size(done)
      tasks.any { it.state == States.WAITING_WIFI } -> context.getString(R.string.offline_downloads_waiting_wifi)
      tasks.any { it.state == States.WAITING_NETWORK } -> context.getString(R.string.offline_downloads_waiting_network)
      tasks.any { it.state == States.RETRYING } -> context.getString(R.string.offline_downloads_retrying)
      else -> context.getString(R.string.offline_downloads_queued)
    }
    val percent = if (known && total > 0) ((done * 100) / total).toInt().coerceIn(0, 100) else 0
    return builder()
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setContentTitle(title)
      .setContentText(text)
      .setProgress(100, percent, running.isNotEmpty() && !known)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, context.getString(R.string.offline_downloads_action_pause), action(NotificationActionReceiver.ACTION_PAUSE, 1))
      .addAction(0, context.getString(R.string.offline_downloads_action_cancel), action(NotificationActionReceiver.ACTION_CANCEL, 2))
      .build()
  }

  private fun action(name: String, code: Int): PendingIntent {
    val intent = Intent(context, NotificationActionReceiver::class.java).setAction(name)
    return PendingIntent.getBroadcast(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  fun show(notification: Notification) = runCatching { manager.notify(NOTIFICATION_ID, notification) }

  fun cancel() = manager.cancel(NOTIFICATION_ID)

  /** After the queue emptied: how many finished/failed while it ran (nothing to say → no notification). */
  fun summary(finished: Int, failed: Int) {
    manager.cancel(NOTIFICATION_ID)
    if (finished == 0 && failed == 0) return
    ensureChannel()
    val lines = listOfNotNull(
      finished.takeIf { it > 0 }?.let { context.resources.getQuantityString(R.plurals.offline_downloads_finished, it, it) },
      failed.takeIf { it > 0 }?.let { context.resources.getQuantityString(R.plurals.offline_downloads_failed, it, it) },
    )
    val notification = builder()
      .setSmallIcon(if (failed > 0) android.R.drawable.stat_notify_error else android.R.drawable.stat_sys_download_done)
      .setContentTitle(lines.first())
      .setContentText(lines.drop(1).firstOrNull())
      .setAutoCancel(true)
      .build()
    runCatching { manager.notify(SUMMARY_ID, notification) }
  }

  /** Opens the Downloads screen (streamarr://downloads), the app start where nothing handles the link. */
  private fun builder(): NotificationCompat.Builder {
    val link = Intent(Intent.ACTION_VIEW, Uri.parse(DOWNLOADS_LINK)).setPackage(context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val open = link.takeIf { it.resolveActivity(context.packageManager) != null } ?: context.packageManager.getLaunchIntentForPackage(context.packageName)
    val intent = open?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
    return NotificationCompat.Builder(context, CHANNEL_ID).setContentIntent(intent).setShowWhen(false)
  }

  private fun size(bytes: Long) = Formatter.formatShortFileSize(context, bytes)

  companion object {
    const val DOWNLOADS_LINK = "streamarr://downloads"
    const val CHANNEL_ID = "offline_downloads"
    const val NOTIFICATION_ID = 0x0d1a
    private const val SUMMARY_ID = 0x0d1b
  }
}
