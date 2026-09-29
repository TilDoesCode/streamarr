import { NativeModule, registerWebModule } from 'expo';

import type {
  AudioDecoderInfo,
  CodecLogEntry,
  MediaCapsReport,
  VideoDecoderInfo,
  WebInfo,
} from './MediaCaps.types';

type VideoProbe = { codec: string; hd: string; uhd: string; tenBit?: string };

const VIDEO_PROBES: VideoProbe[] = [
  { codec: 'h264', hd: 'avc1.640028', uhd: 'avc1.640033' },
  { codec: 'hevc', hd: 'hvc1.1.6.L120.90', uhd: 'hvc1.1.6.L150.90', tenBit: 'hvc1.2.4.L150.90' },
  { codec: 'av1', hd: 'av01.0.08M.08', uhd: 'av01.0.12M.08', tenBit: 'av01.0.12M.10' },
  { codec: 'vp9', hd: 'vp09.00.40.08', uhd: 'vp09.00.50.08', tenBit: 'vp09.02.50.10' },
];

const AUDIO_PROBES: [string, string][] = [
  ['aac', 'mp4a.40.2'],
  ['mp3', 'mp4a.6B'],
  ['opus', 'opus'],
  ['flac', 'flac'],
  ['ac3', 'ac-3'],
  ['eac3', 'ec-3'],
];

type Decoding = { supported: boolean; smooth: boolean; powerEfficient: boolean };

function browserName(agent: string): string {
  if (/Edg\//.test(agent)) return 'Edge';
  if (/Firefox\//.test(agent)) return 'Firefox';
  if (/Chrome\//.test(agent)) return 'Chrome';
  if (/Safari\//.test(agent)) return 'Safari';
  return 'Browser';
}

function webInfo(): WebInfo {
  const agent = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const video = typeof document === 'undefined' ? null : document.createElement('video');
  const scope = globalThis as { MediaSource?: unknown; ManagedMediaSource?: unknown };
  return {
    browser: browserName(agent),
    userAgent: agent,
    mse: typeof scope.MediaSource !== 'undefined',
    managedMse: typeof scope.ManagedMediaSource !== 'undefined',
    nativeHls: !!video && video.canPlayType('application/vnd.apple.mpegurl') !== '',
    mediaCapabilities: typeof navigator !== 'undefined' && 'mediaCapabilities' in navigator,
  };
}

/** MediaCapabilities for MSE (hls.js) when available, else progressive file playback; canPlayType as fallback. */
async function decode(
  info: WebInfo,
  contentType: string,
  video: { width: number; height: number; hdr?: 'pq' | 'hlg' } | null
): Promise<Decoding> {
  const type = info.mse || info.managedMse ? 'media-source' : 'file';
  if (info.mediaCapabilities) {
    try {
      const config: MediaDecodingConfiguration = video
        ? {
            type,
            video: {
              contentType,
              width: video.width,
              height: video.height,
              bitrate: video.height > 1080 ? 25_000_000 : 8_000_000,
              framerate: 24,
              ...(video.hdr
                ? {
                    transferFunction: video.hdr,
                    colorGamut: 'rec2020' as ColorGamut,
                    ...(video.hdr === 'pq'
                      ? { hdrMetadataType: 'smpteSt2086' as HdrMetadataType }
                      : {}),
                  }
                : {}),
            },
          }
        : {
            type,
            audio: { contentType, channels: '2', bitrate: 256_000, samplerate: 48_000 },
          };
      const result = await navigator.mediaCapabilities.decodingInfo(config);
      return {
        supported: result.supported,
        smooth: result.smooth,
        powerEfficient: result.powerEfficient,
      };
    } catch {
      // Unknown dictionary members (older browsers) fall through to canPlayType.
    }
  }
  const scope = globalThis as { MediaSource?: { isTypeSupported(type: string): boolean } };
  const supported =
    scope.MediaSource?.isTypeSupported(contentType) ??
    document.createElement('video').canPlayType(contentType) !== '';
  return { supported, smooth: supported, powerEfficient: false };
}

function audioChannels(): number {
  try {
    const Context = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Context) return 2;
    const context = new Context();
    const channels = context.destination.maxChannelCount;
    void context.close();
    return Math.max(2, channels);
  } catch {
    return 2;
  }
}

async function report(): Promise<MediaCapsReport> {
  const info = webInfo();
  const media = (query: string) => typeof matchMedia === 'function' && matchMedia(query).matches;
  const displayHdr = media('(dynamic-range: high)');
  const videoDecoders: VideoDecoderInfo[] = [];
  for (const probe of VIDEO_PROBES) {
    const hd = await decode(info, `video/mp4; codecs="${probe.hd}"`, { width: 1920, height: 1080 });
    if (!hd.supported) continue;
    const uhd = await decode(info, `video/mp4; codecs="${probe.uhd}"`, {
      width: 3840,
      height: 2160,
    });
    const tenBit = probe.tenBit
      ? await decode(info, `video/mp4; codecs="${probe.tenBit}"`, { width: 1920, height: 1080 })
      : null;
    const hdrFormats: string[] = [];
    if (probe.tenBit && tenBit?.supported) {
      const pq = await decode(info, `video/mp4; codecs="${probe.tenBit}"`, {
        width: 1920,
        height: 1080,
        hdr: 'pq',
      });
      const hlg = await decode(info, `video/mp4; codecs="${probe.tenBit}"`, {
        width: 1920,
        height: 1080,
        hdr: 'hlg',
      });
      if (pq.supported) hdrFormats.push('hdr10');
      if (hlg.supported) hdrFormats.push('hlg');
    }
    videoDecoders.push({
      name: `${info.browser} ${probe.codec}`,
      codec: probe.codec,
      hardware: hd.powerEfficient,
      softwareOnly: !hd.powerEfficient,
      maxWidth: uhd.supported ? 3840 : 1920,
      maxHeight: uhd.supported ? 2160 : 1080,
      maxBitDepth: tenBit?.supported ? 10 : 8,
      hdrFormats,
      smooth: hd.smooth,
    });
  }
  const audioDecoders: AudioDecoderInfo[] = [];
  for (const [codec, tag] of AUDIO_PROBES) {
    const result = await decode(info, `audio/mp4; codecs="${tag}"`, null);
    if (result.supported)
      audioDecoders.push({
        name: `${info.browser} ${codec}`,
        codec,
        hardware: false,
        softwareOnly: true,
        maxChannels: 2,
      });
  }
  const channels = audioChannels();
  return {
    platform: 'web',
    device: { isTV: false, isEmulator: false, model: info.browser, osVersion: info.userAgent },
    videoDecoders,
    audioDecoders,
    display: {
      width:
        typeof screen === 'undefined' ? undefined : Math.round(screen.width * devicePixelRatio),
      height:
        typeof screen === 'undefined' ? undefined : Math.round(screen.height * devicePixelRatio),
      hdrTypes: displayHdr ? ['hdr10', 'hlg'] : [],
      isHdr: displayHdr,
    },
    audioOutput: {
      devices: [{ type: 'browser', channelCounts: [channels] }],
      passthrough: [],
      maxChannels: channels,
      api: 'AudioContext',
    },
    web: info,
  };
}

class MediaCapsWebModule extends NativeModule {
  async getCapabilitiesAsync(): Promise<MediaCapsReport> {
    return report();
  }

  async readCodecLogAsync(_sinceEpochMs: number): Promise<CodecLogEntry[]> {
    return [];
  }
}

export default registerWebModule(MediaCapsWebModule, 'MediaCaps');
