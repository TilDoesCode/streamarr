import { Platform, View } from 'react-native';

import { colors, useDesign } from '@/theme';

import { selectGlassMode } from './glass-mode';
import { glassEdge, glassFill, tvGlassBase, tvGlassVeil } from './glass-style';
import type { GlassProps } from './glass-types';

export type { GlassIntensity, GlassProps } from './glass-types';

/** Android: translucent tinted surface on phones/tablets, smoked tinted surface on Android TV (no runtime blur). */
export function Glass({
  interactive: _interactive,
  intensity = 'regular',
  tint,
  artHighlight,
  radius,
  style,
  children,
  ...props
}: GlassProps) {
  const design = useDesign();
  const r = radius ?? design.radius.xl;
  const mode = selectGlassMode({
    os: Platform.OS,
    isTV: Platform.isTV === true,
    liquidGlass: false,
    reduceTransparency: false,
  });
  const base =
    mode === 'tinted'
      ? tvGlassBase(tint, intensity, artHighlight)
      : mode === 'solid'
        ? colors.glass.solid
        : colors.glass.tinted;
  const fill = mode === 'tinted' ? tvGlassVeil(intensity) : glassFill(intensity, tint);
  return (
    <View style={[glassEdge(r), { backgroundColor: base }, style]} {...props}>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          borderRadius: r,
          backgroundColor: fill,
        }}
      />
      {children}
    </View>
  );
}
