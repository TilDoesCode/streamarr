import { View, type ViewStyle } from 'react-native';

import { colors, useDesign } from '@/theme';

import { selectGlassMode } from './glass-mode';
import { glassEdge, glassFill } from './glass-style';
import type { GlassProps } from './glass-types';
import { useReduceTransparency } from './use-reduce-transparency';

export type { GlassIntensity, GlassProps } from './glass-types';

const BLUR = { subtle: 30, regular: 36, strong: 40 } as const;

/** Web: CSS backdrop-filter (blur + saturate) with a 1 px top highlight; solid with prefers-reduced-transparency. */
export function Glass({
  interactive: _interactive,
  intensity = 'regular',
  tint,
  radius,
  style,
  children,
  ...props
}: GlassProps) {
  const design = useDesign();
  const reduceTransparency = useReduceTransparency();
  const r = radius ?? design.radius.xl;
  const mode = selectGlassMode({ os: 'web', isTV: false, liquidGlass: false, reduceTransparency });
  const surface: ViewStyle =
    mode === 'solid'
      ? { backgroundColor: colors.glass.solid }
      : ({
          backgroundColor: glassFill(intensity, tint),
          backdropFilter: `blur(${BLUR[intensity]}px) saturate(1.5)`,
          WebkitBackdropFilter: `blur(${BLUR[intensity]}px) saturate(1.5)`,
          boxShadow: `inset 0 1px 0 ${colors.glass.highlight}`,
        } as ViewStyle);
  return (
    <View style={[glassEdge(r), surface, style]} {...props}>
      {children}
    </View>
  );
}
