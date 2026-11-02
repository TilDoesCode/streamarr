package expo.modules.embeddedserver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Brings the server back after a reboot or an app update when autostart is on. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    val controller = ServerController.get(context)
    if (!controller.bundle.present || !controller.settings.autostart) return
    controller.log.note("autostart after ${intent.action}")
    controller.start()
  }
}
