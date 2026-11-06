import type { ApiClient } from '@/api/client';
import { PlaybackController } from '@/player/controller';
import type { LocalSource } from '@/player/controller-types';
import type { EngineKind, PlayerEngine } from '@/player/engines';

jest.mock('@/player/engines', () => ({
  vlcAvailable: () => true,
  streamyboxAvailable: () => false,
  createEngine: (kind: EngineKind): PlayerEngine =>
    ({
      kind,
      Surface: () => null,
      load: jest.fn(),
      play: jest.fn(),
      pause: jest.fn(),
      seek: jest.fn(),
      release: jest.fn(),
      setAudioTrack: jest.fn(),
      setSubtitleTrack: jest.fn(),
      subscribe: () => () => undefined,
      getSnapshot: () => ({
        state: 'playing',
        position: 0,
        duration: 100,
        buffered: 100,
        tracks: { audio: [], subtitles: [{ id: 'pgs', label: 'PGS', selected: false }] },
        stats: {},
      }),
    }) as PlayerEngine,
}));

const pgs = {
  index: 4,
  codec: 'pgs',
  language: 'en',
  deliveredAs: 'none',
  vlcOnly: true,
  selected: false,
};

function player(engine: 'native' | 'vlc') {
  const release = jest.fn();
  const local: LocalSource = {
    downloadId: 'tracks',
    uri: 'file:///private/Movie.mkv',
    engine,
    releaseId: 'r1',
    version: null,
    resumeSeconds: 0,
    offline: () => true,
    release,
    mediaInfo: { audioTracks: [], subtitleTracks: [pgs] },
  };
  const controller = new PlaybackController({
    client: {} as ApiClient,
    accountId: `tracks-${engine}`,
    serverUrl: 'http://dev.test',
    profile: {} as never,
    nativeEngine: 'expo-video',
    workId: 'tmdb-movie-603',
    startSeconds: 0,
    local,
  });
  return { controller, release };
}

describe('local playback tracks (C1-14)', () => {
  it('a native download switched to VLC shows the saved VLC-only subtitles, and back hides them', async () => {
    const { controller, release } = player('native');
    await controller.start();
    expect(controller.playback!.mediaInfo!.subtitleTracks).toEqual([]);
    expect(await controller.setEnginePreference('vlc')).toBe(true);
    expect(controller.engine!.kind).toBe('vlc');
    expect(controller.playback!.mediaInfo!.subtitleTracks).toEqual([
      expect.objectContaining({ index: 4, vlcOnly: true, deliveredAs: 'embedded' }),
    ]);
    expect(await controller.setEnginePreference('native')).toBe(true);
    expect(controller.playback!.mediaInfo!.subtitleTracks).toEqual([]);
    await controller.stop();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('a VLC download offers them from the start', async () => {
    const { controller } = player('vlc');
    await controller.start();
    expect(controller.playback!.mediaInfo!.subtitleTracks).toEqual([
      expect.objectContaining({ index: 4, deliveredAs: 'embedded' }),
    ]);
    await controller.stop();
  });
});
