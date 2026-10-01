import { BlurView } from 'expo-blur';
import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Platform, View } from 'react-native';

import { withAlpha } from '@/lib/color';
import { colors, useDesign } from '@/theme';

import { selectGlassMode } from './glass-mode';
import { glassEdge } from './glass-style';
import type { GlassProps } from './glass-types';
import { useReduceTransparency } from './use-reduce-transparency';

export type { GlassIntensity, GlassProps } from './glass-types';

const LIQUID = isLiquidGlassAvailable() && isGlassEffectAPIAvailable();
const BLUR_INTENSITY = { subtle: 40, regular: 60, strong: 80 } as const;

/** iOS/tvOS: real Liquid Glass (iOS 26), system material blur below, solid with Reduce Transparency. */
export function Glass({
  interactive = false,
  intensity = 'regular',
  tint,
  artHighlight: _artHighlight,
  radius,
  style,
  children,
  ...props
}: GlassProps) {
  const design = useDesign();
  const reduceTransparency = useReduceTransparency();
  const r = radius ?? design.radius.xl;
  const mode = selectGlassMode({
    os: Platform.OS,
    isTV: Platform.isTV === true,
    liquidGlass: LIQUID,
    reduceTransparency,
  });
  const shape = { borderRadius: r, borderCurve: 'continuous' as const };

  if (mode === 'liquid') {
    return (
      <GlassView
        glassEffectStyle={intensity === 'subtle' ? 'clear' : 'regular'}
        isInteractive={interactive}
        colorScheme="dark"
        tintColor={tint ? withAlpha(tint, 0.35) : undefined}
        style={[shape, style]}
        {...props}>
        {children}
      </GlassView>
    );
  }
  if (mode === 'blur') {
    return (
      <BlurView
        tint="systemMaterialDark"
        intensity={BLUR_INTENSITY[intensity]}
        style={[shape, { overflow: 'hidden' }, style]}
        {...props}>
        {children}
      </BlurView>
    );
  }
  return (
    <View style={[glassEdge(r), { backgroundColor: colors.glass.solid }, style]} {...props}>
      {children}
    </View>
  );
}
