import { act } from '@testing-library/react-native';

import i18n, { setLanguagePreference } from '@/i18n';

import { toStats } from '../engines/native-probe';
import { audioOutputLabel } from '../overlay-labels';
import type { PlayerT } from '../use-player-t';

const pt: PlayerT = (key, options) => i18n.t(key, { ...options, ns: 'player' });

describe('audio output stats (ROCK 4D, task audio)', () => {
  it('reads the AudioTrack format and the sink counters of the patched ExoPlayer', () => {
    expect(
      toStats({
        decoderName: 'c2.rk.hevc.decoder',
        audioEncoding: 'eac3',
        audioChannels: 6,
        audioUnderruns: 4,
        audioResyncs: 1,
        audioSinkErrors: 0,
      })
    ).toEqual({
      decoder: 'c2.rk.hevc.decoder',
      audioEncoding: 'eac3',
      audioChannels: 6,
      audioUnderruns: 4,
      audioResyncs: 1,
    });
    // Before the AudioTrack exists only the counters are known.
    expect(toStats({ audioUnderruns: 0, audioResyncs: 0 })).toEqual({
      audioUnderruns: 0,
      audioResyncs: 0,
    });
  });

  it('labels decoded PCM, bitstreams and dropouts in both languages', async () => {
    await act(async () => {
      await setLanguagePreference('en');
    });
    expect(audioOutputLabel({ audioEncoding: 'pcm', audioChannels: 2 }, pt)).toBe('PCM 2.0');
    expect(
      audioOutputLabel({ audioEncoding: 'truehd', audioChannels: 8, audioUnderruns: 1 }, pt)
    ).toBe('Bitstream TrueHD · 1 dropout');
    expect(
      audioOutputLabel(
        { audioEncoding: 'pcm', audioChannels: 6, audioUnderruns: 3, audioResyncs: 2 },
        pt
      )
    ).toBe('PCM 5.1 · 3 dropouts · 2 resyncs');
    expect(audioOutputLabel({ audioUnderruns: 3 }, pt)).toBeNull();

    await act(async () => {
      await setLanguagePreference('de');
    });
    expect(
      audioOutputLabel({ audioEncoding: 'eac3', audioUnderruns: 2, audioResyncs: 1 }, pt)
    ).toBe('Bitstream Dolby Digital+ · 2 Aussetzer · 1 Neusynchronisierung');
    await act(async () => {
      await setLanguagePreference('en');
    });
  });
});
