import type {
  AudioCodecProfile,
  DeviceProfile,
  EngineProfile,
  VideoCodecProfile,
} from '@modules/media-caps';

import { deviceSettings } from '@/lib/storage';

export type HdrFormat = 'hdr10' | 'hdr10plus' | 'dolbyvision' | 'hlg';
export type AudioMode = 'off' | 'decode' | 'passthrough';
export type EnginePreference = 'auto' | 'native' | 'vlc';

/** What the viewer changed on top of the measured profile (Settings → Device capabilities); unset = detected. */
export type CapabilityOverrides = {
  video?: Record<string, boolean>;
  hdr?: Partial<Record<HdrFormat, boolean>>;
  audio?: Record<string, AudioMode>;
  maxAudioChannels?: number;
  maxHeight?: number;
  maxBitrateKbps?: number;
  vlc?: boolean;
  engine?: EnginePreference;
};

/** Technical engine name, identical in every language. */
export const VLC_LABEL = 'VLC';
export const HDR_FORMATS: readonly HdrFormat[] = ['hdr10', 'hdr10plus', 'dolbyvision', 'hlg'];
export const VIDEO_CODECS = ['h264', 'hevc', 'av1', 'vp9', 'vp8', 'mpeg2video', 'mpeg4', 'vc1'];
export const AUDIO_CODECS = ['aac', 'ac3', 'eac3', 'truehd', 'dts', 'flac', 'opus', 'mp3'];
/** Formats an HDMI output can take as a bitstream. */
export const PASSTHROUGH_CODECS: ReadonlySet<string> = new Set(['ac3', 'eac3', 'truehd', 'dts']);
const TEN_BIT = new Set(['hevc', 'av1', 'vp9']);
const DOLBY_VISION = new Set(['hevc', 'av1']);

export function primaryEngine(profile: DeviceProfile): EngineProfile | undefined {
  return profile.engines.find((engine) => engine.engine !== 'vlc') ?? profile.engines[0];
}

function widthFor(height: number): number {
  return Math.round((height * 16) / 9 / 2) * 2;
}

/** The highest height any codec of the built-in engine declares. */
export function profileMaxHeight(profile: DeviceProfile): number | undefined {
  const heights = (primaryEngine(profile)?.videoCodecs ?? []).map((codec) => codec.maxHeight ?? 0);
  return Math.max(0, ...heights) || undefined;
}

const HEIGHT_TIERS = [720, 1080, 1440, 2160, 4320];

/** The resolution step a height reaches (4096×2304 is 4K, 7680×4320 is 8K); below 720p the lowest step. */
export function heightTier(height: number): number {
  return Math.max(HEIGHT_TIERS[0]!, ...HEIGHT_TIERS.filter((tier) => tier <= height));
}

/** Resolution steps to pick from: up to 4K, 8K only where the decoders reach it. */
export function heightChoices(detected: number | undefined): number[] {
  const top = heightTier(detected ?? 0);
  return HEIGHT_TIERS.filter((tier) => tier <= Math.max(2160, top));
}

export function detectedHdr(profile: DeviceProfile): Set<string> {
  return new Set(primaryEngine(profile)?.videoCodecs.flatMap((codec) => codec.hdrFormats ?? []));
}

export function hasVideo(profile: DeviceProfile, codec: string): boolean {
  return !!primaryEngine(profile)?.videoCodecs.some((item) => item.codec === codec);
}

export function audioMode(profile: DeviceProfile, codec: string): AudioMode {
  const entry = primaryEngine(profile)?.audioCodecs.find((item) => item.codec === codec);
  return !entry ? 'off' : entry.passthrough ? 'passthrough' : 'decode';
}

function hdrFits(format: HdrFormat, codec: string): boolean {
  return format === 'dolbyvision' ? DOLBY_VISION.has(codec) : TEN_BIT.has(codec);
}

