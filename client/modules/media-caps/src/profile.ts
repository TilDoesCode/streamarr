import type {
  AudioCodecProfile,
  DeviceProfile,
  EngineProfile,
  MediaCapsReport,
  VideoCodecProfile,
  VideoDecoderInfo,
} from './MediaCaps.types';

/** Video codecs the server knows (DeviceNames.Video). */
const SERVER_VIDEO = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1'] as const;
const SERVER_HDR = ['hdr10', 'hlg', 'dolbyvision'];
const TEN_BIT = new Set(['hevc', 'av1', 'vp9']);
/** Software-only decoders are used up to this height; above it the server remuxes/transcodes instead. */
export const SOFTWARE_MAX_HEIGHT = 1080;

const PASSTHROUGH_NAMES: Record<string, string> = {
  ac3: 'ac3',
  eac3: 'eac3',
  'eac3-joc': 'eac3',
  dts: 'dts',
  'dts-hd': 'dts',
  truehd: 'truehd',
};

/** Full channel count of a typical source per bitstream codec (TrueHD and DTS-HD carry 7.1). */
const FULL_CHANNELS: Record<string, number> = { ac3: 6, eac3: 6, dts: 6, truehd: 8 };

export type PassthroughReason =
  'surroundNever' | 'notTvMode' | 'iec61937Only' | 'channels' | 'noneReported' | 'unknown';

export type PassthroughDiagnosis = {
  /** Bitstream codecs the output lists (EDID, direct profiles, HDMI plug) that the player does not pass through. */
  refused: string[];
  /** Why, most likely first: null when nothing the output lists is refused. */
  reason: PassthroughReason | null;
};

/** Android: why bitstream formats the HDMI output advertises are still decoded or converted. */
export function passthroughDiagnosis(report: MediaCapsReport): PassthroughDiagnosis {
  const output = report.audioOutput;
  const canonical = (names: readonly string[]) =>
    names.map((name) => PASSTHROUGH_NAMES[name]).filter((name): name is string => !!name);
  const passed = new Set(canonical(output.passthrough));
  const direct = output.directProfiles ?? [];
  const advertised = new Set(
    canonical([
      ...(output.hdmiEncodings ?? []),
      ...(output.plugEncodings ?? []),
      ...direct.map((profile) => profile.format),
    ])
  );
  const refused = [...advertised].filter((codec) => !passed.has(codec)).sort();
  if (!refused.length) {
    const hdmi = output.devices.some((device) => device.type === 'hdmi');
    const silent = hdmi && !passed.size && !advertised.size;
    return {
      refused,
      reason: silent ? (output.surroundMode === 'never' ? 'surroundNever' : 'noneReported') : null,
    };
  }
  const wrappedOnly = (codec: string) => {
    const listed = direct.filter((profile) => PASSTHROUGH_NAMES[profile.format] === codec);
    return listed.length > 0 && listed.every((profile) => profile.iec61937);
  };
  const short = (codec: string) =>
    (output.passthroughChannels?.[codec] ?? 0) > 0 &&
    (output.passthroughChannels?.[codec] ?? 0) < (FULL_CHANNELS[codec] ?? 6);
  const reason: PassthroughReason =
    output.surroundMode === 'never'
      ? 'surroundNever'
      : output.tvMode === false
        ? 'notTvMode'
        : refused.some(wrappedOnly)
          ? 'iec61937Only'
          : refused.some(short)
            ? 'channels'
            : 'unknown';
  return { refused, reason };
}

type Family = 'exoplayer' | 'avplayer' | 'web';

const CONTAINERS: Record<Family, string[]> = {
  exoplayer: ['mp4', 'mkv', 'webm', 'ts', 'mpeg', 'avi', 'ogg', 'flv'],
  avplayer: ['mp4'],
  web: ['mp4', 'webm'],
};

