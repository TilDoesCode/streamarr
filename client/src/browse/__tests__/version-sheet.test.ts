import type { Version } from '@/browse/queries';
import { sheetSpecs } from '@/browse/version-format';
import { sheetEntryIndex } from '@/browse/version-sheet';

const v = (rank: number, extra: Partial<Version> = {}) =>
  ({ rank, releaseId: `r${rank}`, recommended: false, ...extra }) as Version;

describe('version sheet entry', () => {
  it('focuses Recommended, else the last played, else the first card', () => {
    expect(sheetEntryIndex([v(1), v(2, { recommended: true })], 'r1')).toBe(1);
    expect(sheetEntryIndex([v(1), v(2), v(3)], 'r3')).toBe(2);
    expect(sheetEntryIndex([v(1), v(2)], 'gone')).toBe(0);
    expect(sheetEntryIndex([], null)).toBe(0);
  });
});

describe('version sheet specs', () => {
  it('names the best picture and what plays here, SDR included', () => {
    const list = [
      v(1, { resolution: '2160p', hdrFormats: ['hdr10'], qualityRank: 1 }),
      v(2, { resolution: '1080p', qualityRank: 2, recommended: true }),
    ];
    expect(sheetSpecs(list)).toEqual({ best: '4K · HDR10', here: '1080p · SDR' });
  });

  it('shows both specs also when the best version plays here', () => {
    expect(sheetSpecs([v(1, { resolution: '1080p', recommended: true })])).toEqual({
      best: '1080p · SDR',
      here: '1080p · SDR',
    });
  });

  it('has no header without versions or resolutions', () => {
    expect(sheetSpecs([])).toBeUndefined();
    expect(sheetSpecs([v(1)])).toBeUndefined();
  });
});
