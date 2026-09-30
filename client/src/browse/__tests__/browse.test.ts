import type { DeviceProfile } from '@modules/media-caps';

import type { Version } from '@/browse/queries';
import { resumeSeconds, watchProgress } from '@/browse/title-actions';
import {
  predictedMethod,
  predictionReasons,
  versionDetails,
  versionFormats,
  versionHeadline,
} from '@/browse/version-format';
import i18n from '@/i18n';
import {
  addRecentSearch,
  clearRecentSearches,
  deleteRecentSearches,
  MAX_RECENT,
  readRecentSearches,
  removeRecentSearch,
} from '@/lib/recent-searches';
import { parseWorkId } from '@/lib/work-id';
import { workHref } from '@/navigation/routes';
import { versionHints } from '@/player/device-profile';

const version = (patch: Partial<Version>): Version => ({
  releaseId: 'r1',
  name: 'Movie.2010.2160p.BluRay.TrueHD.5.1.HDR10.x265-GRP',
  rank: 1,
  health: 'unknown',
  ...patch,
});

describe('parseWorkId', () => {
  it('reads movies, series, seasons and episodes', () => {
    expect(parseWorkId('tmdb-movie-10378')).toEqual({ kind: 'movie', tmdbId: 10378 });
    expect(parseWorkId('tmdb-tv-19885')).toEqual({ kind: 'series', tmdbId: 19885 });
    expect(parseWorkId('tmdb-tv-19885-s02')).toEqual({ kind: 'season', tmdbId: 19885, season: 2 });
    expect(parseWorkId('tmdb-tv-19885-s01e03')).toEqual({
      kind: 'episode',
      tmdbId: 19885,
      season: 1,
      episode: 3,
    });
  });

  it('rejects unknown shapes', () => {
    expect(parseWorkId('tmdb-movie-1-s01')).toBeUndefined();
    expect(parseWorkId('imdb-tt123')).toBeUndefined();
    expect(parseWorkId(null)).toBeUndefined();
  });

  it('links episodes to their series', () => {
    expect(workHref('tmdb-tv-19885-s01e03')).toEqual({
      pathname: '/series/[id]',
      params: { id: '19885' },
    });
    expect(workHref('tmdb-movie-5')).toEqual({ pathname: '/movie/[id]', params: { id: '5' } });
  });
});

describe('recent searches', () => {
  afterEach(() => {
    deleteRecentSearches('a');
    deleteRecentSearches('b');
  });

  it('keeps the newest first without case-insensitive duplicates, per account', () => {
    addRecentSearch('a', 'sintel');
    addRecentSearch('a', 'sherlock');
    addRecentSearch('a', ' Sintel ');
    addRecentSearch('a', 'x');
    addRecentSearch('b', 'pioneer');
    expect(readRecentSearches('a')).toEqual(['Sintel', 'sherlock']);
    expect(readRecentSearches('b')).toEqual(['pioneer']);
  });

  it('caps the list and supports remove and clear', () => {
    for (let index = 0; index < MAX_RECENT + 3; index++) addRecentSearch('a', `query ${index}`);
    expect(readRecentSearches('a')).toHaveLength(MAX_RECENT);
    expect(readRecentSearches('a')[0]).toBe(`query ${MAX_RECENT + 2}`);
    removeRecentSearch('a', `query ${MAX_RECENT + 2}`);
    expect(readRecentSearches('a')[0]).toBe(`query ${MAX_RECENT + 1}`);
    clearRecentSearches('a');
    expect(readRecentSearches('a')).toEqual([]);
  });
});

describe('watch helpers', () => {
  const minute = 60 * 10_000_000;
  it('resumes only started, unfinished works', () => {
    expect(resumeSeconds({ positionTicks: 2 * minute, durationTicks: 10 * minute })).toBe(120);
    expect(resumeSeconds({ positionTicks: 2 * minute, played: true })).toBe(0);
    expect(resumeSeconds(null)).toBe(0);
    expect(watchProgress({ positionTicks: 2 * minute, durationTicks: 10 * minute })).toBeCloseTo(
      0.2
    );
    expect(watchProgress({ positionTicks: 0, durationTicks: 10 * minute })).toBeUndefined();
  });
});

describe('version format', () => {
  const t = i18n.t.bind(i18n);
  beforeAll(() => i18n.changeLanguage('en'));

  it('describes resolution, HDR, codecs and audio', () => {
    const hdr = version({
      resolution: '2160p',
      source: 'BluRay',
      hdrFormats: ['hdr10'],
      videoCodec: 'hevc',
      bitDepth: 10,
      audioCodec: 'truehd',
      audioChannels: '7.1',
      atmos: true,
    });
    expect(versionHeadline(hdr)).toBe('4K · HDR10 · BluRay');
    expect(versionFormats(hdr, t)).toEqual(['HEVC 10-bit', 'TrueHD 7.1 Atmos']);
  });

  it('names languages, subtitles and release flags', () => {
    const multi = version({
      languages: ['de', 'en'],
      subtitleLanguages: ['en'],
      releaseGroup: 'GRP',
      seasonPack: true,
    });
    expect(versionDetails(multi, t, 'en')).toEqual([
      'Audio: German, English',
      'Subtitles: English',
      'Season pack',
      'GRP',
    ]);
  });

  it('translates known prediction reasons and drops unknown ones', () => {
    const remux = version({
      predictedMethod: 'remux',
      predictionReasons: [
        { code: 'audio_converted', params: { from: 'eac3', to: 'aac', channels: '2' } },
        { code: 'container_assumed', params: { container: 'mkv' } },
        { code: 'something_new' },
      ],
    });
    expect(predictedMethod(remux)).toBe('remux');
    expect(predictionReasons(remux, t)).toEqual([
      'audio converted from Dolby Digital+ to AAC',
      'container assumed (mkv)',
    ]);
    expect(predictedMethod(version({ predictedMethod: 'teleport' }))).toBeUndefined();
  });
});

describe('versionHints', () => {
  it('uses the native engine of the device profile', () => {
    const profile: DeviceProfile = {
      platform: 'androidtv',
      vlcAvailable: true,
      engines: [
        {
          engine: 'native',
          containers: ['mp4', 'mkv'],
          videoCodecs: [
            { codec: 'h264', maxHeight: 1080, maxBitDepth: 8 },
            { codec: 'hevc', maxHeight: 2160, maxBitDepth: 10, hdrFormats: ['hdr10'] },
          ],
          audioCodecs: [{ codec: 'aac' }, { codec: 'ac3', passthrough: true }],
          subtitleFormats: ['srt'],
          hls: true,
          maxAudioChannels: 6,
        },
        {
          engine: 'vlc',
          containers: ['mkv'],
          videoCodecs: [{ codec: 'mpeg2' }],
          audioCodecs: [{ codec: 'dts' }],
          subtitleFormats: ['pgs'],
          hls: true,
          maxAudioChannels: 6,
        },
      ],
    };
    expect(versionHints(profile)).toEqual({
      videoCodecs: 'h264,hevc',
      audioCodecs: 'aac,ac3',
      containers: 'mp4,mkv',
      hdrFormats: 'hdr10',
      supports10Bit: true,
      maxAudioChannels: 6,
      maxHeight: 2160,
      maxBitrateKbps: undefined,
    });
  });
});
