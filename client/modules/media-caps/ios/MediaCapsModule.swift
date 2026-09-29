import AVFoundation
import ExpoModulesCore
import UIKit
import VideoToolbox

public class MediaCapsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MediaCaps")

    AsyncFunction("getCapabilitiesAsync") { () -> [String: Any] in
      return AppleCaps.report()
    }.runOnQueue(.main)

    AsyncFunction("readCodecLogAsync") { (_: Double) -> [[String: Any]] in
      return []
    }
  }
}

enum AppleCaps {
  // FourCCs spelled out so older SDK headers without the named constants still compile.
  private static let videoTypes: [(String, CMVideoCodecType)] = [
    ("h264", kCMVideoCodecType_H264),
    ("hevc", kCMVideoCodecType_HEVC),
    ("dolbyvision", 0x6476_6831),
    ("av1", 0x6176_3031),
    ("vp9", 0x7670_3039),
    ("mpeg2video", kCMVideoCodecType_MPEG2Video),
    ("mpeg4", kCMVideoCodecType_MPEG4Video),
  ]

  static func report() -> [String: Any] {
    let hdr = hdrModes()
    return [
      "platform": platform(),
      "device": device(),
      "videoDecoders": videoTypes.map { codec, type in videoDecoder(codec: codec, type: type, hdr: hdr) },
      "audioDecoders": ["aac", "ac3", "eac3", "flac", "mp3", "alac", "pcm"].map { codec in
        ["name": "AudioToolbox", "codec": codec, "hardware": false, "softwareOnly": true, "maxChannels": 8] as [String: Any]
      },
      "display": display(hdr: hdr),
      "audioOutput": audioOutput(),
    ]
  }

  private static func platform() -> String {
    switch UIDevice.current.userInterfaceIdiom {
    case .tv: return "tvos"
    case .pad: return "ipados"
    default: return "ios"
    }
  }

  private static func device() -> [String: Any] {
    #if targetEnvironment(simulator)
    let simulator = true
    #else
    let simulator = false
    #endif
    var systemInfo = utsname()
    uname(&systemInfo)
    let machine = withUnsafeBytes(of: &systemInfo.machine) { raw in
      String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
    }
    return [
      "manufacturer": "Apple",
      "model": machine,
      "osVersion": UIDevice.current.systemVersion,
      "isTV": UIDevice.current.userInterfaceIdiom == .tv,
      "isEmulator": simulator,
    ]
  }

  private static func videoDecoder(codec: String, type: CMVideoCodecType, hdr: [String]) -> [String: Any] {
    let hardware = VTIsHardwareDecodeSupported(type)
    // AVFoundation decodes H.264 everywhere; the other codecs are only usable with a hardware decoder.
    let usable = hardware || codec == "h264"
    let tenBit = codec == "hevc" || codec == "dolbyvision" || codec == "av1" || codec == "vp9"
    var formats: [String] = []
    if hardware && (codec == "hevc" || codec == "av1") {
      formats = hdr.filter { $0 != "dolbyvision" }
    } else if hardware && codec == "dolbyvision" && hdr.contains("dolbyvision") {
      formats = ["dolbyvision"]
    }
    return [
      "name": hardware ? "VideoToolbox" : "AVFoundation",
      "codec": codec,
      "hardware": hardware,
      "softwareOnly": !hardware,
      "usable": usable,
      "maxWidth": hardware && codec != "mpeg2video" && codec != "mpeg4" ? 3840 : 1920,
      "maxHeight": hardware && codec != "mpeg2video" && codec != "mpeg4" ? 2160 : 1080,
      "maxBitDepth": tenBit && hardware ? 10 : 8,
      "hdrFormats": formats,
    ]
  }

  private static func hdrModes() -> [String] {
    #if os(tvOS)
    let modes = AVPlayer.availableHDRModes
    var out: [String] = []
    if modes.contains(.hdr10) { out.append("hdr10") }
    if modes.contains(.hlg) { out.append("hlg") }
    if modes.contains(.dolbyVision) { out.append("dolbyvision") }
    return out
    #else
    return AVPlayer.eligibleForHDRPlayback ? ["hdr10", "hlg", "dolbyvision"] : []
    #endif
  }

  private static func display(hdr: [String]) -> [String: Any] {
    let screen = UIScreen.main
    var out: [String: Any] = [
      "width": Int(screen.nativeBounds.width),
      "height": Int(screen.nativeBounds.height),
      "refreshRate": Double(screen.maximumFramesPerSecond),
      "hdrTypes": hdr,
      "isHdr": !hdr.isEmpty,
    ]
    #if os(iOS)
    if #available(iOS 16.0, *) {
      out["edrHeadroom"] = Double(screen.potentialEDRHeadroom)
    }
    #endif
    return out
  }

  private static func audioOutput() -> [String: Any] {
    let session = AVAudioSession.sharedInstance()
    let outputs = session.currentRoute.outputs
    let channels = max(session.maximumOutputNumberOfChannels, 2)
    var passthrough: [String] = []
    #if os(tvOS)
    // AVPlayer on tvOS bitstreams Dolby Digital Plus (incl. Atmos) to a multichannel HDMI route.
    if outputs.contains(where: { $0.portType == .HDMI }) && channels > 2 {
      passthrough = ["eac3"]
    }
    #endif
    return [
      "devices": outputs.map { port in
        [
          "type": port.portType == .HDMI ? "hdmi" : port.portType.rawValue,
          "name": port.portName,
          "channelCounts": [port.channels?.count ?? 2],
        ] as [String: Any]
      },
      "passthrough": passthrough,
      "maxChannels": channels,
      "api": "AVAudioSession",
    ]
  }
}
