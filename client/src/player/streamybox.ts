import type {
  AudioCodecProfile,
  DeviceProfile,
  DolbyVisionAudio,
  MediaCapsReport,
} from '@modules/media-caps';
import { streamyboxInstalled } from '@modules/streamybox-player';

import {
  storedCapabilityOverrides,
  type CapabilityOverrides,
  type DolbyVisionPlayer,
} from '@/player/capability-overrides';
import type { Playback } from '@/player/playback-api';

/** What mpv in the Streamybox Player decodes (it downmixes to the output itself). */
const PLAYER_DECODES = [
  'aac',
  'ac3',
  'eac3',
  'truehd',
  'dts',
  'flac',
  'opus',
  'mp3',
  'vorbis',
  'alac',
  'mp2',
  'pcm_s16le',
  'pcm_s24le',
];
/** What the player bitstreams when the output takes it (1.5.6: AC-3, E-AC-3, TrueHD; DTS is decoded). */
const PLAYER_BITSTREAMS = new Set(['ac3', 'eac3', 'truehd']);

/** The player's own audio: every common codec up to 7.1, bitstreamed where the output passes it through. */
export function streamyboxAudio(passthrough: readonly AudioCodecProfile[]): DolbyVisionAudio {
  const bitstream = new Set(
    passthrough.filter((item) => item.passthrough).map((item) => item.codec)
  );
  return {
    audioCodecs: PLAYER_DECODES.map((codec) => ({
      codec,
      maxChannels: 8,
      ...(PLAYER_BITSTREAMS.has(codec) && bitstream.has(codec) ? { passthrough: true } : {}),
    })),
    maxAudioChannels: 8,
  };
}

/** A clone whose built-in engine declares Dolby Vision on 10-bit HEVC; only ever sent for the Streamybox Player. */
export function withDolbyVision(profile: DeviceProfile): DeviceProfile {
  return {
    ...profile,
    engines: profile.engines.map((engine) =>
      engine.engine !== 'native'
        ? engine
        : {
            ...engine,
            // The server reads it only for a Dolby Vision direct play, which the Streamybox Player plays.
            dolbyVisionAudio: streamyboxAudio(engine.audioCodecs),
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
