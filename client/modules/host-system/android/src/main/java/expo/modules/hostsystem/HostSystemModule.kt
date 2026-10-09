package expo.modules.hostsystem

import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class HostSystemModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("HostSystem")

    Constant("theme") {
      appContext.reactContext?.let { HostSystem.theme(it) } ?: "default"
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

  // Debuggable builds only: `adb shell setprop debug.streamarr.theme streamybox|default`.
  private fun debugOverride(context: Context): String? {
    if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return null
    val value = runCatching {
      Class.forName("android.os.SystemProperties").getMethod("get", String::class.java)
        .invoke(null, OVERRIDE_PROPERTY) as String
    }.getOrNull()
    return value?.takeIf { it == "streamybox" || it == "default" }
  }
}
