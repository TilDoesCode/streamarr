import { LogBox } from 'react-native';
import { ReducedMotionConfig, ReduceMotion } from 'react-native-reanimated';

import { systemAnimationsOff } from './motion-policy';

// The override is intended; Reanimated's dev warning about it would pop up on every launch.
LogBox.ignoreLogs(['Reduced motion setting is overwritten']);

/** System animations removed: every Reanimated animation jumps to its end. Lite mode alone keeps motion (useMotionPolicy decides per effect). */
export function MotionConfig() {
  return systemAnimationsOff ? <ReducedMotionConfig mode={ReduceMotion.Always} /> : null;
}
