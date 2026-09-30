package expo.modules.playerkeys

import android.app.Activity
import android.view.KeyEvent
import android.view.Window
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Remote and media keys for the player, taken before the Activity so no MediaSession or focus search sees them.
class PlayerKeysModule : Module() {
  @Volatile private var captured: Set<Int> = emptySet()

  override fun definition() = ModuleDefinition {
    Name("PlayerKeys")
    Events("onKey")

    // A JS reload creates a new module while the window keeps the old callback: route it to the live module.
    OnCreate { active = this@PlayerKeysModule }
    OnDestroy { if (active === this@PlayerKeysModule) active = null }

    Function("setCapture") { groups: List<String> ->
      captured = groups.flatMap { GROUPS[it].orEmpty() }.toSet()
      appContext.currentActivity?.let { activity -> activity.runOnUiThread { install(activity) } }
    }

    OnActivityEntersForeground {
      appContext.currentActivity?.let { install(it) }
    }
  }

  private fun install(activity: Activity) {
    val window = activity.window ?: return
    val current = window.callback ?: return
    if (current is KeyCallback) return
    window.callback = KeyCallback(current)
  }

  private fun handle(event: KeyEvent): Boolean {
    val name = NAMES[event.keyCode]
    if (name == null || event.keyCode !in captured) return false
    if (event.action == KeyEvent.ACTION_DOWN) {
      sendEvent("onKey", mapOf("key" to name, "repeat" to event.repeatCount, "time" to event.eventTime.toDouble()))
    }
    return true
  }

  private class KeyCallback(private val base: Window.Callback) : Window.Callback by base {
    override fun dispatchKeyEvent(event: KeyEvent): Boolean =
      active?.handle(event) == true || base.dispatchKeyEvent(event)
  }

  private companion object {
    @Volatile var active: PlayerKeysModule? = null

    val NAMES = mapOf(
      KeyEvent.KEYCODE_DPAD_CENTER to "select",
      KeyEvent.KEYCODE_ENTER to "select",
      KeyEvent.KEYCODE_DPAD_LEFT to "left",
      KeyEvent.KEYCODE_DPAD_RIGHT to "right",
      KeyEvent.KEYCODE_DPAD_UP to "up",
      KeyEvent.KEYCODE_DPAD_DOWN to "down",
      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to "playPause",
      KeyEvent.KEYCODE_MEDIA_PLAY to "play",
      KeyEvent.KEYCODE_MEDIA_PAUSE to "pause",
      KeyEvent.KEYCODE_MEDIA_STOP to "stop",
      KeyEvent.KEYCODE_MEDIA_REWIND to "rewind",
      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to "fastForward",
      KeyEvent.KEYCODE_MEDIA_NEXT to "next",
      KeyEvent.KEYCODE_MEDIA_PREVIOUS to "previous",
      KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD to "fastForward",
      KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD to "rewind",
      KeyEvent.KEYCODE_INFO to "info",
    )
    val DPAD = setOf(
      KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_DPAD_LEFT,
      KeyEvent.KEYCODE_DPAD_RIGHT, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_INFO,
    )
    val GROUPS = mapOf(
      "dpad" to DPAD,
      "media" to NAMES.keys - DPAD,
    )
  }
}
