import { composite, contrastRatio, type Rgb } from '@/lib/color';
import { colors } from '@/theme';

import {
  minContrast,
  TV_GLASS,
  TV_GLASS_TEXT,
  tvGlassAlpha,
  tvGlassBase,
  tvGlassLegible,
  tvGlassSurface,
  tvGlassVeil,
  tvPanelCardLayers,
  tvPanelUnderlay,
  type TvTextStyle,
} from './glass-style';

// Brightest art measured behind the glass on Google TV: Big Buck Bunny's cloud and Sprite Fright's neon.
const ART: Record<string, Rgb> = { bbbSky: [255, 255, 221], spriteNeon: [219, 219, 255] };
const TINTS = [null, '#6FD3E0', '#F2C14E', '#FF4FD8'];

type TextStyle = TvTextStyle;

const RAIL: TextStyle[] = TV_GLASS_TEXT.plain;
const PANEL: TextStyle[] = TV_GLASS_TEXT.card;
const SUBTLE: TextStyle[] = [{ name: 'pill', color: colors.foreground.DEFAULT, size: 20 }];

const surface = (art: Rgb, tint: string | null, layers: [string, number][] = []) =>
  layers.reduce(
    (bg, [color, opacity]) => composite(bg, color, opacity),
    composite(composite(art, tvGlassBase(tint)), tvGlassVeil('regular'))
  );

const ratio = (bg: Rgb, color: string) => contrastRatio(composite(bg, color), bg);

const cases = (styles: TextStyle[]) =>
  Object.entries(ART).flatMap(([art, rgb]) =>
    TINTS.flatMap((tint) =>
      styles.map((style) => [style.name, art, String(tint), rgb, tint, style] as const)
    )
  );

describe('Android TV glass legibility per text style', () => {
  it('classifies large text by the WCAG rule', () => {
    expect(minContrast({ size: 20 })).toBe(4.5);
    expect(minContrast({ size: 24 })).toBe(3);
    expect(minContrast({ size: 19, bold: true })).toBe(3);
    expect(minContrast({ size: 18, bold: true })).toBe(4.5);
  });

  it.each(cases(RAIL))('%s over %s, tint %s', (_, __, ___, art, tint, style) => {
    expect(ratio(surface(art, tint), style.color)).toBeGreaterThanOrEqual(minContrast(style));
  });

  it.each(cases(PANEL))('%s (focused card) over %s, tint %s', (_, __, ___, art, tint, style) => {
    // Version panel: lighter smoked underlay on TV, the focused card lit with glass.DEFAULT.
    const card = surface(art, tint, [
      [colors.glass.tinted, TV_GLASS.panelUnderlay],
      [colors.glass.DEFAULT, 1],
    ]);
    expect(ratio(card, style.color)).toBeGreaterThanOrEqual(minContrast(style));
  });

  it.each(cases(SUBTLE))('%s on subtle glass over %s, tint %s', (_, __, ___, art, tint, style) => {
    const pill = composite(composite(art, tvGlassBase(tint, 'subtle')), tvGlassVeil('subtle'));
    expect(ratio(pill, style.color)).toBeGreaterThanOrEqual(minContrast(style));
  });

  it('secondary TV text is brighter than the default muted tone', () => {
    expect(colors.foreground.mutedTv).not.toBe(colors.foreground.muted);
  });

  it('is clearer than the F2 glass (0.7 / 0.66) and still translucent', () => {
    expect(TV_GLASS.alpha).toBeLessThan(0.7);
    expect(TV_GLASS.subtleAlpha).toBeLessThan(0.66);
    expect(tvGlassBase(null)).toMatch(/^rgba\(.*, 0\.64\)$/);
    expect(tvGlassBase('#FF4FD8')).not.toBe(tvGlassBase(null));
  });
});

// Dev World `highlight` values (B3, docs/api.md "Art highlight"), bright to dark.
const HIGHLIGHTS = {
  bbb: '#F6EDE6',
  tearsOfSteel: '#E0DDD0',
  notld: '#D1EEE6',
  elephantsDream: '#B1BCB6',
  sintel: '#AF9C9D',
  sherlock: '#9CA298',
  wingIt: '#869BA2',
  pioneerOne: '#6C6D72',
};
const hex = (value: string): Rgb => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16),
];
const perTitle = Object.entries(HIGHLIGHTS).flatMap(([title, highlight]) =>
  TINTS.flatMap((tint) =>
    (['regular', 'subtle'] as const).map(
      (intensity) => [title, String(tint), intensity, highlight, tint] as const
    )
  )
);

describe('Android TV glass per title (art highlight)', () => {
  it.each(perTitle)(
    '%s, tint %s, %s: every text style passes',
    (_, __, intensity, highlight, tint) => {
      const alpha = tvGlassAlpha(highlight, tint, intensity);
      const art = hex(highlight);
      const ceiling = intensity === 'subtle' ? TV_GLASS.subtleAlpha : TV_GLASS.alpha;
      expect(alpha).toBeGreaterThanOrEqual(TV_GLASS.alphaFloor);
      expect(alpha).toBeLessThanOrEqual(ceiling);
      const plain = tvGlassSurface(art, alpha, tint, intensity);
      for (const style of RAIL)
        expect(ratio(plain, style.color)).toBeGreaterThanOrEqual(minContrast(style));
      if (intensity === 'regular') {
        const card = tvGlassSurface(art, alpha, tint, intensity, tvPanelCardLayers(alpha));
        for (const style of PANEL)
          expect(ratio(card, style.color)).toBeGreaterThanOrEqual(minContrast(style));
      }
      // Smallest: one step clearer fails (unless already at the floor).
      if (alpha > TV_GLASS.alphaFloor && alpha < ceiling)
        expect(tvGlassLegible(art, alpha - 0.01, tint, intensity)).toBe(false);
    }
  );

  it('bright art stays near the constant, dark art gets clearly clearer glass', () => {
    expect(tvGlassAlpha(HIGHLIGHTS.bbb)).toBeGreaterThanOrEqual(0.55);
    expect(tvGlassAlpha(HIGHLIGHTS.pioneerOne)).toBeLessThanOrEqual(0.45);
    expect(tvGlassAlpha(HIGHLIGHTS.sherlock)).toBeLessThan(tvGlassAlpha(HIGHLIGHTS.bbb));
  });

  it('falls back to the constants without a (valid) highlight', () => {
    expect(tvGlassAlpha(null)).toBe(TV_GLASS.alpha);
    expect(tvGlassAlpha(undefined, null, 'subtle')).toBe(TV_GLASS.subtleAlpha);
    expect(tvGlassAlpha('not-a-colour')).toBe(TV_GLASS.alpha);
    expect(tvGlassBase(null, 'regular', null)).toBe(tvGlassBase(null));
    expect(tvGlassBase(null, 'regular', HIGHLIGHTS.pioneerOne)).not.toBe(tvGlassBase(null));
    expect(tvPanelUnderlay(tvGlassAlpha(null))).toBe(TV_GLASS.panelUnderlay);
  });
});