const SUBTITLES: Record<Family, string[]> = {
  exoplayer: ['srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'pgs', 'vobsub', 'dvbsub'],
  avplayer: ['webvtt', 'mov_text'],
  web: ['webvtt'],
};

const VLC_CONTAINERS = ['mkv', 'mp4', 'webm', 'ts', 'mpeg', 'avi', 'ogg', 'flv', 'asf'];
const VLC_SUBTITLES = ['srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'pgs', 'vobsub', 'dvbsub'];
const VLC_AUDIO = [
  'aac',
  'ac3',
  'eac3',
  'truehd',
  'dts',
  'flac',
  'opus',
  'mp3',
  'vorbis',
  'mp2',
  'pcm_s16le',
  'pcm_s24le',
];

export type ProfileOptions = {
  /** The VLC engine is bundled and may be used (native apps). */
  vlc: boolean;
  maxBitrateKbps?: number;
};

export type DecoderChoice = {
  codec: string;
  hardware: string[];
  software: string[];
  /** Which class of decoder the profile relies on for this codec. */
  uses: 'hardware' | 'software' | 'none';
  maxHeight?: number;
  maxBitDepth?: number;
  hdrFormats: string[];
};

function family(report: MediaCapsReport): Family {
  if (report.platform === 'web') return 'web';
  if (report.platform === 'android' || report.platform === 'androidtv') return 'exoplayer';
  return 'avplayer';
}

function maxOf(values: (number | null | undefined)[]): number | undefined {
  const numbers = values.filter((value): value is number => typeof value === 'number');
  return numbers.length ? Math.max(...numbers) : undefined;
}

/** HW vs SW decoders per codec and what the profile uses (hardware first, software capped). */
export function chooseDecoders(report: MediaCapsReport): DecoderChoice[] {
  const displayHdr = new Set(report.display.hdrTypes);
  const android = family(report) === 'exoplayer';
  const dolbyVision = report.videoDecoders.some(
    (decoder) => decoder.codec === 'dolbyvision' && decoder.usable !== false && decoder.hardware
  );
  return SERVER_VIDEO.map((codec) => {
    const all = report.videoDecoders.filter(
      (decoder) => decoder.codec === codec && decoder.usable !== false
    );
    const hardware = all.filter((decoder) => decoder.hardware);
    const software = all.filter((decoder) => !decoder.hardware);
    const used: VideoDecoderInfo[] = hardware.length ? hardware : software;
    const names = (list: VideoDecoderInfo[]) => [...new Set(list.map((decoder) => decoder.name))];
    if (!used.length) return { codec, hardware: [], software: [], uses: 'none', hdrFormats: [] };
    const decoderHdr = new Set(used.flatMap((decoder) => decoder.hdrFormats));
    // Android vendor decoders (Rockchip, Amlogic) often list Main10 without the HDR10 profile, yet HDR10/HLG is 10-bit video plus signalling.
    if (android && TEN_BIT.has(codec) && used.some((decoder) => decoder.maxBitDepth >= 10)) {
      decoderHdr.add('hdr10');
      decoderHdr.add('hlg');
    }
    if (dolbyVision && (codec === 'hevc' || codec === 'av1')) decoderHdr.add('dolbyvision');
    const maxHeight = maxOf(used.map((decoder) => decoder.maxHeight));
    return {
      codec,
      hardware: names(hardware),
      software: names(software),
      uses: hardware.length ? 'hardware' : 'software',
      maxHeight: hardware.length
        ? maxHeight
        : Math.min(maxHeight ?? SOFTWARE_MAX_HEIGHT, SOFTWARE_MAX_HEIGHT),
      maxBitDepth: maxOf(used.map((decoder) => decoder.maxBitDepth)),
      hdrFormats: SERVER_HDR.filter((format) => decoderHdr.has(format) && displayHdr.has(format)),
    };
  });
}

function widthFor(height: number | undefined): number | undefined {
  if (height === undefined) return undefined;
  return Math.round((height * 16) / 9 / 2) * 2;
}

function nativeVideo(choices: DecoderChoice[]): VideoCodecProfile[] {
  return choices
    .filter((choice) => choice.uses !== 'none')
    .map((choice) => ({
      codec: choice.codec,
      maxWidth: widthFor(choice.maxHeight),
      maxHeight: choice.maxHeight,
      maxBitDepth: choice.maxBitDepth,
      hdrFormats: choice.hdrFormats,
    }));
}

function nativeAudio(report: MediaCapsReport): AudioCodecProfile[] {
  const byCodec = new Map<string, AudioCodecProfile>();
  for (const decoder of report.audioDecoders) {
    const codecs = decoder.codec === 'pcm' ? ['pcm_s16le', 'pcm_s24le'] : [decoder.codec];
    for (const codec of codecs) {
      if (codec === 'ac4') continue;
      const current = byCodec.get(codec);
      byCodec.set(codec, {
        codec,
        maxChannels: Math.max(current?.maxChannels ?? 0, decoder.maxChannels),
      });
    }
  }
  for (const encoding of report.audioOutput.passthrough) {
    const codec = PASSTHROUGH_NAMES[encoding];
    if (!codec) continue;
    byCodec.set(codec, { codec, passthrough: true });
  }
  return [...byCodec.values()];
}

function vlcEngine(choices: DecoderChoice[], channels: number): EngineProfile {
  return {
    engine: 'vlc',
    containers: VLC_CONTAINERS,
    videoCodecs: SERVER_VIDEO.map((codec) => {
      const choice = choices.find((item) => item.codec === codec);
      const depth = TEN_BIT.has(codec) ? 10 : 8;
      // libVLC hands streams its MediaCodec decoder covers to hardware, everything else to its software decoders.
      const hardware =
        choice?.uses === 'hardware' && (choice.maxBitDepth ?? 8) >= depth ? choice : undefined;
      const height = hardware?.maxHeight ?? SOFTWARE_MAX_HEIGHT;
      return {
        codec,
        maxWidth: widthFor(height),
        maxHeight: height,
        maxBitDepth: depth,
        hdrFormats: [],
      };
    }),
    audioCodecs: VLC_AUDIO.map((codec) => ({ codec, maxChannels: 8 })),
    subtitleFormats: VLC_SUBTITLES,
    hls: true,
    maxAudioChannels: channels,
  };
}

/** The DeviceProfile the playback API expects, built from the measured capabilities. */
export function buildDeviceProfile(
  report: MediaCapsReport,
  options: ProfileOptions
): DeviceProfile {
  const kind = family(report);
  const choices = chooseDecoders(report);
  const channels = Math.max(2, report.audioOutput.maxChannels);
  const primary: EngineProfile = {
    engine: kind === 'web' ? 'web' : 'native',
    containers: CONTAINERS[kind],
    videoCodecs: nativeVideo(choices),
    audioCodecs: nativeAudio(report),
    subtitleFormats: SUBTITLES[kind],
    hls: kind !== 'web' || !!(report.web?.mse || report.web?.managedMse || report.web?.nativeHls),
    maxAudioChannels: channels,
  };
  const vlc = options.vlc && kind !== 'web';
  return {
    platform: report.platform,
    engines: vlc ? [primary, vlcEngine(choices, channels)] : [primary],
    vlcAvailable: vlc,
    ...(options.maxBitrateKbps ? { maxBitrateKbps: options.maxBitrateKbps } : {}),
  };
}
