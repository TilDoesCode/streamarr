package expo.modules.streamyboxplayer

import kotlin.math.abs

/** The video layer's frame-rate vote: the player's container rate, else the server's probe, snapped; pure for JVM tests. */
class FrameRateVote {
  private var playerRate = 0f
  private var serverRate = 0f
  /** What the current surface was last told; 0 = nothing (a fresh surface has no vote). */
  private var told = 0f

  /** The rate to vote now; 0 = no preference. */
  val rate: Float get() = if (playerRate > 0f) playerRate else serverRate

  /** Where [rate] comes from, for the log. */
  val source: String get() = when {
    playerRate > 0f -> "player"
    serverRate > 0f -> "server"
    else -> "none"
  }

  /** A new source: only its own rates count, the previous file's must not stay on the layer. */
  fun load(serverFrameRate: Double) {
    playerRate = 0f
    serverRate = snap(serverFrameRate)
  }

  /** A `tracks` event; one without a frame rate keeps what this load already knows. */
  fun tracks(frameRate: Double) {
    snap(frameRate).takeIf { it > 0f }?.let { playerRate = it }
  }

  /** Playback is over (stop, end, fatal error): no preference until the next load. */
  fun end() {
    playerRate = 0f
    serverRate = 0f
  }

  /** A new or resized surface, or the display changed: the next [pending] sends the rate again. */
  fun forget() {
    told = 0f
  }

  /** The rate the surface still has to be told (0 clears its vote), or null when it already has it. */
  fun pending(): Float? = rate.takeIf { it != told }

  fun sent(rate: Float) {
    told = rate
  }

  companion object {
    /** Same table and 1 % window as Streamarr's expo-video patch; never rounds 23.976 to 24. */
    private val RATES = floatArrayOf(23.976f, 24f, 25f, 29.97f, 30f, 50f, 59.94f, 60f)

    fun snap(rate: Double): Float {
      if (!rate.isFinite() || rate <= 0.0) return 0f
      val value = rate.toFloat()
      return RATES.minBy { abs(it - value) }.takeIf { abs(it - value) < it * 0.01f } ?: value
    }
  }
}