function applyVideo(
  engine: EngineProfile,
  primary: boolean,
  overrides: CapabilityOverrides,
  fallbackHeight: number
): VideoCodecProfile[] {
  let codecs = engine.videoCodecs.filter((item) => overrides.video?.[item.codec] !== false);
  for (const [codec, on] of Object.entries(overrides.video ?? {})) {
    if (!on || codecs.some((item) => item.codec === codec)) continue;
    codecs.push({
      codec,
      maxWidth: widthFor(fallbackHeight),
      maxHeight: fallbackHeight,
      maxBitDepth: TEN_BIT.has(codec) ? 10 : 8,
      hdrFormats: [],
    });
  }
  if (overrides.maxHeight) {
    const height = overrides.maxHeight;
    codecs = codecs.map((item) => ({ ...item, maxWidth: widthFor(height), maxHeight: height }));
  }
  return codecs.map((item) => {
    let formats = (item.hdrFormats ?? []).filter(
      (format) => overrides.hdr?.[format as HdrFormat] !== false
    );
    // VLC declares no HDR output: forcing a format on only changes the built-in engine.
    const added = primary
      ? HDR_FORMATS.filter(
          (format) =>
            overrides.hdr?.[format] === true &&
            hdrFits(format, item.codec) &&
            !formats.includes(format)
        )
      : [];
    formats = [...formats, ...added];
    const maxBitDepth = added.length ? Math.max(item.maxBitDepth ?? 8, 10) : item.maxBitDepth;
    return { ...item, maxBitDepth, hdrFormats: formats };
  });
}

function applyAudio(
  engine: EngineProfile,
  primary: boolean,
  overrides: CapabilityOverrides,
  channels: number
): AudioCodecProfile[] {
  const modes = overrides.audio ?? {};
  let codecs = engine.audioCodecs.filter((item) => modes[item.codec] !== 'off');
  if (primary)
    for (const [codec, mode] of Object.entries(modes)) {
      if (mode === 'off') continue;
      const rest = codecs.filter((item) => item.codec !== codec);
      const current = codecs.find((item) => item.codec === codec);
      codecs =
        mode === 'passthrough'
          ? [...rest, { codec, passthrough: true }]
          : [...rest, { codec, maxChannels: current?.maxChannels ?? channels }];
    }
  if (overrides.maxAudioChannels) {
    const cap = overrides.maxAudioChannels;
    codecs = codecs.map((item) =>
      item.maxChannels === undefined
        ? item
        : { ...item, maxChannels: Math.min(item.maxChannels, cap) }
    );
  }
  return codecs;
}

/** The measured profile with the viewer's overrides: what the versions query and the playback start send. */
export function applyCapabilityOverrides(
  profile: DeviceProfile,
  overrides: CapabilityOverrides
): DeviceProfile {
  const primary = primaryEngine(profile);
  const fallbackHeight = overrides.maxHeight ?? profileMaxHeight(profile) ?? 1080;
  const vlc = profile.vlcAvailable && overrides.vlc !== false;
  const engines = profile.engines
    .filter((engine) => vlc || engine.engine !== 'vlc')
    .map((engine) => {
      const isPrimary = engine === primary;
      return {
        ...engine,
        videoCodecs: applyVideo(engine, isPrimary, overrides, fallbackHeight),
        audioCodecs: applyAudio(engine, isPrimary, overrides, engine.maxAudioChannels),
        maxAudioChannels: overrides.maxAudioChannels ?? engine.maxAudioChannels,
      };
    });
  const bitrate = overrides.maxBitrateKbps ?? profile.maxBitrateKbps;
  const { maxBitrateKbps: _detected, ...rest } = profile;
  return {
    ...rest,
    engines,
    vlcAvailable: vlc,
    ...(bitrate ? { maxBitrateKbps: bitrate } : {}),
  };
}

