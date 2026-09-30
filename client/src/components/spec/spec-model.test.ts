import { methodTone, specChips, versionSignal } from './spec-model';

describe('specChips', () => {
  it('orders resolution, HDR, codec, audio and drops empties', () => {
    expect(specChips({ resolution: '4K', hdr: 'DV', videoCodec: 'HEVC', audio: 'Atmos' })).toEqual([
      '4K',
      'DV',
      'HEVC',
      'Atmos',
    ]);
    expect(specChips({ resolution: '1080p', hdr: null, videoCodec: 'H.264', audio: ' ' })).toEqual([
      '1080p',
      'H.264',
    ]);
  });
  it('renders nothing while the server has no spec', () => {
    expect(specChips(null)).toEqual([]);
    expect(specChips(undefined)).toEqual([]);
    expect(specChips({})).toEqual([]);
  });
});

describe('methodTone', () => {
  it.each([
    ['direct', 'ok'],
    ['vlc', 'ok'],
    ['remux', 'info'],
    ['transcode', 'warn'],
    ['unknown', 'neutral'],
    [null, 'neutral'],
  ])('%s → %s', (method, tone) => {
    expect(methodTone(method)).toBe(tone);
  });
});

describe('versionSignal', () => {
  it('prefers the local state over health', () => {
    expect(versionSignal({ health: 'degraded', local: 'ready' })).toEqual({ level: 4, tone: 'ok' });
    expect(versionSignal({ health: 'ready', local: 'downloading' })).toEqual({
      level: 2,
      tone: 'info',
    });
  });
  it('maps health to 4 or 2 bars and unknown to nothing', () => {
    expect(versionSignal({ health: 'ready' })).toEqual({ level: 4, tone: 'ok' });
    expect(versionSignal({ health: 'degraded' })).toEqual({ level: 2, tone: 'warn' });
    expect(versionSignal({ health: 'unknown' })).toBeNull();
    expect(versionSignal({})).toBeNull();
  });
});
