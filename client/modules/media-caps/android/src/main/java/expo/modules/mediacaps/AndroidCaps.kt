package expo.modules.mediacaps

import android.app.UiModeManager
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.hardware.display.DisplayManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodecInfo
import android.media.MediaCodecInfo.CodecProfileLevel as P
import android.media.MediaCodecList
import android.os.Build
import android.view.Display
import java.util.Locale

internal object AndroidCaps {
  private val VIDEO_TYPES = mapOf(
    "video/avc" to "h264",
    "video/hevc" to "hevc",
    "video/av01" to "av1",
    "video/x-vnd.on2.vp9" to "vp9",
    "video/x-vnd.on2.vp8" to "vp8",
    "video/mpeg2" to "mpeg2video",
    "video/mp4v-es" to "mpeg4",
    "video/dolby-vision" to "dolbyvision",
    "video/wvc1" to "vc1",
  )

  private val AUDIO_TYPES = mapOf(
    "audio/mp4a-latm" to "aac",
    "audio/mpeg" to "mp3",
    "audio/mpeg-l2" to "mp2",
    "audio/opus" to "opus",
    "audio/vorbis" to "vorbis",
    "audio/flac" to "flac",
    "audio/ac3" to "ac3",
    "audio/eac3" to "eac3",
    "audio/eac3-joc" to "eac3",
    "audio/ac4" to "ac4",
    "audio/true-hd" to "truehd",
    "audio/vnd.dts" to "dts",
    "audio/vnd.dts.hd" to "dts",
    "audio/raw" to "pcm",
  )

  // AudioFormat encodings ExoPlayer can bitstream, with the canonical codec name.
  private val PASSTHROUGH = listOf(
    AudioFormat.ENCODING_AC3 to "ac3",
    AudioFormat.ENCODING_E_AC3 to "eac3",
    18 to "eac3-joc",
    17 to "ac4",
    AudioFormat.ENCODING_DTS to "dts",
    AudioFormat.ENCODING_DTS_HD to "dts-hd",
    14 to "truehd",
  )

  fun report(context: Context): Map<String, Any?> = mapOf(
    "platform" to if (isTv(context)) "androidtv" else "android",
    "device" to device(context),
    "videoDecoders" to decoders(video = true),
    "audioDecoders" to decoders(video = false),
    "display" to display(context),
    "audioOutput" to audioOutput(context),
  )

  private fun isTv(context: Context): Boolean {
    val uiMode = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
    return uiMode?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
  }

  private fun device(context: Context): Map<String, Any?> = mapOf(
    "manufacturer" to Build.MANUFACTURER,
    "model" to Build.MODEL,
    "osVersion" to Build.VERSION.RELEASE,
    "sdkInt" to Build.VERSION.SDK_INT,
    "hardware" to Build.HARDWARE,
    "isTV" to isTv(context),
    "isEmulator" to (Build.HARDWARE in setOf("ranchu", "goldfish") || Build.FINGERPRINT.contains("generic")),
    "abis" to Build.SUPPORTED_ABIS.toList(),
  )

  private fun decoders(video: Boolean): List<Map<String, Any?>> {
    val out = mutableListOf<Map<String, Any?>>()
    for (info in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
      if (info.isEncoder) continue
      for (type in info.supportedTypes) {
        val mime = type.lowercase()
        val codec = (if (video) VIDEO_TYPES[mime] else AUDIO_TYPES[mime]) ?: continue
        val caps = try {
          info.getCapabilitiesForType(type)
        } catch (_: IllegalArgumentException) {
          continue
        }
        out.add(if (video) videoDecoder(info, mime, codec, caps) else audioDecoder(info, mime, codec, caps))
      }
    }
    return out
  }

