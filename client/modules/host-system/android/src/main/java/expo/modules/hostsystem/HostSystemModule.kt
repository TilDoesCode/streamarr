package expo.modules.hostsystem

import android.app.ActivityManager
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.io.File
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HostSystemModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostSystem")

    Constant("theme") {
      appContext.reactContext?.let { HostSystem.theme(it) } ?: "default"
    }

    // Read once at startup: the JS performance mode classifies the device from it.
    Constant("device") {
      appContext.reactContext?.let { HostSystem.device(it) } ?: emptyMap<String, Any?>()
    }
  }
}

object HostSystem {
  const val FEATURE = "dev.streamybox.tv"
  const val SETTINGS_PACKAGE = "dev.streamybox.settings"
  private const val OVERRIDE_PROPERTY = "debug.streamarr.theme"

  fun theme(context: Context): String {
    debugOverride(context)?.let { return it }
    return if (isStreamybox(context.packageManager)) "streamybox" else "default"
  }

  // Fallback for images without the feature: Streamybox Settings shipped in the system image (not sideloaded).
  fun isStreamybox(pm: PackageManager): Boolean =
    pm.hasSystemFeature(FEATURE, 1) ||
      runCatching { pm.getApplicationInfo(SETTINGS_PACKAGE, 0).flags and ApplicationInfo.FLAG_SYSTEM != 0 }
        .getOrDefault(false)

  /** Hardware facts for the performance mode (weak TV boxes get the lite UI). */
  fun device(context: Context): Map<String, Any?> {
    val activity = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
    val memory = ActivityManager.MemoryInfo().also { activity?.getMemoryInfo(it) }
    val socModel = if (Build.VERSION.SDK_INT >= 31) Build.SOC_MODEL else null
    val animatorScale = runCatching {
      Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
    }.getOrDefault(1f)
    return mapOf(
      "socModel" to socModel,
      "hardware" to Build.HARDWARE,
      "boardPlatform" to systemProperty("ro.board.platform"),
      "totalMemoryMb" to (memory.totalMem / (1024 * 1024)).toInt(),
      "lowRam" to (activity?.isLowRamDevice ?: false),
      "cores" to Runtime.getRuntime().availableProcessors(),
      "maxCpuMhz" to maxCpuMhz(),
      "animatorScale" to animatorScale.toDouble(),
      "mediaPerformanceClass" to if (Build.VERSION.SDK_INT >= 31) Build.VERSION.MEDIA_PERFORMANCE_CLASS else 0,
    )
  }

  // Fastest core in MHz (0 when cpufreq is not readable).
  private fun maxCpuMhz(): Int =
    (File("/sys/devices/system/cpu").listFiles { file -> file.name.matches(Regex("cpu[0-9]+")) } ?: emptyArray())
      .mapNotNull { runCatching { File(it, "cpufreq/cpuinfo_max_freq").readText().trim().toLong() / 1000 }.getOrNull() }
      .maxOrNull()?.toInt() ?: 0

  private fun systemProperty(name: String): String? = runCatching {
    Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, name) as String
  }.getOrNull()?.takeIf { it.isNotEmpty() }

  // Debuggable builds only: `adb shell setprop debug.streamarr.theme streamybox|default`.
  private fun debugOverride(context: Context): String? {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
    return systemProperty(OVERRIDE_PROPERTY)?.takeIf { it == "streamybox" || it == "default" }
  }
}
