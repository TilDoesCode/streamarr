package expo.modules.offlinedownloads

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build

/** Android 14+: the user-initiated data transfer job that runs the download queue. */
class DownloadJobService : JobService() {
  private var host: JobHost? = null

  override fun onStartJob(params: JobParameters): Boolean {
    val created = JobHost(this, params, Notifications(this))
    host = created
    OfflineDownloads.engine(this).attachHost(created)
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    val current = host?.takeIf { it.params.jobId == params.jobId } ?: return false
    val stop = when {
      Build.VERSION.SDK_INT < 31 -> HostStop.SYSTEM
      params.stopReason == JobParameters.STOP_REASON_USER -> HostStop.USER
      params.stopReason == JobParameters.STOP_REASON_CANCELLED_BY_APP -> HostStop.CANCELLED_BY_APP
      else -> HostStop.SYSTEM
    }
    return OfflineDownloads.engine(this).detachHost(current, stop, systemReschedules = true)
  }
}
