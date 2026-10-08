import { Platform, View } from 'react-native';

import { useAmbientTitle } from '@/components/ambient/ambient-provider';
import { colors, theme, useDesign } from '@/theme';

import { selectGlassMode } from './glass-mode';
import { glassEdge, glassFill, glassHighlight, tvGlassBase, tvGlassVeil } from './glass-style';
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
  // Android TV: glass without its own highlight is sized for the art painting the room.
  const highlight = glassHighlight(artHighlight, useAmbientTitle());
  const mode = selectGlassMode({
    os: Platform.OS,
    isTV: Platform.isTV === true,
    liquidGlass: false,
    reduceTransparency: false,
  });
  const sbx = theme === 'streamybox';
  const base = sbx
    ? intensity === 'strong'
      ? colors.secondary.DEFAULT
      : colors.glass.tinted
    : mode === 'tinted'
      ? tvGlassBase(tint, intensity, highlight)
      : mode === 'solid'
        ? colors.glass.solid
        : colors.glass.tinted;
  const fill = sbx
    ? colors.scrim.clear
    : mode === 'tinted'
      ? tvGlassVeil(intensity)
      : glassFill(intensity, tint);
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
