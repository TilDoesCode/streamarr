import { LogBox } from 'react-native';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

import { useLiteMode } from './performance-mode';

// The override is intended; Reanimated's dev warning about it would pop up on every toggle.
LogBox.ignoreLogs(['Reduced motion setting is overwritten']);

/** Lite mode: every Reanimated timing, spring and layout animation jumps to its end (mount once at the root). */
export function LiteMotion() {
  return useLiteMode() ? <ReducedMotionConfig mode={ReduceMotion.Always} /> : null;
}
