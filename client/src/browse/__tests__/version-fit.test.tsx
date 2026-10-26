import { fireEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import { setDeviceMbps } from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const base = {
  health: 'ready',
  languages: ['en'],
  hdrFormats: [],
  subtitleHints: [],
  subtitleLanguages: [],
};
const VERSIONS = [
  {
    ...base,
    releaseId: 'r-1080',
    name: 'Sintel.2010.1080p.WEB-DL.H264-GRP',
    rank: 1,
    qualityRank: 2,
    recommended: true,
    resolution: '1080p',
    videoCodec: 'h264',
    sizeBytes: 3_000_000_000,
    estimatedBitrateKbps: 34_000,
    predictedMethod: 'direct',
    predictedHeight: 1080,
    predictedHdr: 'sdr',
    bandwidthFit: 'tight',
    bandwidthLeg: 'usenet',
    bandwidthNeededKbps: 44_200,
    bandwidthAvailableKbps: 40_000,
  },
  {
    ...base,
    releaseId: 'r-720',
    name: 'Sintel.2010.720p.WEB-DL.H264-GRP',
    rank: 2,
    qualityRank: 3,
    resolution: '720p',
    videoCodec: 'h264',
    estimatedBitrateKbps: 6_000,
    predictedMethod: 'direct',
    predictedHeight: 720,
    predictedHdr: 'sdr',
    bandwidthFit: 'ok',
    bandwidthLeg: 'device',
    bandwidthNeededKbps: 7_800,
    bandwidthAvailableKbps: 38_000,
  },
  {
    ...base,
    releaseId: 'r-2160',
    name: 'Sintel.2010.2160p.UHD.BluRay.REMUX.HEVC.HDR10-GRP',
    rank: 3,
    qualityRank: 1,
    resolution: '2160p',
    source: 'Remux',
    videoCodec: 'hevc',
    hdr: 'hdr10',
    hdrFormats: ['hdr10'],
    estimatedBitrateKbps: 80_000,
    predictedMethod: 'direct',
    predictedHeight: 2160,
    predictedHdr: 'hdr10',
    bandwidthFit: 'tooHigh',
    bandwidthLeg: 'device',
    bandwidthNeededKbps: 104_000,
    bandwidthAvailableKbps: 38_000,
  },
];

let asked: URL[] = [];
function serveVersions(fits: boolean) {
  asked = [];
  world.handlers['/api/v1/viewer/catalog/works/tmdb-movie-123/versions'] = (url) => {
    asked.push(url);
    const versions = fits
      ? VERSIONS
      : VERSIONS.map((v) => ({
          ...v,
          bandwidthFit: null,
          bandwidthLeg: null,
          bandwidthNeededKbps: null,
          bandwidthAvailableKbps: null,
        }));
    return json(200, {
      workId: 'tmdb-movie-123',
      mediaType: 'movie',
      versions,
      checkedAt: new Date().toISOString(),
    });
  };
}

beforeEach(resetWorld);
afterEach(clearWorld);

describe('versions sheet: bitrate vs. the measured connection', () => {
  it('marks versions that do not fit or are tight, sends the measurement, and says why Play differs', async () => {
    setDeviceMbps(38);
    serveVersions(true);
    await open('/versions/tmdb-movie-123?title=Sintel');

    const tooHigh = await screen.findByTestId('version-3-fit-tooHigh', {}, WAIT);
    expect(tooHigh).toHaveTextContent('Bitrate too high for your connection');
    expect(screen.getByTestId('version-3-fit')).toHaveTextContent(
      /needs ~104, measured ~38 Mbit\/s$/
    );
    expect(screen.getByTestId('version-1-fit-tight')).toHaveTextContent(
      'Tight for your connection'
    );
    expect(screen.getByTestId('version-1-fit')).toHaveTextContent(
      /needs ~44, measured ~40 Mbit\/s · Usenet$/
    );
    expect(screen.queryByTestId('version-2-fit')).toBeNull();
    expect(screen.queryByTestId('version-sheet-measure-hint')).toBeNull();
    expect(asked.at(-1)?.searchParams.get('measuredBandwidthKbps')).toBe('38000');
    expect(screen.getByTestId('version-sheet-specs-recommended')).toBeOnTheScreen();
  });

  it('a tight recommended version says so in the header, not "fits"', async () => {
    setDeviceMbps(38);
    serveVersions(true);
    await open('/versions/tmdb-movie-123?title=Sintel');

    const recommended = await screen.findByTestId('version-sheet-specs-recommended', {}, WAIT);
    expect(
      within(recommended).getByText('1080p · SDR – tight for your connection')
    ).toBeOnTheScreen();
    expect(screen.getByTestId('version-1-fit-tight')).toBeOnTheScreen();
  });

  it('a measurement older than 7 days: no markers, no bandwidth sent, a hint to measure again', async () => {
    setDeviceMbps(38, 8 * 24 * 3600_000);
    serveVersions(false);
    await open('/versions/tmdb-movie-123?title=Sintel');

    const hint = await screen.findByTestId('version-sheet-measure-hint', {}, WAIT);
    expect(hint).toHaveTextContent(/The last measurement is older than 7 days/);
    expect(screen.queryByTestId('version-3-fit')).toBeNull();
    expect(asked.at(-1)?.searchParams.has('measuredBandwidthKbps')).toBe(false);
  });

  // Last: it navigates.
  it('never measured: the hint leads to Connection & diagnostics', async () => {
    setDeviceMbps(null);
    serveVersions(false);
    await open('/versions/tmdb-movie-123?title=Sintel');

    const hint = await screen.findByTestId('version-sheet-measure-hint', {}, WAIT);
    expect(hint).toHaveTextContent(/Measure this device's connection/);
    fireEvent.press(within(hint).getByTestId('version-sheet-measure'));
    await waitFor(() => expect(screen.getByTestId('connection-screen')).toBeOnTheScreen(), WAIT);
  });
});
