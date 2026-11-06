package expo.modules.offlinedownloads

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build

/** Android 14+: the user-initiated data transfer job that runs the download queue. */
class DownloadJobService : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    DownloadEngine.get(this).attachJob(this, params)
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    val reason = if (Build.VERSION.SDK_INT >= 31) params.stopReason else JobParameters.STOP_REASON_UNDEFINED
    return DownloadEngine.get(this).detachJob(params, reason)
  }
}
