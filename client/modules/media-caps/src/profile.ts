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
