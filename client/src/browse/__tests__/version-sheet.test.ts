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

  it('names the best picture by picture quality and what this device gets of the recommendation', () => {
    // Photo 06: "Bestes Bild 1080p | Auf diesem Gerät 4K" – language points had made the 1080p the "best".
    const list = [
      v(1, {
        resolution: '2160p',
        hdrFormats: ['dolbyvision', 'hdr10'],
        qualityRank: 2,
        recommended: true,
        predictedMethod: 'transcode',
        predictionReasons: [{ code: 'hdr_unsupported', params: { hdr: 'hdr10' } }],
      }),
      v(2, { resolution: '1080p', qualityRank: 1 }),
    ];
    expect(sheetSpecs(list)).toEqual({ best: '4K · Dolby Vision', here: '4K · SDR' });
  });

  it('shows the HDR10 base layer a Dolby Vision version plays with on an HDR10 screen', () => {
    const list = [
      v(1, {
        resolution: '2160p',
        hdrFormats: ['dolbyvision', 'hdr10'],
        recommended: true,
        predictedMethod: 'direct',
        predictedHeight: 2160,
        predictedHdr: 'hdr10',
      }),
    ];
    expect(sheetSpecs(list)).toEqual({ best: '4K · Dolby Vision', here: '4K · HDR10' });
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
