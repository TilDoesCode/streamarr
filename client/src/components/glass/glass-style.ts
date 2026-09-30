import type { ViewStyle } from 'react-native';

import { mixHex, withAlpha } from '@/lib/color';
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

/** Android TV glass without runtime blur: a smoked, tint-mixed base that keeps text legible over white art. */
export const TV_GLASS = {
  alpha: 0.7,
  /** Subtle surfaces carry only icons and white text (rail, now-playing pill). */
  subtleAlpha: 0.66,
  /** A lighter veil so a dark icon-only surface still reads as glass over dark ambient. */
  subtleVeil: 0.04,
  tintMix: 0.12,
  veil: 0.03,
  panelUnderlay: 0.3,
} as const;

export function tvGlassBase(tint?: string | null, intensity: GlassIntensity = 'regular'): string {
  const base = tint ? mixHex(tint, colors.background, TV_GLASS.tintMix) : colors.background;
  return withAlpha(base, intensity === 'subtle' ? TV_GLASS.subtleAlpha : TV_GLASS.alpha);
}

export function tvGlassVeil(intensity: GlassIntensity): string {
  const veil =
    intensity === 'subtle' ? TV_GLASS.subtleVeil : TV_GLASS.veil * (intensity === 'strong' ? 2 : 1);
  return withAlpha(colors.foreground.DEFAULT, veil);
}
