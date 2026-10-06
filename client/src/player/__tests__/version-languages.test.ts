import { missingLanguages, viewerLanguages } from '@/player/version-languages';

const playback = (audio: object[], subtitles: object[]) =>
  ({ mediaInfo: { audioTracks: audio, subtitleTracks: subtitles } }) as never;

describe('the viewer’s languages across another version (S4n, verify P3/P4/P8, C11)', () => {
  it('a forced-only track in the new version is not "has German subtitles": the notice says so (P3)', () => {
    const wanted = viewerLanguages(playback([], [{ index: 3, language: 'de' }]), null, 3);
    expect(
      missingLanguages(wanted, playback([], [{ index: 1, language: 'ger', forced: true }]))
    ).toEqual({ noSubtitle: 'de' });
    expect(missingLanguages(wanted, playback([], [{ index: 1, language: 'ger' }]))).toEqual({});
  });

  it('undetermined languages (und, mul, zxx, mis) are never a preference and never named (P4)', () => {
    for (const code of ['und', 'mul', 'zxx', 'mis', 'UND']) {
      const wanted = viewerLanguages(
        playback([{ index: 1, language: code }], [{ index: 3, language: code }]),
        1,
        3
      );
      expect(wanted).toEqual({ audio: undefined, subtitle: undefined, preferences: {} });
      expect(missingLanguages(wanted, playback([], []))).toEqual({});
    }
  });

  it('a start answer without track lists claims nothing missing (P8)', () => {
    const wanted = viewerLanguages(
      playback([{ index: 1, language: 'de' }], [{ index: 3, language: 'de' }]),
      1,
      3
    );
    expect(missingLanguages(wanted, { mediaInfo: null } as never)).toEqual({});
    expect(missingLanguages(wanted, null)).toEqual({});
  });

  it('a forced subtitle is never sent as the subtitle preference (C11)', () => {
    const wanted = viewerLanguages(
      playback([], [{ index: 5, language: 'de', forced: true }]),
      null,
      5
    );
    expect(wanted.preferences).toEqual({});
    expect(wanted.subtitle).toBeUndefined();
  });

  it.each([
    ['dut', 'nld'],
    ['chi', 'zho'],
    ['cze', 'ces'],
    ['gre', 'ell'],
    ['rum', 'ron'],
    ['slo', 'slk'],
    ['nl', 'dut'],
  ])('%s and %s are one language across muxers (no false "missing")', (from, to) => {
    const wanted = viewerLanguages(playback([], [{ index: 3, language: from }]), null, 3);
    expect(missingLanguages(wanted, playback([], [{ index: 1, language: to }]))).toEqual({});
  });
});
