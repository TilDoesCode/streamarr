package expo.modules.mediacaps

import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.os.Build
import android.provider.Settings
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioCapabilities

/** HDMI bitstream (passthrough) as ExoPlayer decides it, plus the platform facts behind that decision. */
@OptIn(UnstableApi::class)
internal object AudioPassthrough {
  /** Name, MIME type and the channel count a typical source of the format carries (TrueHD/DTS-HD 7.1, the rest 5.1). */
  private val FORMATS = listOf(
    Triple("ac3", MimeTypes.AUDIO_AC3, 6),
    Triple("eac3", MimeTypes.AUDIO_E_AC3, 6),
    Triple("eac3-joc", MimeTypes.AUDIO_E_AC3_JOC, 6),
    Triple("dts", MimeTypes.AUDIO_DTS, 6),
    Triple("dts-hd", MimeTypes.AUDIO_DTS_HD, 8),
    Triple("truehd", MimeTypes.AUDIO_TRUEHD, 8),
    Triple("ac4", MimeTypes.AUDIO_AC4, 6),
  )

  private val ENCODING_NAMES = mapOf(
    AudioFormat.ENCODING_AC3 to "ac3",
    AudioFormat.ENCODING_E_AC3 to "eac3",
    18 to "eac3-joc",
    17 to "ac4",
    AudioFormat.ENCODING_DTS to "dts",
    AudioFormat.ENCODING_DTS_HD to "dts-hd",
    14 to "truehd",
    13 to "iec61937",
  )

  private val EXPECTED_ENCODING = mapOf(
    "ac3" to AudioFormat.ENCODING_AC3,
    "eac3" to AudioFormat.ENCODING_E_AC3,
    "eac3-joc" to 18,
    "dts" to AudioFormat.ENCODING_DTS,
    "dts-hd" to AudioFormat.ENCODING_DTS_HD,
    "truehd" to 14,
    "ac4" to 17,
  )

  fun encodingName(encoding: Int): String? = ENCODING_NAMES[encoding]

  /** Media3's own AudioCapabilities (what DefaultAudioSink uses): a format counts only at its full channel count. */
  fun report(context: Context, devices: List<AudioDeviceInfo>): Map<String, Any?> {
    val capabilities = runCatching { AudioCapabilities.getCapabilities(context, AudioAttributes.DEFAULT, null) }.getOrNull()
    val passthrough = mutableListOf<String>()
    val channels = mutableMapOf<String, Int>()
    if (capabilities != null) {
      for ((name, mime, full) in FORMATS) {
        val best = listOf(8, 6, 2).firstOrNull { count -> accepts(capabilities, name, mime, count) } ?: continue
        channels[name] = best
        if (best >= full || name == "eac3-joc") passthrough += name
      }
    }
    return mapOf(
      "passthrough" to passthrough,
      "passthroughChannels" to channels,
      "hdmiEncodings" to devices.filter { it.type in HDMI_TYPES }.flatMap { it.encodings.toList() }.mapNotNull { encodingName(it) }.distinct(),
      "directProfiles" to directProfiles(context),
      "plugEncodings" to plugEncodings(context),
      "surroundMode" to surroundMode(context),
      "tvMode" to tvMode(context),
      "routedDevice" to routedDevice(context),
    )
  }

  private fun accepts(capabilities: AudioCapabilities, name: String, mime: String, count: Int): Boolean {
    val format = Format.Builder().setSampleMimeType(mime).setChannelCount(count).setSampleRate(48_000).build()
    val config = capabilities.getEncodingAndChannelConfigForPassthrough(format, AudioAttributes.DEFAULT) ?: return false
    // Media3 falls back to the DTS core / E-AC-3 base layer; only the format itself counts here.
    return config.first == EXPECTED_ENCODING[name]
  }

  private val HDMI_TYPES: Set<Int> = buildSet {
    add(AudioDeviceInfo.TYPE_HDMI)
    add(AudioDeviceInfo.TYPE_HDMI_ARC)
    if (Build.VERSION.SDK_INT >= 31) add(AudioDeviceInfo.TYPE_HDMI_EARC)
  }

  private fun platformAttributes(): android.media.AudioAttributes = AudioAttributes.DEFAULT.getPlatformAudioAttributes()

  /** API 33+: the routed output's direct profiles, with IEC 61937 wrapping that Media3 does not use. */
  private fun directProfiles(context: Context): List<Map<String, Any?>> {
    if (Build.VERSION.SDK_INT < 33) return emptyList()
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return runCatching { manager.getDirectProfilesForAttributes(platformAttributes()) }.getOrDefault(emptyList()).mapNotNull { profile ->
      val name = encodingName(profile.format) ?: return@mapNotNull null
      mapOf(
        "format" to name,
        "iec61937" to (profile.encapsulationType == android.media.AudioProfile.AUDIO_ENCAPSULATION_TYPE_IEC61937),
        "channels" to (profile.channelMasks.maxOfOrNull { Integer.bitCount(it) } ?: 0),
      )
    }
  }

  /** The sticky ACTION_HDMI_AUDIO_PLUG extras (Media3's source outside the TV ui mode). */
  private fun plugEncodings(context: Context): List<String>? {
    val intent: Intent = runCatching { context.registerReceiver(null, IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG)) }.getOrNull() ?: return null
    if (intent.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 0) != 1) return null
    return intent.getIntArrayExtra(AudioManager.EXTRA_ENCODINGS)?.toList()?.mapNotNull { encodingName(it) }?.distinct() ?: emptyList()
  }

  /** Settings.Global.ENCODED_SURROUND_OUTPUT (Streamybox Settings › Ton › Tonformat). */
  private fun surroundMode(context: Context): String = when (Settings.Global.getInt(context.contentResolver, "encoded_surround_output", 0)) {
    0 -> "auto"
    1 -> "never"
    2 -> "always"
    3 -> "manual"
    else -> "unknown"
  }

  /** Media3 only asks the direct-playback APIs in the television ui mode (Util.isTv). */
  private fun tvMode(context: Context): Boolean =
    (context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager)?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION

  private fun routedDevice(context: Context): Int? {
    if (Build.VERSION.SDK_INT < 33) return null
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    return runCatching { manager.getAudioDevicesForAttributes(platformAttributes()).firstOrNull()?.type }.getOrNull()
  }
}
