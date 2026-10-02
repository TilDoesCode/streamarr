import { createInstance, type TFunction } from 'i18next';

import { playTarget } from '@/browse/play-target';
import type { Version } from '@/browse/queries';
import {
  fitChips,
  fitReasons,
  reasonLine,
  reasonText,
  shortReasons,
  specChips,
  type SpecChip,
} from '@/browse/version-chips';
import en from '@/i18n/locales/en.json';

const v = (rank: number, extra: Partial<Version> = {}) =>
  ({ rank, releaseId: `r${rank}`, recommended: false, ...extra }) as Version;

// BBB for anna: recommended WEB-DL plays direct, the last played BluRay is a direct stream.
const webdl = v(1, {
  recommended: true,
  predictedMethod: 'direct',
  resolution: '1080p',
  source: 'WEB-DL',
});
const bluray = v(2, {
  predictedMethod: 'remux',
  resolution: '1080p',
  source: 'BluRay',
  predictionReasons: [
    { code: 'audio_converted', params: { from: 'eac3', to: 'aac' } },
    { code: 'container_unsupported', params: { container: 'mkv' } },
  ],
});

let t: TFunction;
beforeAll(async () => {
  const instance = createInstance();
  await instance.init({
    lng: 'en',
    resources: { en: { translation: en } },
    interpolation: { prefix: '{', suffix: '}', escapeValue: false },
  });
  t = instance.t;
});

describe('playTarget', () => {
  it('Resume starts the last played version when it is offered and playable here', () => {
    const target = playTarget([webdl, bluray], { lastReleaseId: 'r2' }, 'resume');
    expect(target).toMatchObject({
      state: 'ready',
      version: bluray,
      method: 'remux',
      releaseId: 'r2',
      isLastPlayed: true,
      lastPlayedMissing: false,
      directAlternative: webdl,
    });
  });

  it('offers a direct alternative only at the same or a higher resolution', () => {
    const sd = v(3, { predictedMethod: 'direct', resolution: '720p' });
    const target = playTarget([bluray, sd], null, 'play');
    expect(target).toMatchObject({ version: bluray, directAlternative: undefined });
  });

  it('Start over starts the same version as Resume', () => {
    expect(playTarget([webdl, bluray], { lastReleaseId: 'r2' }, 'restart')).toMatchObject({
      version: bluray,
      releaseId: 'r2',
    });
  });

  it('Play and Watch again start the recommendation without a releaseId', () => {
    const target = playTarget([webdl, bluray], { lastReleaseId: 'r2' }, 'play');
    expect(target).toMatchObject({ version: webdl, releaseId: undefined, isLastPlayed: false });
  });

  it('falls back to the recommendation when the last played version is gone', () => {
    expect(playTarget([webdl, bluray], { lastReleaseId: 'gone' }, 'resume')).toMatchObject({
      version: webdl,
      releaseId: undefined,
      lastPlayedMissing: true,
    });
  });

  it('falls back when the last played version cannot be predicted here', () => {
    const unknown = v(3, { predictedMethod: 'unknown' });
    expect(playTarget([webdl, unknown], { lastReleaseId: 'r3' }, 'resume')).toMatchObject({
      version: webdl,
      releaseId: undefined,
      lastPlayedMissing: false,
    });
  });

  it('uses rank 1 without a recommendation, and names loading, error and no versions', () => {
    expect(playTarget([v(2), v(1)], null, 'play')).toMatchObject({ version: { rank: 1 } });
    expect(playTarget(undefined, null, 'play')).toEqual({ state: 'loading' });
    expect(playTarget(undefined, null, 'play', true)).toEqual({ state: 'error' });
    expect(playTarget([], null, 'resume')).toEqual({ state: 'none' });
  });
});

