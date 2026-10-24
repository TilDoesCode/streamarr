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

  // The user's Google TV photos: 4K HDR10 played directly, yet the header said "Auf diesem Gerät 1080p · SDR".
  const hdr4k = (rank: number, extra: Partial<Version> = {}) =>
    v(rank, {
      resolution: '2160p',
      hdrFormats: ['hdr10'],
      predictedMethod: 'direct',
      predictedHeight: 2160,
      predictedHdr: 'hdr10',
      ...extra,
    });
  const direct1080 = (rank: number, extra: Partial<Version> = {}) =>
    v(rank, {
      resolution: '1080p',
      predictedMethod: 'direct',
      predictedHeight: 1080,
      predictedHdr: 'sdr',
      ...extra,
    });

  it('names the best picture this device shows of any version, not only of the recommended one', () => {
    expect(sheetSpecs([hdr4k(1, { recommended: true }), direct1080(2)])).toEqual({
      best: '4K · HDR10',
      here: '4K · HDR10',
    });
    expect(sheetSpecs([direct1080(1, { recommended: true }), hdr4k(2)])).toEqual({
      best: '4K · HDR10',
      here: '4K · HDR10',
      recommended: { picture: '1080p · SDR', why: undefined },
    });
  });

  it('says why Play starts less than the device shows: downloaded or like last time', () => {
    expect(
      sheetSpecs([direct1080(1, { recommended: true, local: 'ready' }), hdr4k(2)])?.recommended
    ).toEqual({
      picture: '1080p · SDR',
      why: 'local',
    });
    expect(
      sheetSpecs([direct1080(1, { recommended: true, affinity: true }), hdr4k(2)])?.recommended
    ).toEqual({
      picture: '1080p · SDR',
      why: 'affinity',
    });
  });

  it('names a bandwidth limit when the sharper versions exceed it', () => {
    const limited = hdr4k(2, {
      predictedMethod: 'transcode',
      predictionReasons: [{ code: 'bitrate_exceeds_limit', params: { max: '8000' } }],
    });
    expect(sheetSpecs([direct1080(1, { recommended: true }), limited])).toEqual({
      best: '4K · HDR10',
      here: '1080p · SDR',
      bandwidthLimited: '4K',
    });
  });

  it('has no header without versions or resolutions', () => {
    expect(sheetSpecs([])).toBeUndefined();
    expect(sheetSpecs([v(1)])).toBeUndefined();
  });
});
