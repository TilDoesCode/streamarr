import { Platform } from 'react-native';

import { probeStreamyboxInstalled, streamyboxInstalled } from '@modules/streamybox-player';

import { ExpoVideoEngine } from './expo-video-engine';
import { StreamyboxEngine } from './streamybox-engine';
import type { EngineKind, PlayerEngine } from './types';
import { VlcEngine, type VlcOptions } from './vlc-engine';

export type {
  EngineKind,
  EngineEvent,
  EngineSnapshot,
  EngineState,
  EngineTrack,
  PlayerEngine,
} from './types';
export type EngineOptions = { vlc?: VlcOptions };

/** Technical engine names (not UI copy). */
export const ENGINE_LABELS: Record<EngineKind, string> = {
  'expo-video': 'expo-video',
  vlc: 'VLC',
  web: 'HTML5',
  streamybox: 'Streamybox',
};

/** Candidates for the server's `native` engine on this platform. */
export function nativeCandidates(): EngineKind[] {
  return ['expo-video'];
}

export function vlcAvailable(): boolean {
  return true;
}

/** The Streamybox player's embedded render service is installed (Android; synchronous, cached). */
export function streamyboxAvailable(): boolean {
  return Platform.OS === 'android' && streamyboxInstalled();
}

/** Re-checks the Streamybox render service; `streamyboxAvailable()` returns this answer afterwards. */
export function probeStreamybox(): Promise<boolean> {
  return Platform.OS === 'android' ? probeStreamyboxInstalled() : Promise.resolve(false);
}

export function createEngine(kind: EngineKind, options: EngineOptions = {}): PlayerEngine {
  switch (kind) {
    case 'expo-video':
      return new ExpoVideoEngine();
    case 'vlc':
      return new VlcEngine(options.vlc);
    case 'streamybox':
      return new StreamyboxEngine();
    case 'web':
      throw new Error(`${Platform.OS} has no browser engine`);
  }
}
