import type { Version } from '@/browse/queries';
import { sheetSpecs } from '@/browse/version-format';

const hd = (fit: string | null, extra: Partial<Version> = {}) =>
  ({
    rank: 1,
    releaseId: 'hd',
    name: 'Movie.2010.1080p.WEB-DL.H264-GRP',
    resolution: '1080p',
    videoCodec: 'h264',
    recommended: true,
    health: 'ready',
    predictedMethod: 'direct',
    predictedHeight: 1080,
    predictedHdr: 'sdr',
    bandwidthFit: fit,
    ...extra,
  }) as Version;
const uhd = (fit: string | null) =>
  ({
    rank: 2,
    releaseId: 'uhd',
    name: 'Movie.2010.2160p.UHD.BluRay.REMUX.HEVC.HDR10-GRP',
    resolution: '2160p',
    videoCodec: 'hevc',
    hdr: 'hdr10',
    hdrFormats: ['hdr10'],
    health: 'ready',
    predictedMethod: 'direct',
    predictedHeight: 2160,
    predictedHdr: 'hdr10',
    bandwidthFit: fit,
  }) as Version;

describe('why Play starts less than the device shows: the recommended version’s own bitrate fit', () => {
  it.each([
    ['ok', 'bandwidth'],
    ['tight', 'bandwidthTight'],
    ['unknown', undefined],
    [null, undefined],
  ])('recommended %s, sharper one too fast → %s', (fit, why) => {
    expect(sheetSpecs([hd(fit), uhd('tooHigh')])?.recommended).toEqual({
      picture: '1080p · SDR',
      why,
    });
  });

  it('no sharper version too fast: the other reasons stay', () => {
    expect(sheetSpecs([hd('tight', { local: 'ready' }), uhd('ok')])?.recommended?.why).toBe(
      'local'
    );
    expect(sheetSpecs([hd('ok', { affinity: true }), uhd(null)])?.recommended?.why).toBe(
      'affinity'
    );
  });

  it('an unknown fit falls back to the other reasons', () => {
    expect(sheetSpecs([hd('unknown', { local: 'ready' }), uhd('tooHigh')])?.recommended?.why).toBe(
      'local'
    );
  });
});
