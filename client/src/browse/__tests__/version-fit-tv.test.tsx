import { fireEvent, screen, within } from '@testing-library/react-native';
import { Platform } from 'react-native';

import type { Version } from '@/browse/queries';
import { VersionSheetPanel } from '@/browse/version-sheet';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';

const versions = [
  {
    rank: 1,
    qualityRank: 2,
    releaseId: 'r-1080',
    name: 'Sintel.2010.1080p.WEB-DL.H264-GRP',
    resolution: '1080p',
    languages: ['en'],
    recommended: true,
    predictedMethod: 'direct',
    health: 'ready',
    estimatedBitrateKbps: 8_000,
    bandwidthFit: 'ok',
    bandwidthLeg: 'device',
  },
  {
    rank: 2,
    qualityRank: 1,
    releaseId: 'r-2160',
    name: 'Sintel.2010.2160p.UHD.BluRay.REMUX.HEVC-GRP',
    resolution: '2160p',
    languages: ['en'],
    predictedMethod: 'direct',
    health: 'ready',
    estimatedBitrateKbps: 80_000,
    bandwidthFit: 'tooHigh',
    bandwidthLeg: 'device',
    bandwidthNeededKbps: 104_000,
    bandwidthAvailableKbps: 38_000,
  },
] as Version[];

let mockMeasured: number | undefined;
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  useVersions: () => ({ data: { versions, incomplete: false }, refetch: jest.fn() }),
  useAudioLanguages: () => 'en',
  useMeasuredBandwidthKbps: () => mockMeasured,
}));
jest.mock('@modules/tv-native', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    tvNativeAvailable: true,
    TVFocusHost: (props: object) => <View {...props} />,
    setMenuMode: () => undefined,
    focusView: () => null,
  };
});
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

beforeAll(async () => {
  await i18n.changeLanguage('de');
});
afterAll(async () => {
  await i18n.changeLanguage('en');
});
beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

const onMeasure = jest.fn();
const panel = () => (
  <VersionSheetPanel
    frame="tv"
    workId="tmdb-movie-123"
    title="Sintel"
    onPlay={() => undefined}
    onClose={() => undefined}
    onMeasure={onMeasure}
  />
);

describe('version sheet on TV: bitrate fit', () => {
  it('marks the 4K remux as too fast for the measured connection, in German', async () => {
    mockMeasured = 38_000;
    await renderWithProviders(panel());

    expect(screen.getByTestId('version-2-fit-tooHigh')).toHaveTextContent(
      'Bitrate zu hoch für deine Verbindung'
    );
    expect(screen.getByTestId('version-2-fit')).toHaveTextContent(
      /braucht ~104, gemessen ~38 Mbit\/s$/
    );
    expect(screen.getByTestId('version-2')).toHaveProp(
      'accessibilityLabel',
      expect.stringContaining(
        'Bitrate zu hoch für deine Verbindung, braucht ~104, gemessen ~38 Mbit/s'
      )
    );
    expect(screen.queryByTestId('version-1-fit')).toBeNull();
    expect(screen.queryByTestId('version-sheet-measure-hint')).toBeNull();
  });

  it('without a measurement the hint sits in the focusable list, above the cards, and the entry stays on Recommended', async () => {
    mockMeasured = undefined;
    await renderWithProviders(panel());

    const list = screen.getByTestId('version-sheet-list');
    const hint = within(list).getByTestId('version-sheet-measure-hint');
    expect(hint).toHaveTextContent(/Passt das zu deiner Verbindung\?/);
    expect(screen.queryByTestId('version-2-fit')).toBeNull();
    expect(
      within(screen.getByTestId('version-sheet-entry')).getByTestId('version-1')
    ).toBeOnTheScreen();
    fireEvent.press(within(hint).getByTestId('version-sheet-measure'));
    expect(onMeasure).toHaveBeenCalledTimes(1);
  });
});
