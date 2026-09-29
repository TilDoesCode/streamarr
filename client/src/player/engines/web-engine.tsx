import type { PlayerEngine } from './types';

/** Native builds never use the browser engine; see web-engine.web.tsx. */
export function prefersNativeHls(): boolean {
  return false;
}

export function createWebEngine(): PlayerEngine {
  throw new Error('The web engine only runs in a browser');
}
