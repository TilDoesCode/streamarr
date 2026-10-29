package expo.modules.streamyboxplayer

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.ApplicationInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import dev.streamybox.player.render.IRenderService
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StreamyboxPlayerModule : Module() {
  private val context: Context?
    get() = appContext.reactContext?.applicationContext

  override fun definition() = ModuleDefinition {
    Name("StreamyboxPlayer")

    Function("isAvailable") { context?.let { installed(it) } ?: false }

    // Binds once and asks the contract version; the render service answers on its main thread.
    AsyncFunction("probeAsync") { promise: Promise ->
      val ctx = context
      if (ctx == null || !installed(ctx)) return@AsyncFunction promise.resolve(false)
      probe(ctx, promise)
    }

    View(StreamyboxPlayerView::class) {
      Events("onPlayerEvent")

      Prop("source") { view: StreamyboxPlayerView, value: String? -> view.source = value }
      Prop("loadOptions") { view: StreamyboxPlayerView, value: String? -> view.loadOptions = value ?: "{}" }
      Prop("loadNonce", 0) { view: StreamyboxPlayerView, value: Int -> view.loadNonce = value }
      Prop("paused", false) { view: StreamyboxPlayerView, value: Boolean -> view.paused = value }
      Prop("muted", false) { view: StreamyboxPlayerView, value: Boolean -> view.muted = value }
      Prop("audioTrack") { view: StreamyboxPlayerView, value: Int? -> view.audioTrack = value }
      Prop("subtitleTrack", -1) { view: StreamyboxPlayerView, value: Int -> view.subtitleTrack = value }
      Prop("seekMs", 0.0) { view: StreamyboxPlayerView, value: Double -> view.seekMs = value }
      Prop("seekNonce", 0) { view: StreamyboxPlayerView, value: Int -> view.seekNonce = value }

      OnViewDidUpdateProps { view: StreamyboxPlayerView -> view.sync() }
      OnViewDestroys { view: StreamyboxPlayerView -> view.destroy() }

      AsyncFunction("stop") { view: StreamyboxPlayerView -> view.stop() }
    }
  }

  private fun probe(ctx: Context, promise: Promise) {
    val main = Handler(Looper.getMainLooper())
    var settled = false
    lateinit var connection: ServiceConnection
    fun settle(ok: Boolean) {
      if (settled) return
      settled = true
      runCatching { ctx.unbindService(connection) }
      promise.resolve(ok)
    }
    connection = object : ServiceConnection {
      override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
        val version = runCatching { IRenderService.Stub.asInterface(service).apiVersion() }.getOrDefault(0)
        settle(version >= 1)
      }

      override fun onServiceDisconnected(name: ComponentName?) = settle(false)

      override fun onNullBinding(name: ComponentName?) = settle(false)
    }
    val ok = runCatching { ctx.bindService(renderIntent(), connection, Context.BIND_AUTO_CREATE) }.getOrDefault(false)
    if (!ok) return settle(false)
    main.postDelayed({ settle(false) }, PROBE_TIMEOUT_MS)
  }

  companion object {
    private const val PLAYER_PACKAGE = "dev.streamybox.player"
    private const val RENDER_ACTION = "dev.streamybox.player.RENDER"
    private const val DOLBY_VISION_FEATURE = "dev.streamybox.dolby_vision"
    private const val PROBE_TIMEOUT_MS = 3_000L
    private const val OVERRIDE_PROPERTY = "debug.streamarr.streamybox"

    fun renderIntent(): Intent = Intent(RENDER_ACTION).setPackage(PLAYER_PACKAGE)

    /** The Streamybox DV feature and a resolvable render service (contract: Availability). */
    fun installed(ctx: Context): Boolean {
      val pm = ctx.packageManager
      if (!pm.hasSystemFeature(DOLBY_VISION_FEATURE) && !featureOverride(ctx)) return false
      return runCatching { pm.queryIntentServices(renderIntent(), 0).isNotEmpty() }.getOrDefault(false)
    }

    // Debuggable builds only (emulators lack the feature): `adb shell setprop debug.streamarr.streamybox 1`.
    private fun featureOverride(ctx: Context): Boolean {
      if (ctx.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE == 0) return false
      return runCatching {
        Class.forName("android.os.SystemProperties").getMethod("get", String::class.java).invoke(null, OVERRIDE_PROPERTY) as String
      }.getOrNull() == "1"
    }
  }
}
