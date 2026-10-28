package expo.modules.streamyboxplayer

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import dev.streamybox.player.render.IRenderCallback
import dev.streamybox.player.render.IRenderService
import org.json.JSONObject
import kotlin.math.abs

/** SurfaceView whose Surface the Streamybox player process renders mpv into; commands are props, events JSON. */
class StreamyboxPlayerView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext), SurfaceHolder.Callback {

  val onPlayerEvent by EventDispatcher()

  var source: String? = null
  var loadOptions: String = "{}"
  var loadNonce = 0
  var paused = false
  var muted = false
  var audioTrack: Int? = null
  var subtitleTrack = -1
  var seekMs = 0.0
  var seekNonce = 0

  private val main = Handler(Looper.getMainLooper())
  // Default z-order (below the window): Streamarr's React Native overlay draws over the picture, as with expo-video.
  private val surfaceView = SurfaceView(context).also {
    it.holder.addCallback(this)
    addView(it)
  }
  private var surface: Surface? = null
  private var surfaceWidth = 0
  private var surfaceHeight = 0

  private var service: IRenderService? = null
  private var binder: IBinder? = null
  private var session = 0
  private var callback: IRenderCallback.Stub? = null
  private var bound = false
  private var failed = false
  private var destroyed = false

  private var appliedLoad = 0
  private var appliedPaused: Boolean? = null
  private var appliedMuted: Boolean? = null
  private var appliedAudio: Int? = null
  private var appliedSubtitle: Int? = null
  private var appliedSeek = 0
  private var votedFrameRate = 0f

  private val bindTimeout = Runnable {
    if (service == null && bound) fail("streamybox_bind_timeout")
  }