  private fun kind(info: MediaCodecInfo): Map<String, Any?> {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      return mapOf(
        "hardware" to info.isHardwareAccelerated,
        "softwareOnly" to info.isSoftwareOnly,
        "vendor" to info.isVendor,
        "alias" to info.isAlias,
        "canonicalName" to info.canonicalName,
      )
    }
    val name = info.name.lowercase()
    val software = name.startsWith("omx.google.") || name.startsWith("c2.android.") || !name.startsWith("omx.") && !name.startsWith("c2.")
    return mapOf("hardware" to !software, "softwareOnly" to software, "vendor" to !software, "alias" to false, "canonicalName" to info.name)
  }

  private val SIZES = listOf(7680 to 4320, 3840 to 2160, 2560 to 1440, 1920 to 1080, 1280 to 720, 720 to 576, 640 to 480)

  private fun videoDecoder(info: MediaCodecInfo, mime: String, codec: String, caps: MediaCodecInfo.CodecCapabilities): Map<String, Any?> {
    val video = caps.videoCapabilities
    val best = SIZES.firstOrNull { (w, h) -> video != null && video.isSizeSupported(w, h) }
    val maxFps = best?.let { (w, h) -> runCatching { video!!.getSupportedFrameRatesFor(w, h).upper }.getOrNull() }
    val profiles = caps.profileLevels.map { it.profile }.distinct()
    return kind(info) + mapOf(
      "name" to info.name,
      "mimeType" to mime,
      "codec" to codec,
      "maxWidth" to (best?.first ?: video?.supportedWidths?.upper),
      "maxHeight" to (best?.second ?: video?.supportedHeights?.upper),
      "maxFrameRateAtMaxSize" to maxFps,
      "maxBitDepth" to bitDepth(codec, profiles),
      "hdrFormats" to decoderHdr(codec, profiles),
      "profiles" to profiles.mapNotNull { profileName(codec, it) }.distinct(),
      "secure" to caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_SecurePlayback),
      "tunneled" to caps.isFeatureSupported(MediaCodecInfo.CodecCapabilities.FEATURE_TunneledPlayback),
    )
  }

  private fun audioDecoder(info: MediaCodecInfo, mime: String, codec: String, caps: MediaCodecInfo.CodecCapabilities): Map<String, Any?> =
    kind(info) + mapOf(
      "name" to info.name,
      "mimeType" to mime,
      "codec" to codec,
      "maxChannels" to (caps.audioCapabilities?.maxInputChannelCount ?: 2),
    )

  private fun bitDepth(codec: String, profiles: List<Int>): Int = when (codec) {
    "hevc" -> if (profiles.any { it == P.HEVCProfileMain10 || it == P.HEVCProfileMain10HDR10 || it == P.HEVCProfileMain10HDR10Plus }) 10 else 8
    "vp9" -> if (profiles.any { it == P.VP9Profile2 || it == P.VP9Profile3 || it == P.VP9Profile2HDR || it == P.VP9Profile3HDR }) 10 else 8
    "av1" -> if (profiles.any { it == P.AV1ProfileMain10 || it == P.AV1ProfileMain10HDR10 || it == P.AV1ProfileMain10HDR10Plus }) 10 else 8
    "h264" -> if (profiles.any { it == P.AVCProfileHigh10 }) 10 else 8
    "dolbyvision" -> 10
    else -> 8
  }

  private fun decoderHdr(codec: String, profiles: List<Int>): List<String> {
    val out = mutableListOf<String>()
    when (codec) {
      "hevc" -> {
        if (P.HEVCProfileMain10HDR10 in profiles) out += "hdr10"
        if (P.HEVCProfileMain10HDR10Plus in profiles) out += "hdr10plus"
        if (P.HEVCProfileMain10 in profiles) out += "hlg"
      }
      "vp9" -> {
        if (P.VP9Profile2HDR in profiles || P.VP9Profile3HDR in profiles) out += "hdr10"
        if (P.VP9Profile2HDR10Plus in profiles) out += "hdr10plus"
        if (P.VP9Profile2 in profiles) out += "hlg"
      }
      "av1" -> {
        if (P.AV1ProfileMain10HDR10 in profiles) out += "hdr10"
        if (P.AV1ProfileMain10HDR10Plus in profiles) out += "hdr10plus"
        if (P.AV1ProfileMain10 in profiles) out += "hlg"
      }
      "dolbyvision" -> out += "dolbyvision"
    }
    return out
  }

  private fun profileName(codec: String, profile: Int): String? = when (codec) {
    "h264" -> mapOf(P.AVCProfileBaseline to "baseline", P.AVCProfileMain to "main", P.AVCProfileHigh to "high", P.AVCProfileHigh10 to "high10",
      P.AVCProfileConstrainedBaseline to "constrained-baseline", P.AVCProfileConstrainedHigh to "constrained-high")[profile]
    "hevc" -> mapOf(P.HEVCProfileMain to "main", P.HEVCProfileMain10 to "main10", P.HEVCProfileMain10HDR10 to "main10-hdr10",
      P.HEVCProfileMain10HDR10Plus to "main10-hdr10plus", P.HEVCProfileMainStill to "main-still")[profile]
    "vp9" -> mapOf(P.VP9Profile0 to "0", P.VP9Profile1 to "1", P.VP9Profile2 to "2", P.VP9Profile3 to "3", P.VP9Profile2HDR to "2-hdr",
      P.VP9Profile3HDR to "3-hdr", P.VP9Profile2HDR10Plus to "2-hdr10plus")[profile]
    "av1" -> mapOf(P.AV1ProfileMain8 to "main8", P.AV1ProfileMain10 to "main10", P.AV1ProfileMain10HDR10 to "main10-hdr10",
      P.AV1ProfileMain10HDR10Plus to "main10-hdr10plus")[profile]
    // Bit n of the Dolby Vision profile constant is DV profile n (0x1 = profile 0 ... 0x100 = profile 8).
    "dolbyvision" -> Integer.numberOfTrailingZeros(profile).takeIf { profile > 0 && profile and (profile - 1) == 0 }?.let { "dv$it" }
    else -> null
  }

  private fun hdrName(type: Int): String? = when (type) {
    Display.HdrCapabilities.HDR_TYPE_DOLBY_VISION -> "dolbyvision"
    Display.HdrCapabilities.HDR_TYPE_HDR10 -> "hdr10"
    Display.HdrCapabilities.HDR_TYPE_HLG -> "hlg"
    Display.HdrCapabilities.HDR_TYPE_HDR10_PLUS -> "hdr10plus"
    else -> null
  }

  @Suppress("DEPRECATION")
  private fun display(context: Context): Map<String, Any?> {
    val manager = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val display = manager.getDisplay(Display.DEFAULT_DISPLAY) ?: return mapOf("hdrTypes" to emptyList<String>())
    val mode = display.mode
    val types = if (Build.VERSION.SDK_INT >= 34) mode.supportedHdrTypes else display.hdrCapabilities?.supportedHdrTypes ?: IntArray(0)
    return mapOf(
      "width" to mode.physicalWidth,
      "height" to mode.physicalHeight,
      "refreshRate" to mode.refreshRate.toDouble(),
      "hdrTypes" to types.toList().mapNotNull { hdrName(it) }.distinct(),
      "isHdr" to (Build.VERSION.SDK_INT >= 26 && display.isHdr),
      "modes" to display.supportedModes.map { "${it.physicalWidth}x${it.physicalHeight}@${String.format(Locale.US, "%.3f", it.refreshRate)}" }.distinct(),
    )
  }

  private fun deviceType(type: Int): String = when (type) {
    AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> "speaker"
    AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> "earpiece"
    AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_HDMI_ARC -> "hdmi"
    AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_WIRED_HEADSET -> "headphones"
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetooth"
    AudioDeviceInfo.TYPE_USB_DEVICE, AudioDeviceInfo.TYPE_USB_HEADSET -> "usb"
    AudioDeviceInfo.TYPE_TELEPHONY -> "telephony"
    else -> if (Build.VERSION.SDK_INT >= 31 && type == AudioDeviceInfo.TYPE_HDMI_EARC) "hdmi" else "other-$type"
  }

  private fun audioOutput(context: Context): Map<String, Any?> {
    val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val devices = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
      .filter { it.type != AudioDeviceInfo.TYPE_TELEPHONY && it.type != AudioDeviceInfo.TYPE_BUILTIN_EARPIECE }
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_MEDIA)
      .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
      .build()
    val passthrough = mutableListOf<String>()
    var pcmChannels = 2
    if (Build.VERSION.SDK_INT >= 33) {
      for (profile in manager.getDirectProfilesForAttributes(attributes)) {
        val channels = profile.channelMasks.maxOfOrNull { Integer.bitCount(it) } ?: 0
        val name = PASSTHROUGH.firstOrNull { it.first == profile.format }?.second
        if (name != null) passthrough += name
        else if (profile.format == AudioFormat.ENCODING_PCM_16BIT || profile.format == AudioFormat.ENCODING_PCM_FLOAT) pcmChannels = maxOf(pcmChannels, channels)
      }
    } else if (Build.VERSION.SDK_INT >= 29) {
      for ((encoding, name) in PASSTHROUGH) {
        val format = AudioFormat.Builder().setEncoding(encoding).setSampleRate(48000).setChannelMask(AudioFormat.CHANNEL_OUT_5POINT1).build()
        if (AudioTrack.isDirectPlaybackSupported(format, attributes)) passthrough += name
      }
    } else {
      devices.filter { it.type == AudioDeviceInfo.TYPE_HDMI }.forEach { device ->
        device.encodings.forEach { encoding -> PASSTHROUGH.firstOrNull { it.first == encoding }?.let { passthrough += it.second } }
      }
    }
    val hdmiChannels = devices.filter { deviceType(it.type) == "hdmi" }.flatMap { it.channelCounts.toList() }.maxOrNull()
    return mapOf(
      "devices" to devices.map {
        mapOf(
          "type" to deviceType(it.type),
          "name" to it.productName?.toString(),
          "channelCounts" to it.channelCounts.toList(),
          "encodings" to it.encodings.toList(),
        )
      },
      "passthrough" to passthrough.distinct(),
      "maxChannels" to maxOf(pcmChannels, hdmiChannels ?: 2),
      "api" to when {
        Build.VERSION.SDK_INT >= 33 -> "getDirectProfilesForAttributes"
        Build.VERSION.SDK_INT >= 29 -> "isDirectPlaybackSupported"
        else -> "hdmiEncodings"
      },
    )
  }
}
