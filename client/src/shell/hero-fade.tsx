import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { colors } from '@/theme';

const SOLID = colors.foreground.DEFAULT;
const CLEAR = colors.scrim.clear;

/** Hero artwork fading to transparent on the left and bottom, so it melts into the ambient backdrop. */
export function HeroFade({ children, left = true }: { children: ReactNode; left?: boolean }) {
  const bottom = (
    <MaskedView
      style={StyleSheet.absoluteFill}
      maskElement={
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[SOLID, SOLID, CLEAR]}
          locations={[0, 0.55, 1]}
        />
      }>
      {children}
    </MaskedView>
  );
  if (!left) return bottom;
  return (
    <MaskedView
      style={StyleSheet.absoluteFill}
      maskElement={
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[CLEAR, SOLID, SOLID]}
          locations={[0, 0.45, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
        />
      }>
      {bottom}
    </MaskedView>
  );
}

/** Soft darkening behind the hero copy column: fades out to the right and at the bottom, so it has no edges. */
export function CopyWash({ color }: { color: string }) {
  return (
    <MaskedView
      style={StyleSheet.absoluteFill}
      maskElement={
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[SOLID, SOLID, CLEAR]}
          locations={[0, 0.6, 1]}
        />
      }>
      <LinearGradient
        style={StyleSheet.absoluteFill}
        colors={[color, CLEAR]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
      />
    </MaskedView>
  );
}
