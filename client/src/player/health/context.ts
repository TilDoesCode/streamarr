import { AppState } from 'react-native';

import type { EngineState } from '@/player/engines/types';
import type { Playback } from '@/player/playback-api';

import type { EngineHealth } from './types';

/** What the watchdog may judge now: the player's guards, and what the server knows of the tracks. */
export function watchContext(
  health: EngineHealth,
  state: EngineState | undefined,
  info: Playback['mediaInfo'] | undefined,
  player: {
    stalled: boolean;
    wantsPlayback: boolean;
    busy: boolean;
    pictureInPicture: boolean;
    settling: boolean;
  }
) {
  return {
    buffering: player.stalled || state === 'buffering' || state === 'loading',
    wantsPlayback: player.wantsPlayback && !player.busy,
    visible: AppState.currentState !== 'background',
    pictureInPicture: player.pictureInPicture,
    settling: player.settling,
    // The server knows: `video: null` is an audio-only file (no picture rules); unknown asks the engine.
    hasVideo: info?.video === null ? false : info?.video ? true : health.hasVideoTrack,
    hasAudio: info?.audioTracks?.length ? true : health.hasAudioTrack,
  };
}
