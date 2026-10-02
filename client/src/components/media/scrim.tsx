import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { withAlpha } from '@/lib/color';
import { colors } from '@/theme';

const DIRECTIONS = {
  up: { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
  down: { start: { x: 0, y: 1 }, end: { x: 0, y: 0 } },
  right: { start: { x: 1, y: 0 }, end: { x: 0, y: 0 } },
} as const;

export type ScrimProps = {
  /** Side the darkness grows towards: 'up' darkens the bottom edge, 'down' the top edge. */
  direction?: keyof typeof DIRECTIONS;
  /** Colour at the dark end (default: page background, for seamless blends). */
  color?: string;
  style?: StyleProp<ViewStyle>;
};

/** Legibility gradient over artwork. */
export function Scrim({ direction = 'up', color = colors.background, style }: ScrimProps) {
  return (
    <LinearGradient
      colors={[colors.scrim.clear, color]}
      {...DIRECTIONS[direction]}
      style={[{ pointerEvents: 'none' }, style]}
    />
  );
}

export function useStatusBarScrimHeight(): number {
  return useSafeAreaInsets().top + 32;
}

/** Edge-to-edge phone screens: keeps the status bar legible over art and content scrolling beneath it. */
export function StatusBarScrim({ style }: { style?: StyleProp<ViewStyle> }) {
  const height = useStatusBarScrimHeight();
  return (
    <Scrim
      direction="down"
      color={withAlpha(colors.background, 0.8)}
      style={[{ position: 'absolute', left: 0, right: 0, top: 0, height }, style]}
    />
  );
}
