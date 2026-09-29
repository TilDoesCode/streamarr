import { Platform } from 'react-native';

import { ExpoVideoEngine } from './expo-video-engine';
import type { EngineKind, PlayerEngine } from './types';
import { VlcEngine, type VlcOptions } from './vlc-engine';

export type { EngineKind, EngineEvent, EngineSnapshot, EngineTrack, PlayerEngine } from './types';
export type EngineOptions = { vlc?: VlcOptions };

/** Technical engine names (not UI copy). */
export const ENGINE_LABELS: Record<EngineKind, string> = {
  'expo-video': 'expo-video',
  vlc: 'VLC',
  web: 'HTML5',
};

/** Candidates for the server's `native` engine on this platform. */
export function nativeCandidates(): EngineKind[] {
  return ['expo-video'];
}

export function vlcAvailable(): boolean {
  return true;
}

export function createEngine(kind: EngineKind, options: EngineOptions = {}): PlayerEngine {
  switch (kind) {
    case 'expo-video':
      return new ExpoVideoEngine();
    case 'vlc':
      return new VlcEngine(options.vlc);
    case 'web':
      throw new Error(`${Platform.OS} has no browser engine`);
  }
}
