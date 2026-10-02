import { audioErrorCode } from '../engines/hls-audio-error';
import type { EngineTrack } from '../engines/types';
import {
  engineTrackFor,
  primaryLanguage,
  renditionFor,
  renditionOfTrack,
  type AudioRendition,
} from '../audio-renditions';
import type { Playback } from '../playback-api';

const de: AudioRendition = {
  id: '1',
  streamIndex: 1,
  language: 'de',
  label: 'Deutsch · AAC 2.0',
  channels: 2,
  codec: 'aac',
  default: true,
};
const en: AudioRendition = {
  ...de,
  id: '2',
  streamIndex: 2,
  language: 'en',
  label: 'English · AAC 2.0',
  default: false,
};
const renditions = [de, en];
const track = (id: string, label: string, language?: string): EngineTrack => ({
  id,
  label,
  language,
  selected: false,
});

describe('primaryLanguage', () => {
  it('reduces BCP-47 tags to the primary subtag and drops und', () => {
    expect(primaryLanguage('de-DE')).toBe('de');
    expect(primaryLanguage('EN')).toBe('en');
    expect(primaryLanguage('und')).toBe('');
    expect(primaryLanguage(undefined)).toBe('');
  });
});

describe('engineTrackFor', () => {
  it('matches the rendition NAME, not the engine order', () => {
    const tracks = [track('a', 'English · AAC 2.0', 'en'), track('b', 'Deutsch · AAC 2.0', 'de')];
    expect(engineTrackFor(de, renditions, tracks)?.id).toBe('b');
    expect(engineTrackFor(en, renditions, tracks)?.id).toBe('a');
  });

  it('falls back to the language when the engine renames tracks (AVPlayer, ExoPlayer)', () => {
    const tracks = [track('x', 'English', 'en-US'), track('y', 'German', 'de')];
    expect(engineTrackFor(de, renditions, tracks)?.id).toBe('y');
    expect(renditionOfTrack(tracks[0]!, renditions, tracks)).toBe(en);
  });

  it('uses the master order only when the engine reports no contradicting language', () => {
    expect(engineTrackFor(en, renditions, [track('0', '#1'), track('1', '#2')])?.id).toBe('1');
    expect(engineTrackFor(en, renditions, [track('0', 'x', 'fr'), track('1', 'y', 'it')])).toBe(
      undefined
    );
    expect(engineTrackFor(en, renditions, [track('0', '#1')])).toBe(undefined);
  });

  it('keeps master order among renditions of the same language', () => {
    const commentary = { ...en, id: '3', streamIndex: 3, label: 'English · AAC 2.0 (2)' };
    const all = [de, en, commentary];
    const tracks = [
      track('0', 'German', 'de'),
      track('1', 'English', 'en'),
      track('2', 'English', 'en'),
    ];
    expect(engineTrackFor(commentary, all, tracks)?.id).toBe('2');
    expect(engineTrackFor(en, all, tracks)?.id).toBe('1');
  });
});

describe('renditionFor', () => {
  const playback = (inSession: boolean) =>
    ({
      inSessionAudioSwitch: inSession,
      audioRenditions: renditions,
      mediaInfo: {
        audioTracks: [
          { index: 1, renditionId: '1' },
          { index: 2, renditionId: '2' },
          { index: 5, renditionId: null },
        ],
      },
    }) as unknown as Playback;

  it('needs inSessionAudioSwitch and a renditionId', () => {
    expect(renditionFor(playback(true), 2)).toBe(en);
    expect(renditionFor(playback(true), 5)).toBe(undefined);
    expect(renditionFor(playback(false), 2)).toBe(undefined);
  });
});

describe('audioErrorCode', () => {
  it('maps the server answers of an audio rendition to its error codes', () => {
    expect(
      audioErrorCode({ details: 'audioTrackLoadError', response: { code: 404 } } as never)
    ).toBe('unknown_audio_rendition');
    expect(
      audioErrorCode({
        details: 'fragLoadError',
        frag: { type: 'audio' },
        response: { code: 500 },
      } as never)
    ).toBe('rendition_split_failed');
    expect(
      audioErrorCode({
        details: 'fragLoadError',
        frag: { type: 'main' },
        response: { code: 500 },
      } as never)
    ).toBe(null);
  });
});
