package expo.modules.mediacaps

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

// Why this app's earlier processes ended (Android 11+): a crash during playback leaves its reason here, no adb needed.
internal object ExitInfo {
  private const val TRACE_CHARS = 4000

  fun recent(context: Context, max: Int): List<Map<String, Any?>> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
    return runCatching { manager.getHistoricalProcessExitReasons(context.packageName, 0, max) }
      .getOrDefault(emptyList())
      .map { info ->
        mapOf(
          "time" to info.timestamp.toDouble(),
          "reason" to reasonName(info.reason),
          "status" to info.status,
          "importance" to info.importance,
          "description" to info.description,
          "pssKb" to info.pss.toDouble(),
          "rssKb" to info.rss.toDouble(),
          "trace" to trace(info)
        )
      }
  }

  // ANR traces are text; native tombstones are protobuf and stay out.
  private fun trace(info: ApplicationExitInfo): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || info.reason != ApplicationExitInfo.REASON_ANR) return null
    return runCatching {
      info.traceInputStream?.bufferedReader()?.use { reader ->
        val buffer = CharArray(TRACE_CHARS)
        val read = reader.read(buffer)
        if (read > 0) String(buffer, 0, read) else null
      }
    }.getOrNull()
  }

  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_ANR -> "anr"
    ApplicationExitInfo.REASON_CRASH -> "crash"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "crashNative"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "dependencyDied"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessiveResourceUsage"
    ApplicationExitInfo.REASON_EXIT_SELF -> "exitSelf"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "initializationFailure"
    ApplicationExitInfo.REASON_LOW_MEMORY -> "lowMemory"
    ApplicationExitInfo.REASON_OTHER -> "other"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permissionChange"
    ApplicationExitInfo.REASON_SIGNALED -> "signaled"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "userRequested"
    ApplicationExitInfo.REASON_USER_STOPPED -> "userStopped"
    else -> "unknown"
  }
}
