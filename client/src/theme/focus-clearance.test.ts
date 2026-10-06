import { createDesign } from './design';
import { clearScale, focusClearance, focusGap } from './focus-clearance';

const ring = { ringOffset: 6, ringWidth: 6, air: 8 };

describe('focus clearance', () => {
  it('adds the growth per side, the scaled ring and the air', () => {
    // 352 wide at 1.1: 17.6 growth + 13.2 ring + 8 air.
    expect(focusClearance(ring, 352, 1.1)).toBe(39);
    expect(focusClearance(ring, 0, 1)).toBe(20);
  });

  it('caps a card lift so its ring stays the air away from a neighbour', () => {
    const scale = clearScale(ring, 352, 32, 1.1);
    expect(scale).toBeGreaterThan(1.05);
    expect(scale).toBeLessThan(1.1);
    expect((352 * (scale - 1)) / 2 + 12 * scale + 8).toBeCloseTo(32);
    expect(clearScale(ring, 208, 32, 1.1)).toBe(1.1);
    expect(clearScale(ring, 100, 4, 1.1)).toBe(1);
  });

  it('gives TV rows of buttons room for the lift and ring on both TV canvases', () => {
    for (const width of [960, 1920]) {
      const { focus } = createDesign('tv', width, (width * 9) / 16);
      const ringOut = (focus.ringOffset + focus.ringWidth) * focus.buttonScale;
      expect(focus.rowGap).toBeGreaterThanOrEqual(focus.buttonGrowth + ringOut + focus.air);
      expect(focus.ringGap).toBe(focus.ringOffset + focus.ringWidth + focus.air);
    }
    expect(createDesign('tv', 1920, 1080).focus.rowGap).toBe(39);
  });

  it('only ever raises a gap', () => {
    const { focus } = createDesign('phone', 390, 844);
    expect(focusGap(focus, 40)).toBe(40);
    expect(focusGap(focus, 0)).toBe(focus.rowGap);
    expect(focusGap(focus, 0, 'ring')).toBe(focus.ringGap);
  });
});

describe('the focus rule on web and tablets (F11 decision: kept, not TV-only)', () => {
  // Keyboard focus on web (:focus-visible) and iPad (hardware keyboard, pointer) draws the same ring.
  it.each(['desktop-web', 'tablet'] as const)(
    '%s raises a row gap to the clearance of its own smaller ring: genre chips 8 -> 12, panel options 4 -> 9',
    (formFactor) => {
      const { focus } = createDesign(formFactor, 1280, 800);
      expect(focusGap(focus, 8, 'row')).toBe(12);
      expect(focusGap(focus, 4, 'ring')).toBe(9);
      expect(focusGap(focus, 16, 'row')).toBe(16);
    }
  );

  it('phones keep their design gaps (no focus ring there)', () => {
    const { focus } = createDesign('phone', 390, 844);
    expect(focusGap(focus, 8, 'row')).toBe(8);
  });
});