describe('chip row model', () => {
  const big = v(1, {
    predictedMethod: 'transcode',
    resolution: '2160p',
    hdrFormats: ['dv'],
    videoCodec: 'hevc',
    bitDepth: 10,
    audioCodec: 'truehd',
    audioChannels: '7.1',
    atmos: true,
    source: 'Remux',
    sizeBytes: 58e9,
  });
  const labels = (chips: SpecChip[]) => chips.map((chip) => chip.label);

  it('lists resolution, HDR, video, audio, source and size in order', () => {
    expect(labels(specChips(big, t, () => '58 GB'))).toEqual([
      '4K',
      'Dolby Vision',
      'HEVC 10-bit',
      'TrueHD 7.1 Atmos',
      'Remux',
      '58 GB',
    ]);
    expect(specChips({ ...big, seasonPack: true }, t, String).map((c) => c.key)).not.toContain(
      'size'
    );
  });

  it('drops size, source, the audio codec, then the video codec; method data always stays', () => {
    const chips = specChips(big, t, () => '58 GB');
    const width = (chip: SpecChip) => chip.label.length * 10;
    const fit = (room: number) => labels(fitChips(chips, big, room, width, 0));
    expect(fit(510)).toHaveLength(6);
    expect(fit(505)).toEqual(['4K', 'Dolby Vision', 'HEVC 10-bit', 'TrueHD 7.1 Atmos', 'Remux']);
    expect(fit(455)).toEqual(['4K', 'Dolby Vision', 'HEVC 10-bit', 'TrueHD 7.1 Atmos']);
    expect(fit(400)).toEqual(['4K', 'Dolby Vision', 'HEVC 10-bit', '7.1 Atmos']);
    expect(fit(300)).toEqual(['4K', 'Dolby Vision', '7.1 Atmos']);
  });

  it('gives at most two short reasons; a direct stream names only audio conversions', () => {
    expect(shortReasons(bluray, 'remux', t)).toEqual(['Audio is converted (DD+ → AAC)']);
    const tos = v(4, {
      predictionReasons: [
        { code: 'audio_converted', params: { from: 'eac3', to: 'aac' } },
        { code: 'hdr_unsupported', params: { hdr: 'hdr10' } },
        { code: 'video_codec_unsupported', params: { codec: 'hevc' } },
      ],
    });
    expect(shortReasons(tos, 'transcode', t)).toEqual(['HEVC is converted', 'HDR10 → SDR']);
    expect(shortReasons(webdl, 'direct', t)).toEqual([]);
  });

  it('reason line: reasons, then the direct alternative; when direct, the gap to the best', () => {
    const resume = playTarget([webdl, bluray], { lastReleaseId: 'r2' }, 'resume');
    const text = (segments: ReturnType<typeof reasonLine>) =>
      segments.map((segment) => segment.map((part) => part.text).join(' ')).join(' · ');
    expect(text(reasonLine(resume, [webdl, bluray], t))).toBe(
      'Audio is converted (DD+ → AAC) · Direct possible: 1080p WEB-DL in “Versions”'
    );
    const uhd = v(5, {
      predictedMethod: 'transcode',
      resolution: '2160p',
      hdrFormats: ['hdr10'],
      qualityRank: 0,
    });
    const direct = playTarget([webdl, uhd], null, 'play');
    expect(text(reasonLine(direct, [webdl, uhd], t))).toBe(
      '4K · HDR10 available, plays here only transcoded'
    );
    expect(text(reasonLine({ state: 'error' }, [], t))).toMatch(/Versions not loaded/);
  });

  it('reason line width steps: "in Versions" goes first, then trailing segments, never a cut reason', () => {
    const segments = [
      [{ text: 'Audio converted to AAC', tone: 'method' as const }],
      [
        { text: 'Direct possible:', tone: 'plain' as const },
        { text: '1080p WEB-DL', tone: 'ok' as const },
        { text: 'in “Versions”', tone: 'plain' as const },
      ],
    ];
    const widthOf = (line: string) => line.length * 10;
    const fit = (width: number) =>
      reasonText(fitReasons(segments, width, widthOf, 'in “Versions”'));
    const full = 'Audio converted to AAC  ·  Direct possible: 1080p WEB-DL in “Versions”';
    expect(fit(full.length * 10)).toBe(full);
    expect(fit(full.length * 10 - 10)).toBe(
      'Audio converted to AAC  ·  Direct possible: 1080p WEB-DL'
    );
    expect(fit(400)).toBe('Audio converted to AAC');
    // A single segment that still does not fit stays whole (the line ellipsis is the last resort).
    expect(fit(50)).toBe('Audio converted to AAC');
    const alone = [segments[1]!];
    expect(reasonText(fitReasons(alone, 330, widthOf, 'in “Versions”'))).toBe(
      'Direct possible: 1080p WEB-DL'
    );
  });
});
