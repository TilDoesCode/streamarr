import { composite, contrastRatio, type Rgb } from '@/lib/color';
import { colors } from '@/theme';

import { TV_GLASS, tvGlassBase, tvGlassVeil } from './glass-style';

// Brightest art measured behind the glass on Google TV: Big Buck Bunny's cloud and Sprite Fright's neon.
const ART: Record<string, Rgb> = { bbbSky: [255, 255, 221], spriteNeon: [219, 219, 255] };
const TINTS = [null, '#6FD3E0', '#F2C14E', '#FF4FD8'];

const surface = (art: Rgb, tint: string | null, layers: [string, number][] = []) =>
  layers.reduce(
    (bg, [color, opacity]) => composite(bg, color, opacity),
    composite(composite(art, tvGlassBase(tint)), tvGlassVeil('regular'))
  );

const text = (bg: Rgb, color: string) => contrastRatio(composite(bg, color), bg);

describe('Android TV glass legibility', () => {
  it.each(
    Object.entries(ART).flatMap(([name, art]) =>
      TINTS.map((tint) => [name, String(tint), art, tint] as const)
    )
  )('%s, tint %s: body and muted text stay >= 4.5:1', (_, __, art, tint) => {
    const rail = surface(art, tint);
    expect(text(rail, colors.foreground.DEFAULT)).toBeGreaterThanOrEqual(4.5);
    expect(text(rail, colors.foreground.mutedTv)).toBeGreaterThanOrEqual(4.5);
    // Version panel (lighter smoked underlay on TV): the focused card (lit = glass.DEFAULT).
    const card = surface(art, tint, [
      [colors.glass.tinted, TV_GLASS.panelUnderlay],
      [colors.glass.DEFAULT, 1],
    ]);
    expect(text(card, colors.foreground.mutedTv)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(Object.entries(ART))('%s: subtle glass keeps white text >= 4.5:1', (_, art) => {
    for (const tint of TINTS) {
      const pill = composite(composite(art, tvGlassBase(tint, 'subtle')), tvGlassVeil('subtle'));
      expect(text(pill, colors.foreground.DEFAULT)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('secondary TV text is brighter than the default muted tone', () => {
    expect(colors.foreground.mutedTv).not.toBe(colors.foreground.muted);
  });

  it('is translucent, not opaque', () => {
    expect(tvGlassBase(null)).toMatch(/^rgba\(.*, 0\.7\)$/);
    expect(tvGlassBase('#FF4FD8')).not.toBe(tvGlassBase(null));
  });
});
