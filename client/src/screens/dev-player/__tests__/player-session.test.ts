import { EngineBase } from '@/player/engines/base';
import type {
  EngineSource,
  EngineTracks,
  PlayerEngine,
  SurfaceProps,
} from '@/player/engines/types';
import type { Playback } from '@/player/playback-api';

import { PlayerSession, type SessionOptions } from '../player-session';

class FakeEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'vlc' as const;
  readonly Surface = (_props: SurfaceProps) => null;
  readonly calls: string[] = [];
  load(source: EngineSource) {
    this.resetForLoad(source);
  }
  play() {}
  pause() {}
  seek() {}
  setAudioTrack(id: string) {
    this.calls.push(`audio:${id}`);
  }
  setSubtitleTrack(id: string | null) {
    this.calls.push(`subtitle:${id}`);
  }
  tracks(tracks: EngineTracks) {
    this.emit({ type: 'tracks', tracks });
  }
}

let mockEngine: FakeEngine;
jest.mock('@/player/engines', () => ({ createEngine: () => mockEngine }));
jest.mock('@modules/media-caps', () => ({ readCodecLogAsync: jest.fn(async () => []) }));

const track = (id: string, selected = false) => ({ id, label: id, selected });

function attach(playback: Playback) {
  const session = new PlayerSession({ serverUrl: 'http://server' } as SessionOptions);
  return session['attach'](playback, 0);
}

describe('PlayerSession server track decision', () => {
  beforeEach(() => {
    mockEngine = new FakeEngine();
  });

  it('turns on the forced subtitle the server selected once the engine lists the tracks', async () => {
    await attach({
      playbackId: 'p1',
      method: 'remux',
      engine: 'native',
      url: '/master.m3u8',
      mediaInfo: {
        audioTracks: [{ index: 1, deliveredAs: 'converted', selected: true }],
        subtitleTracks: [
          { index: 3, deliveredAs: 'webvtt' },
          { index: 4, deliveredAs: 'webvtt' },
          { index: 5, deliveredAs: 'webvtt', selected: true },
        ],
      },
    } as Playback);
    mockEngine.tracks({ audio: [track('a0', true)], subtitles: [track('s0')] });
    expect(mockEngine.calls).toEqual([]);
    mockEngine.tracks({
      audio: [track('a0', true)],
      subtitles: [track('s0'), track('s1'), track('s2')],
    });
    mockEngine.tracks({
      audio: [track('a0', true)],
      subtitles: [track('s0'), track('s1'), track('s2')],
    });
    expect(mockEngine.calls).toEqual(['subtitle:s2']);
  });

  it('selects the server audio in the engine and clears a subtitle the server did not pick', async () => {
    await attach({
      playbackId: 'p2',
      method: 'direct',
      engine: 'vlc',
      url: '/stream/x',
      mediaInfo: {
        audioTracks: [
          { index: 1, deliveredAs: 'original' },
          { index: 2, deliveredAs: 'original', selected: true },
        ],
        subtitleTracks: [{ index: 3, deliveredAs: 'embedded' }],
      },
    } as Playback);
    mockEngine.tracks({ audio: [track('0', true), track('1')], subtitles: [track('0', true)] });
    expect(mockEngine.calls).toEqual(['audio:1', 'subtitle:null']);
  });
});
