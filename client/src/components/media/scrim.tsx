import { LinearGradient } from 'expo-linear-gradient';
import type { StyleProp, ViewStyle } from 'react-native';

import { colors } from '@/theme';

const DIRECTIONS = {
  up: { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } },
  right: { start: { x: 1, y: 0 }, end: { x: 0, y: 0 } },
} as const;

export type ScrimProps = {
  /** Side the darkness grows towards: 'up' darkens the bottom edge. */
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
