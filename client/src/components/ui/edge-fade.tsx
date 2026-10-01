import MaskedView from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import { useState, type ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

const SOLID = colors.foreground.DEFAULT;
const CLEAR = colors.scrim.clear;

export type EdgeFadeProps = {
  /** Fade width at the left edge in points (0: hard edge). */
  start: number;
  /** Fade width at the right edge in points (0: hard edge). */
  end: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** Horizontal soft edges: content fades out where a row continues off screen. */
export function EdgeFade({ start, end, style, children }: EdgeFadeProps) {
  const [width, setWidth] = useState(0);
  if (!width || (!start && !end))
    return (
      <MaskedView
        style={style}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        maskElement={<LinearGradient style={StyleSheet.absoluteFill} colors={[SOLID, SOLID]} />}>
        {children}
      </MaskedView>
    );
  const a = Math.min(0.49, start / width);
  const b = Math.max(0.51, 1 - end / width);
  return (
    <MaskedView
      style={style}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      maskElement={
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[start ? CLEAR : SOLID, SOLID, SOLID, end ? CLEAR : SOLID]}
          locations={[0, a, b, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
        />
      }>
      {children}
    </MaskedView>
  );
}