  private val death = IBinder.DeathRecipient {
    main.post { onServiceGone("streamybox_service_died") }
  }

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
      main.removeCallbacks(bindTimeout)
      if (destroyed || service == null) return
      connect(service)
    }

    override fun onServiceDisconnected(name: ComponentName?) {
      onServiceGone("streamybox_service_died")
    }

    override fun onBindingDied(name: ComponentName?) {
      onServiceGone("streamybox_binding_died")
    }

    override fun onNullBinding(name: ComponentName?) {
      fail("streamybox_null_binding")
    }
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    val width = r - l
    val height = b - t
    surfaceView.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    surfaceView.layout(0, 0, width, height)
  }

  /** Applies what changed in the props; before the session exists everything waits for `connect`. */
  fun sync() {
    if (destroyed) return
    if (source != null && !bound && !failed) bind()
    val svc = service ?: return
    val id = session.takeIf { it > 0 } ?: return
    call {
      val url = source
      if (url != null && loadNonce != appliedLoad) {
        appliedLoad = loadNonce
        appliedSeek = seekNonce
        appliedMuted = muted
        appliedAudio = audioTrack
        appliedSubtitle = subtitleTrack
        appliedPaused = null
        svc.load(id, url, optionsJson())
      }
      if (appliedLoad == 0) return@call
      if (muted != appliedMuted) {
        appliedMuted = muted
        svc.setMuted(id, muted)
      }
      val audio = audioTrack
      if (audio != null && audio != appliedAudio) {
        appliedAudio = audio
        svc.setAudioTrack(id, audio)
      }
      if (subtitleTrack != appliedSubtitle) {
        appliedSubtitle = subtitleTrack
        svc.setSubtitleTrack(id, subtitleTrack)
      }
      if (seekNonce != appliedSeek) {
        appliedSeek = seekNonce
        svc.seek(id, seekMs.toLong())
      }
      if (paused != appliedPaused) {
        appliedPaused = paused
        if (paused) svc.pause(id) else svc.play(id)
      }
    }
  }

  /** Stops decoding but keeps the session (before the view unmounts). */
  fun stop() {
    val svc = service ?: return
    val id = session.takeIf { it > 0 } ?: return
    call { svc.stop(id) }
  }

  fun destroy() {
    if (destroyed) return
    destroyed = true
    main.removeCallbacks(bindTimeout)
    val svc = service
    val id = session
    if (svc != null && id > 0) call { svc.detach(id) }
    release()
    if (bound) runCatching { context.applicationContext.unbindService(connection) }
    bound = false
    surfaceView.holder.removeCallback(this)
  }

  private fun optionsJson(): String {
    val options = runCatching { JSONObject(loadOptions) }.getOrElse { JSONObject() }
    options.put("muted", muted)
    audioTrack?.let { options.put("audioTrack", it) }
    options.put("subtitleTrack", subtitleTrack)
    return options.toString()
  }

  private fun bind() {
    bound = true
    val intent = StreamyboxPlayerModule.renderIntent()
    val ok = runCatching {
      context.applicationContext.bindService(intent, connection, Context.BIND_AUTO_CREATE or Context.BIND_IMPORTANT)
    }.getOrDefault(false)
    if (!ok) {
      bound = false
      runCatching { context.applicationContext.unbindService(connection) }
      fail("streamybox_unavailable")
      return
    }
    main.postDelayed(bindTimeout, BIND_TIMEOUT_MS)
  }

  private fun connect(binder: IBinder) {
    val svc = IRenderService.Stub.asInterface(binder)
    try {
      val version = svc.apiVersion()
      if (version < 1) return fail("streamybox_api_version $version")
      binder.linkToDeath(death, 0)
      val events = object : IRenderCallback.Stub() {
        override fun onEvent(json: String?) {
          if (json == null) return
          main.post { if (callback === this) dispatch(json) }
        }
      }
      callback = events
      val id = svc.attach(events)
      if (id <= 0) return fail("streamybox_attach_refused")
      this.binder = binder
      service = svc
      session = id
      surface?.takeIf { it.isValid }?.let { svc.setSurface(id, it, surfaceWidth, surfaceHeight) }
    } catch (error: Exception) {
      Log.w(TAG, "attach failed", error)
      return fail("streamybox_attach_failed ${error.javaClass.simpleName}")
    }
    sync()
  }

  private fun dispatch(json: String) {
    runCatching {
      val event = JSONObject(json)
      if (event.optString("type") == "tracks") {
        val rate = event.optJSONObject("video")?.optDouble("frameRate", 0.0) ?: 0.0
        voteFrameRate(rate.toFloat())
      }
    }
    onPlayerEvent(mapOf("json" to json))
  }

  private fun onServiceGone(reason: String) {
    if (destroyed || service == null) return
    release()
    fail(reason)
  }

  private fun release() {
    runCatching { binder?.unlinkToDeath(death, 0) }
    binder = null
    service = null
    session = 0
    callback = null
  }

  /** One error event, no retry: the controller's recovery decides (a new load re-binds a fresh view). */
  private fun fail(reason: String) {
    if (failed || destroyed) return
    failed = true
    release()
    val event = JSONObject().put("type", "error").put("reason", reason).put("fatal", true)
    onPlayerEvent(mapOf("json" to event.toString()))
  }

  private inline fun call(block: () -> Unit) {
    try {
      block()
    } catch (error: Exception) {
      Log.w(TAG, "render service call failed", error)
      onServiceGone("streamybox_remote ${error.javaClass.simpleName}")
    }
  }

  private fun snapFrameRate(rate: Float): Float =
    floatArrayOf(23.976f, 24f, 25f, 29.97f, 30f, 50f, 59.94f, 60f).minBy { abs(it - rate) }
      .takeIf { abs(it - rate) < it * 0.01f } ?: rate

  // Same vote as Streamarr's expo-video patch: container rate, fixed source, only seamless switches.
  private fun voteFrameRate(rate: Float, force: Boolean = false) {
    val snapped = if (rate > 0f) snapFrameRate(rate) else 0f
    if (!force && snapped == votedFrameRate) return
    votedFrameRate = snapped
    val target = surface
    if (snapped <= 0f || target == null || !target.isValid || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
    runCatching {
      target.setFrameRate(snapped, Surface.FRAME_RATE_COMPATIBILITY_FIXED_SOURCE, Surface.CHANGE_FRAME_RATE_ONLY_IF_SEAMLESS)
    }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {}

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    surface = holder.surface
    surfaceWidth = width
    surfaceHeight = height
    val svc = service
    val id = session
    if (svc != null && id > 0) call { svc.setSurface(id, holder.surface, width, height) }
    voteFrameRate(votedFrameRate, force = true)
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    surface = null
    val svc = service
    val id = session
    if (svc != null && id > 0) call { svc.clearSurface(id) }
  }

  companion object {
    private const val TAG = "StreamyboxPlayer"
    private const val BIND_TIMEOUT_MS = 5_000L
  }
}
