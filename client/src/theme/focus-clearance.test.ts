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
