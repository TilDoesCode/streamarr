import type { ViewStyle } from 'react-native';

import {
  composite,
  contrastRatio,
  mixHex,
  parseColor,
  validHex,
  withAlpha,
  type Rgb,
} from '@/lib/color';
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
  alpha: 0.64,
  /** Subtle surfaces carry only icons and white text (rail, now-playing pill). */
  subtleAlpha: 0.62,
  /** A lighter veil so a dark icon-only surface still reads as glass over dark ambient. */
  subtleVeil: 0.04,
  tintMix: 0.06,
  veil: 0.03,
  panelUnderlay: 0.3,
  /** Per-title glass never goes clearer than this: the surface and its focus ring stay readable as glass. */
  alphaFloor: 0.36,
} as const;

export function tvGlassBase(
  tint?: string | null,
  intensity: GlassIntensity = 'regular',
  artHighlight?: string | null
): string {
  const base = tint ? mixHex(tint, colors.background, TV_GLASS.tintMix) : colors.background;
  return withAlpha(base, tvGlassAlpha(artHighlight, tint, intensity));
}

export type TvTextStyle = { name: string; color: string; size: number; bold?: boolean };

/** WCAG at the 1920 design scale: large = >= 24 px regular or >= 18.66 px bold -> 3:1, else 4.5:1. */
export const minContrast = ({ size, bold }: Pick<TvTextStyle, 'size' | 'bold'>) =>
  size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;

/** Text drawn on TV glass at the 1920 scale (shell-rail.tsx, version-panel.tsx, glass pills and buttons). */
export const TV_GLASS_TEXT = {
  plain: [
    { name: 'label', color: colors.foreground.DEFAULT, size: 20 },
    { name: 'muted', color: colors.foreground.mutedTv, size: 20 },
  ],
  card: [
    { name: 'panel title', color: colors.foreground.DEFAULT, size: 44, bold: true },
    { name: 'card resolution', color: colors.foreground.DEFAULT, size: 30, bold: true },
    { name: 'card name', color: colors.foreground.DEFAULT, size: 20 },
    { name: 'card muted', color: colors.foreground.mutedTv, size: 18 },
    { name: 'card reason', color: colors.foreground.mutedTv, size: 17 },
  ],
} satisfies Record<string, TvTextStyle[]>;

/** The version panel's smoked underlay shrinks with the per-title glass (TV_GLASS.panelUnderlay at the constant). */
export const tvPanelUnderlay = (alpha: number) => (TV_GLASS.panelUnderlay * alpha) / TV_GLASS.alpha;

/** Layers a version card adds on top of the panel glass (smoked underlay, lit card). */
export const tvPanelCardLayers = (alpha: number): [string, number][] => [
  [colors.glass.tinted, tvPanelUnderlay(alpha)],
  [colors.glass.DEFAULT, 1],
];

const textRatio = (bg: Rgb, color: string) => contrastRatio(composite(bg, color), bg);

/** Opaque colour of TV glass at `alpha` over `art`, plus optional layers on top. */
export function tvGlassSurface(
  art: Rgb,
  alpha: number,
  tint: string | null | undefined,
  intensity: GlassIntensity,
  layers: [string, number][] = []
): Rgb {
  const base = tint ? mixHex(tint, colors.background, TV_GLASS.tintMix) : colors.background;
  const glass = composite(composite(art, withAlpha(base, alpha)), tvGlassVeil(intensity));
  return layers.reduce((bg, [color, opacity]) => composite(bg, color, opacity), glass);
}

/** True when every text style that sits on this glass keeps its WCAG threshold over `art`. */
export function tvGlassLegible(
  art: Rgb,
  alpha: number,
  tint: string | null | undefined,
  intensity: GlassIntensity
): boolean {
  const plain = tvGlassSurface(art, alpha, tint, intensity);
  if (!TV_GLASS_TEXT.plain.every((t) => textRatio(plain, t.color) >= minContrast(t))) return false;
  if (intensity === 'subtle') return true;
  const card = tvGlassSurface(art, alpha, tint, intensity, tvPanelCardLayers(alpha));
  return TV_GLASS_TEXT.card.every((t) => textRatio(card, t.color) >= minContrast(t));
}

const alphaCache = new Map<string, number>();

/**
 * Smallest glass alpha that keeps every text style legible over the title's art highlight (docs/api.md
 * "Art highlight"), between a floor that keeps the glass and focus ring readable and today's constants.
 */
export function tvGlassAlpha(
  artHighlight: string | null | undefined,
  tint?: string | null,
  intensity: GlassIntensity = 'regular'
): number {
  const ceiling = intensity === 'subtle' ? TV_GLASS.subtleAlpha : TV_GLASS.alpha;
  const hex = validHex(artHighlight);
  if (!hex) return ceiling;
  const key = `${hex}|${tint ?? ''}|${intensity}`;
  const cached = alphaCache.get(key);
  if (cached !== undefined) return cached;
  const art = parseColor(hex)?.rgb ?? [255, 255, 255];
  let alpha: number = ceiling;
  for (let a: number = TV_GLASS.alphaFloor; a < ceiling; a = Math.round((a + 0.01) * 100) / 100)
    if (tvGlassLegible(art, a, tint, intensity)) {
      alpha = a;
      break;
    }
  alphaCache.set(key, alpha);
  return alpha;
}

export function tvGlassVeil(intensity: GlassIntensity): string {
  const veil =
    intensity === 'subtle' ? TV_GLASS.subtleVeil : TV_GLASS.veil * (intensity === 'strong' ? 2 : 1);
  return withAlpha(colors.foreground.DEFAULT, veil);
}
