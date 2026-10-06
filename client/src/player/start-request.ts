import type { DeviceProfile } from '@modules/media-caps';

import { isSingleAudio } from '@/player/audio-preference';
import {
  TICKS_PER_SECOND,
  type Playback,
  type PlaybackPreferences,
  type StartRequest,
} from '@/player/playback-api';
import type { StepTracks } from '@/player/recovery/runner';

/** One audio track: the server picks it without an audio language preference. */
export function requestPreferencesOf(
  preferences: PlaybackPreferences,
  singleAudio: boolean
): PlaybackPreferences {
  return singleAudio ? { ...preferences, audioLanguage: undefined } : preferences;
}

/** The one start body: same work and release, the viewer's tracks, the position and the preferences. */
export function startRequestOf(input: {
  position: number;
  tracks: StepTracks | null;
  releaseId: string | null | undefined;
  base: Playback | null;
  workId: string;
  device: DeviceProfile;
  preferences: PlaybackPreferences;
  languages: Partial<PlaybackPreferences>;
}): StartRequest {
  const { position, tracks, releaseId, base } = input;
  const single = base
    ? (base.mediaInfo?.audioTracks?.length ?? 2) <= 1
    : isSingleAudio(releaseId ?? undefined);
  return {
    workId: base?.workId ?? input.workId,
    releaseId: releaseId ?? undefined,
    ...(tracks
      ? { audioStreamIndex: tracks.audio ?? undefined, subtitleStreamIndex: tracks.subtitle ?? -1 }
      : {}),
    startPositionTicks: position ? Math.round(position * TICKS_PER_SECOND) : undefined,
    device: input.device,
    preferences: { ...requestPreferencesOf(input.preferences, single), ...input.languages },
  };
}

/** Another audio track of this version than the one that stays silent; another language first (S9c D36). */
export function otherAudioTrack(playback: Playback, current: number | null) {
  const tracks = (playback.mediaInfo?.audioTracks ?? []).filter((track) => track.index !== current);
  const playing = playback.mediaInfo?.audioTracks?.find((track) => track.index === current);
  return tracks.find((track) => track.language !== playing?.language) ?? tracks[0] ?? null;
}
