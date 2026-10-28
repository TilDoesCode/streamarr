import type { DeviceProfile, MediaCapsReport } from '@modules/media-caps';
import { streamyboxInstalled } from '@modules/streamybox-player';

import {
  storedCapabilityOverrides,
  type CapabilityOverrides,
  type DolbyVisionPlayer,
} from '@/player/capability-overrides';
import type { Playback } from '@/player/playback-api';

/** A clone whose built-in engine declares Dolby Vision on 10-bit HEVC; only ever sent for the Streamybox Player. */
export function withDolbyVision(profile: DeviceProfile): DeviceProfile {
  return {
    ...profile,
    engines: profile.engines.map((engine) =>
      engine.engine !== 'native'
        ? engine
        : {
            ...engine,
            videoCodecs: engine.videoCodecs.map((codec) =>
              codec.codec !== 'hevc' ||
              (codec.maxBitDepth ?? 8) < 10 ||
              codec.hdrFormats?.includes('dolbyvision')
                ? codec
                : { ...codec, hdrFormats: [...(codec.hdrFormats ?? []), 'dolbyvision'] }
            ),
          }
    ),
  };
}

/** The original Dolby Vision file for the built-in engine's slot: what the Streamybox Player plays instead. */
export function isDolbyVisionDirect(playback: Playback | null | undefined): boolean {
  return (
    playback?.state === 'ready' &&
    playback.method === 'direct' &&
    playback.engine !== 'vlc' &&
    playback.mediaInfo?.video?.hdr === 'dolbyvision'
  );
}

/** The device has the Streamybox Dolby Vision feature and its render service: the setting shows. */
export function streamyboxOffered(report: Pick<MediaCapsReport, 'streamyboxDolbyVision'>): boolean {
  // The module itself (false off Android), not the engine index: Settings must not load every engine.
  return !!report.streamyboxDolbyVision && streamyboxInstalled();
}

export function dolbyVisionPlayerChoice(overrides: CapabilityOverrides): DolbyVisionPlayer {
  return overrides.dolbyVisionPlayer ?? 'auto';
}

/** Dolby Vision plays in the Streamybox Player: offered here and not turned off (automatic by default). */
export function streamyboxEnabled(
  report: Pick<MediaCapsReport, 'streamyboxDolbyVision'>,
  overrides: CapabilityOverrides = storedCapabilityOverrides()
): boolean {
  return streamyboxOffered(report) && dolbyVisionPlayerChoice(overrides) === 'auto';
}
