package expo.modules.offlinedownloads

import android.app.job.JobParameters
import android.app.job.JobService
import android.os.Build

/** Android 14+: the user-initiated data transfer job that runs the download queue. */
class DownloadJobService : JobService() {
  private val hosts = HostSlots<JobHost>()

  override fun onStartJob(params: JobParameters): Boolean {
    val created = JobHost(this, params, Notifications(this))
    hosts.started(created)
    OfflineDownloads.engine(this).attachHost(created)
    return true
  }

  override fun onStopJob(params: JobParameters): Boolean {
    // Each stop finds its own execution's host: a replaced job's late stop never reaches the replacement (N2-11).
    val stopped = hosts.stopped(params.extras.getLong(AndroidPlatform.EXTRA_HOST_TOKEN, 0)) ?: return false
    val stop = when {
      Build.VERSION.SDK_INT < 31 -> HostStop.SYSTEM
      params.stopReason == JobParameters.STOP_REASON_USER -> HostStop.USER
      params.stopReason == JobParameters.STOP_REASON_CANCELLED_BY_APP -> HostStop.CANCELLED_BY_APP
      else -> HostStop.SYSTEM
    }
    return OfflineDownloads.engine(this).detachHost(stopped, stop, systemReschedules = true)
  }

  fun released(host: JobHost) = hosts.released(host)
}
