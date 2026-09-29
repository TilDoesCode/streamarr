import type { EngineKind, PlayerEngine } from './types';
import { createWebEngine } from './web-engine';

export type { EngineKind, EngineEvent, EngineSnapshot, EngineTrack, PlayerEngine } from './types';
export type EngineOptions = { vlc?: { directRendering?: boolean } };

/** Technical engine names (not UI copy). */
export const ENGINE_LABELS: Record<EngineKind, string> = {
  'expo-video': 'expo-video',
  vlc: 'VLC',
  web: 'HTML5',
};

/** Candidates for the server's `native` engine on this platform. */
export function nativeCandidates(): EngineKind[] {
  return ['web'];
}

export function vlcAvailable(): boolean {
  return false;
}

export function createEngine(kind: EngineKind, _options: EngineOptions = {}): PlayerEngine {
  if (kind !== 'web') throw new Error(`The browser has no ${kind} engine`);
  return createWebEngine();
}
