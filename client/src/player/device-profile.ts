import {
  getDeviceProfileAsync,
  type DeviceProfile,
  type MediaCapsReport,
} from '@modules/media-caps';
import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';

import { applyCapabilityOverrides, storedCapabilityOverrides } from '@/player/capability-overrides';

export type DeviceCaps = { report: MediaCapsReport; profile: DeviceProfile };

let pending: Promise<DeviceCaps> | null = null;

/** This device's capabilities and playback profile (media-caps) as measured, once per app run. */
export function loadDetectedCaps(): Promise<DeviceCaps> {
  pending ??= getDeviceProfileAsync({ vlc: Platform.OS !== 'web' }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

/** The measured capabilities with the viewer's overrides (Settings → Device capabilities) applied. */
export function loadDeviceCaps(): Promise<DeviceCaps> {
  return loadDetectedCaps().then((caps) => ({
    ...caps,
    profile: applyCapabilityOverrides(caps.profile, storedCapabilityOverrides()),
  }));
}

function loadDeviceProfile(): Promise<DeviceProfile> {
  return loadDeviceCaps().then((caps) => caps.profile);
}

export function useDeviceProfile() {
  return useQuery({
    queryKey: ['device', 'profile'],
    queryFn: loadDeviceProfile,
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
  });
}

export type VersionHints = {
  videoCodecs: string;
  audioCodecs?: string;
  /** Codecs the output takes as a bitstream (HDMI passthrough): no channel limit applies to them. */
  audioPassthrough?: string;
  containers?: string;
  hdrFormats?: string;
  supports10Bit?: boolean;
  maxAudioChannels?: number;
  maxHeight?: number;
  maxBitrateKbps?: number;
  vlcAvailable?: boolean;
  vlcVideoCodecs?: string;
  vlcSupports10Bit?: boolean;
  /** HDR formats the VLC engine shows; `none` when it declares none (absent would mean libVLC's HDR10/HLG defaults). */
  vlcHdrFormats?: string;
  vlcHdrToneMapping?: boolean;
};

// Not tvOS: VLCKit playback on Apple TV is unverified (I3 left it open), so tvOS versions stay native-only.
const VLC_HINT_PLATFORMS = new Set(['android', 'androidtv', 'ios', 'ipados']);

/** The VLC engine as `versions` caps (Android, iPhone, iPad): the codec heights the playback profile declares (docs/api.md). */
function vlcHints(profile: DeviceProfile): Partial<VersionHints> {
  const vlc = profile.engines.find((item) => item.engine === 'vlc');
  if (!profile.vlcAvailable || !vlc || !VLC_HINT_PLATFORMS.has(profile.platform)) return {};
  const codecs = vlc.videoCodecs.map(({ codec, maxHeight }) =>
    maxHeight ? `${codec}:${maxHeight}` : codec
  );
  if (!codecs.length) return {};
  return {
    vlcAvailable: true,
    vlcVideoCodecs: codecs.join(','),
    vlcSupports10Bit: vlc.videoCodecs.some((codec) => (codec.maxBitDepth ?? 8) >= 10),
    vlcHdrFormats:
      [...new Set(vlc.videoCodecs.flatMap((codec) => codec.hdrFormats ?? []))].join(',') || 'none',
    vlcHdrToneMapping: false, // the playback profile does not declare tone mapping for VLC either
  };
}

/** The compact `versions` query: the native (first) engine plus the VLC engine's real limits where VLC is verified. */
export function versionHints(profile: DeviceProfile): VersionHints | undefined {
  const engine = profile.engines.find((item) => item.engine !== 'vlc') ?? profile.engines[0];
  if (!engine?.videoCodecs.length) return undefined;
  const join = (values: readonly string[]) => [...new Set(values)].join(',') || undefined;
  const heights = engine.videoCodecs.map((codec) => codec.maxHeight ?? 0);
  const hdr = engine.videoCodecs.flatMap((codec) => codec.hdrFormats ?? []);
  return {
    videoCodecs: join(engine.videoCodecs.map((codec) => codec.codec)) ?? '',
    audioCodecs: join(engine.audioCodecs.map((codec) => codec.codec)),
    audioPassthrough: join(
      engine.audioCodecs.filter((codec) => codec.passthrough).map((codec) => codec.codec)
    ),
    containers: join(engine.containers),
    hdrFormats: join(hdr),
    supports10Bit: engine.videoCodecs.some((codec) => (codec.maxBitDepth ?? 8) >= 10),
    maxAudioChannels: engine.maxAudioChannels,
    maxHeight: Math.max(...heights) || undefined,
    maxBitrateKbps: profile.maxBitrateKbps,
    ...vlcHints(profile),
  };
}
