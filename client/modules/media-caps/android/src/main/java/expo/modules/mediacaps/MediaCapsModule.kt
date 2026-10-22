package expo.modules.mediacaps

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.database.ContentObserver
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MediaCapsModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  private var watching: Context? = null

  private fun changed(reason: String) = sendEvent("onAudioOutputChange", mapOf("reason" to reason))

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = changed("devices")
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = changed("devices")
  }

  // HDMI hot plug and a new EDID (receiver switched on) arrive here, even without a device change.
  private val plugReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = changed("hdmi")
  }

  private val surroundObserver = object : ContentObserver(handler) {
    override fun onChange(selfChange: Boolean) = changed("surround")
  }

  override fun definition() = ModuleDefinition {
    Name("MediaCaps")

    Events("onAudioOutputChange")

    OnStartObserving {
      val context = appContext.reactContext ?: return@OnStartObserving
      if (watching != null) return@OnStartObserving
      watching = context
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).registerAudioDeviceCallback(deviceCallback, handler)
      val filter = IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG)
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(plugReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      else context.registerReceiver(plugReceiver, filter)
      context.contentResolver.registerContentObserver(Settings.Global.getUriFor("encoded_surround_output"), false, surroundObserver)
      context.contentResolver.registerContentObserver(Settings.Global.getUriFor("encoded_surround_output_enabled_formats"), false, surroundObserver)
    }

    OnStopObserving {
      val context = watching ?: return@OnStopObserving
      watching = null
      (context.getSystemService(Context.AUDIO_SERVICE) as AudioManager).unregisterAudioDeviceCallback(deviceCallback)
      runCatching { context.unregisterReceiver(plugReceiver) }
      context.contentResolver.unregisterContentObserver(surroundObserver)
    }

    AsyncFunction("getCapabilitiesAsync") {
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      AndroidCaps.report(context)
    }

    AsyncFunction("readCodecLogAsync") { sinceEpochMs: Double ->
      CodecLog.read(sinceEpochMs.toLong())
    }
  }
}