function prune<T>(record: Record<string, T> | undefined, keep: (key: string, value: T) => boolean) {
  const entries = Object.entries(record ?? {}).filter(([key, value]) => keep(key, value));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/** Drops every override that equals the detected value, so "overridden" always means "differs". */
/** The detected height or the step it shows as (2160 for a 4096×2304 decoder): no override. */
function isDetectedHeight(height: number | undefined, detected: DeviceProfile): boolean {
  const max = profileMaxHeight(detected);
  return height === undefined || height === max || (!!max && height === heightTier(max));
}

export function pruneOverrides(
  overrides: CapabilityOverrides,
  detected: DeviceProfile
): CapabilityOverrides {
  const hdr = detectedHdr(detected);
  const channels = primaryEngine(detected)?.maxAudioChannels;
  const next: CapabilityOverrides = {
    video: prune(overrides.video, (codec, on) => on !== hasVideo(detected, codec)),
    hdr: prune(overrides.hdr, (format, on) => on !== hdr.has(format)),
    audio: prune(overrides.audio, (codec, mode) => mode !== audioMode(detected, codec)),
    maxAudioChannels:
      overrides.maxAudioChannels !== channels ? overrides.maxAudioChannels : undefined,
    maxHeight: isDetectedHeight(overrides.maxHeight, detected) ? undefined : overrides.maxHeight,
    maxBitrateKbps:
      overrides.maxBitrateKbps !== detected.maxBitrateKbps ? overrides.maxBitrateKbps : undefined,
    vlc: detected.vlcAvailable && overrides.vlc === false ? false : undefined,
    engine: detected.vlcAvailable && overrides.engine !== 'auto' ? overrides.engine : undefined,
  };
  return Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined)
  ) as CapabilityOverrides;
}

export function overrideCount(overrides: CapabilityOverrides): number {
  return Object.values(overrides).reduce<number>(
    (count, value) =>
      count +
      (value && typeof value === 'object'
        ? Object.keys(value).length
        : value === undefined
          ? 0
          : 1),
    0
  );
}

const STORAGE_KEY = 'capabilities.overrides';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Parses stored overrides, dropping anything malformed (an older or hand-edited value never breaks playback). */
export function parseOverrides(raw: string | undefined): CapabilityOverrides {
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : undefined;
  } catch {
    return {};
  }
  if (!isRecord(value)) return {};
  const flags = (input: unknown) =>
    isRecord(input)
      ? Object.fromEntries(Object.entries(input).filter(([, on]) => typeof on === 'boolean'))
      : undefined;
  const number = (input: unknown, min: number, max: number) =>
    typeof input === 'number' && Number.isInteger(input) && input >= min && input <= max
      ? input
      : undefined;
  const result: CapabilityOverrides = {
    video: flags(value.video) as Record<string, boolean> | undefined,
    hdr: flags(value.hdr) as CapabilityOverrides['hdr'],
    audio: isRecord(value.audio)
      ? (Object.fromEntries(
          Object.entries(value.audio).filter(
            ([, mode]) => mode === 'off' || mode === 'decode' || mode === 'passthrough'
          )
        ) as Record<string, AudioMode>)
      : undefined,
    maxAudioChannels: number(value.maxAudioChannels, 1, 16),
    maxHeight: number(value.maxHeight, 144, 8640),
    maxBitrateKbps: number(value.maxBitrateKbps, 100, 1_000_000),
    vlc: value.vlc === false ? false : undefined,
    engine: value.engine === 'native' || value.engine === 'vlc' ? value.engine : undefined,
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, entry]) => entry !== undefined)
  ) as CapabilityOverrides;
}

/** This device's overrides (device-wide, not per account). */
export function storedCapabilityOverrides(): CapabilityOverrides {
  return parseOverrides(deviceSettings.getString(STORAGE_KEY));
}

export function saveCapabilityOverrides(overrides: CapabilityOverrides): void {
  if (overrideCount(overrides) === 0) deviceSettings.remove(STORAGE_KEY);
  else deviceSettings.set(STORAGE_KEY, JSON.stringify(overrides));
}

export function subscribeCapabilityOverrides(onChange: () => void): () => void {
  const listener = deviceSettings.addOnValueChangedListener((key) => {
    if (key === STORAGE_KEY) onChange();
  });
  return () => listener.remove();
}

/** The engine the viewer prefers for new playbacks (none = the server's automatic choice). */
export function preferredEngine(): { engine: 'native' | 'vlc' } | undefined {
  const { engine, vlc } = storedCapabilityOverrides();
  if (engine === 'native' || (engine === 'vlc' && vlc !== false)) return { engine };
  return undefined;
}
