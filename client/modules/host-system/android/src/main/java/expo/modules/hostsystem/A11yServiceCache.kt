package expo.modules.hostsystem

import android.accessibilityservice.AccessibilityServiceInfo
import android.os.Build
import android.view.accessibility.AccessibilityManager

/** Enabled a11y services, asked once until they change: RN TV's ReactViewManager asked system_server after every view update (plugins/with-a11y-service-cache). */
object A11yServiceCache {
  private var flags = -1
  private var services: List<AccessibilityServiceInfo>? = null
  private var listening = false

  @JvmStatic
  fun enabledList(manager: AccessibilityManager, feedbackTypes: Int): List<AccessibilityServiceInfo> {
    services?.takeIf { flags == feedbackTypes }?.let { return it }
    if (!listening) {
      listening = true
      manager.addAccessibilityStateChangeListener { clear() }
      manager.addTouchExplorationStateChangeListener { clear() }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        manager.addAccessibilityServicesStateChangeListener { clear() }
      }
    }
    return manager.getEnabledAccessibilityServiceList(feedbackTypes).also {
      services = it
      flags = feedbackTypes
    }
  }

  private fun clear() {
    services = null
  }
}
