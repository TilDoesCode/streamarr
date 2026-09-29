import { Platform } from 'react-native';

import type { FormFactor } from './tokens';

export type FormFactorInput = {
  os: string;
  isTV: boolean;
  isPad: boolean;
  width: number;
  height: number;
  /** Web only: primary pointer is a mouse/trackpad. */
  finePointer: boolean;
};

/** Android TV lays out on a 960 dp wide canvas; the TV ramp is authored against it. */
export const TV_CANVAS_WIDTH = 960;

export function detectFormFactor({
  os,
  isTV,
  isPad,
  width,
  height,
  finePointer,
}: FormFactorInput): FormFactor {
  if (isTV) return 'tv';
  const shortest = Math.min(width, height);
  if (os === 'web') {
    if (width < 640) return 'phone';
    return finePointer ? 'desktop-web' : 'tablet';
  }
  if (isPad) return shortest >= 500 ? 'tablet' : 'phone';
  return shortest >= 600 ? 'tablet' : 'phone';
}

export function tvScale(width: number): number {
  return Math.max(1, width / TV_CANVAS_WIDTH);
}

export function hasFinePointer(): boolean {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(pointer: fine)').matches;
}
