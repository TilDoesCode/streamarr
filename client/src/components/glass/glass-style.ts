import type { ViewStyle } from 'react-native';

import { withAlpha } from '@/lib/color';
import { colors } from '@/theme';

import type { GlassIntensity } from './glass-types';

const FILL: Record<GlassIntensity, string> = {
  subtle: colors.glass.subtle,
  regular: colors.glass.DEFAULT,
  strong: colors.glass.strong,
};

/** Fill of the non-native glass looks; a tint adds a faint wash on top of the white veil. */
export function glassFill(intensity: GlassIntensity, tint?: string | null): string {
  return tint ? withAlpha(tint, intensity === 'strong' ? 0.24 : 0.16) : FILL[intensity];
}

/** Shared edge: 1 px border with a brighter top highlight; clips by radius only (never overflow: hidden). */
export function glassEdge(radius: number): ViewStyle {
  return {
    borderRadius: radius,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: colors.glass.border,
    borderTopColor: colors.glass.highlight,
  };
}
