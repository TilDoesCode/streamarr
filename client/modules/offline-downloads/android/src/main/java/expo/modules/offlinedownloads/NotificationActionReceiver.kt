package expo.modules.offlinedownloads

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlin.concurrent.thread

/** Pause / Cancel on the progress notification: every unfinished download (N1-13); cancel waits for the workers (N2-06). */
class NotificationActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val pending = goAsync()
    val engine = OfflineDownloads.engine(context)
    thread(name = "offline-download-action") {
      try {
        when (intent.action) {
          ACTION_PAUSE -> engine.pauseAll()
          ACTION_CANCEL -> if (!engine.cancelAll()) {
            // Within the broadcast budget (goAsync); the tombstones and path claims stay until the workers ended.
            Log.w("OfflineDownloads", "notification cancel: a transfer is still ending (${DownloadEngine.CANCEL_PENDING})")
          }
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
