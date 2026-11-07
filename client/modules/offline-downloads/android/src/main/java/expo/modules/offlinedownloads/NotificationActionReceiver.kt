package expo.modules.offlinedownloads

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlin.concurrent.thread

/** Pause / Cancel on the progress notification: every unfinished download (N1-13). */
class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    val engine = OfflineDownloads.engine(context)
    thread(name = "offline-download-action") {
      try {
        when (intent.action) {
          ACTION_PAUSE -> engine.pauseAll()
          ACTION_CANCEL -> engine.cancelAll()
        }
      } finally {
        pending.finish()
      }
    }
  }

  companion object {
    const val ACTION_PAUSE = "dev.streamarr.offline-downloads.PAUSE"
    const val ACTION_CANCEL = "dev.streamarr.offline-downloads.CANCEL"
  }
}
