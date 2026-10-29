import { act } from '@testing-library/react-native';

import i18n, { setLanguagePreference } from '@/i18n';

import { dolbyVisionLabel, noticeText } from '../overlay-labels';
import type { Playback } from '../playback-api';
import type { PlayerT } from '../use-player-t';

type Untyped = (key: string, options?: Record<string, unknown>) => string;
const pt: PlayerT = (key, options) =>
  (i18n.t as unknown as Untyped)(key, { ...options, ns: 'player' });

type Video = NonNullable<NonNullable<Playback['mediaInfo']>['video']>;
const video = (dolbyVisionProfile?: number, hdr = 'dolbyvision') =>
  ({ codec: 'hevc', hdr, dolbyVisionProfile }) as Video;

afterAll(async () => {
  await act(async () => {
    await setLanguagePreference('en');
  });
});

describe('Streamybox Player labels', () => {
  it('names Dolby Vision, the player and its HDR10 output; Profile 7 as its base layer', async () => {
    await act(async () => {
      await setLanguagePreference('en');
    });
    expect(dolbyVisionLabel(video(8), 'hdr10', pt)).toBe(
      'Dolby Vision · Streamybox Player · HDR10'
    );
    expect(dolbyVisionLabel(video(5), undefined, pt)).toBe(
      'Dolby Vision · Streamybox Player · HDR10'
    );
    expect(dolbyVisionLabel(video(5), 'sdr', pt)).toBe('Dolby Vision · Streamybox Player · SDR');
    expect(dolbyVisionLabel(video(7), 'hdr10', pt)).toBe(
      'HDR10 base layer (Dolby Vision P7) · Streamybox Player'
    );
    expect(dolbyVisionLabel(video(undefined, 'hdr10'), 'hdr10', pt)).toBeNull();
    expect(
      noticeText(
        { kind: 'dolbyVisionFallback' },
        pt,
        () => '',
        () => ''
      )
    ).toBe('The Streamybox Player couldn’t play this, so it continues in the built-in player.');

    await act(async () => {
      await setLanguagePreference('de');
    });
    expect(dolbyVisionLabel(video(7), 'hdr10', pt)).toBe(
      'HDR10-Basis (Dolby Vision P7) · Streamybox Player'
    );
    expect(
      noticeText(
        { kind: 'dolbyVisionFallback' },
        pt,
        () => '',
        () => ''
      )
    ).toBe(
      'Der Streamybox Player konnte das nicht abspielen, daher geht es im integrierten Player weiter.'
    );
  });
});
