import { composite, contrastRatio, type Rgb } from '@/lib/color';

import { SPEC_TONES } from './spec-label';

const BACKDROPS: Rgb[] = [
  [255, 255, 255],
  [255, 255, 221],
  [219, 219, 255],
  [10, 12, 18],
];

describe('spec chip tones', () => {
  it.each(Object.entries(SPEC_TONES))(
    '%s chip text stays >= 4.5:1 over any backdrop',
    (_, tone) => {
      for (const backdrop of BACKDROPS) {
        const fill = composite(backdrop, tone.bg);
        expect(contrastRatio(composite(fill, tone.fg), fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  );
});
