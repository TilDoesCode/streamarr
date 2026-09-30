import type { ReactNode } from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

// CSS masks: left and bottom fade, intersected.
const MASK = {
  maskImage:
    'linear-gradient(to right, transparent 0%, black 45%), linear-gradient(to bottom, black 55%, transparent 100%)',
  maskComposite: 'intersect',
  WebkitMaskComposite: 'source-in',
} as unknown as ViewStyle;

/** Hero artwork fading to transparent on the left and bottom, so it melts into the ambient backdrop. */
export function HeroFade({ children, left = true }: { children: ReactNode; left?: boolean }) {
  return <View style={[StyleSheet.absoluteFill, left ? MASK : BOTTOM_MASK]}>{children}</View>;
}

const BOTTOM_MASK = {
  maskImage: 'linear-gradient(to bottom, black 55%, transparent 100%)',
} as unknown as ViewStyle;

const WASH_MASK = {
  maskImage: 'linear-gradient(to bottom, black 60%, transparent 100%)',
} as unknown as ViewStyle;

/** Soft darkening behind the hero copy column: fades out to the right and at the bottom, so it has no edges. */
export function CopyWash({ color }: { color: string }) {
  const gradient = {
    backgroundImage: `linear-gradient(to right, ${color}, ${colors.scrim.clear})`,
  } as unknown as ViewStyle;
  return <View style={[StyleSheet.absoluteFill, WASH_MASK, gradient]} />;
}
