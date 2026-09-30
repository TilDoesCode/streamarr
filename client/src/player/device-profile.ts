import {
  getDeviceProfileAsync,
  type DeviceProfile,
  type MediaCapsReport,
} from '@modules/media-caps';
import { useQuery } from '@tanstack/react-query';
import { Platform } from 'react-native';

export type DeviceCaps = { report: MediaCapsReport; profile: DeviceProfile };

let pending: Promise<DeviceCaps> | null = null;

/** This device's capabilities and playback profile (media-caps), measured once per app run. */
export function loadDeviceCaps(): Promise<DeviceCaps> {
  pending ??= getDeviceProfileAsync({ vlc: Platform.OS !== 'web' }).catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

export function loadDeviceProfile(): Promise<DeviceProfile> {
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
  containers?: string;
  hdrFormats?: string;
  supports10Bit?: boolean;
  maxAudioChannels?: number;
  maxHeight?: number;
  maxBitrateKbps?: number;
};

/** The compact `versions` query of the native (first) engine, so predictions match what this device plays natively. */
export function versionHints(profile: DeviceProfile): VersionHints | undefined {
  const engine = profile.engines.find((item) => item.engine !== 'vlc') ?? profile.engines[0];
  if (!engine?.videoCodecs.length) return undefined;
  const join = (values: readonly string[]) => [...new Set(values)].join(',') || undefined;
  const heights = engine.videoCodecs.map((codec) => codec.maxHeight ?? 0);
  const hdr = engine.videoCodecs.flatMap((codec) => codec.hdrFormats ?? []);
  return {
    videoCodecs: join(engine.videoCodecs.map((codec) => codec.codec)) ?? '',
    audioCodecs: join(engine.audioCodecs.map((codec) => codec.codec)),
    containers: join(engine.containers),
    hdrFormats: join(hdr),
    supports10Bit: engine.videoCodecs.some((codec) => (codec.maxBitDepth ?? 8) >= 10),
    maxAudioChannels: engine.maxAudioChannels,
    maxHeight: Math.max(...heights) || undefined,
    maxBitrateKbps: profile.maxBitrateKbps,
  };
}
