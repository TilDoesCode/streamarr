import { screen, waitFor } from '@testing-library/react-native';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import { tvFocus } from '@/components/focus/tv-focus';
import type { PlaybackController } from '@/player/controller';
import { renderWithProviders } from '@/../jest/render';

import { PlayerPanels } from '../player-panels';

const mockModal = jest.fn();
jest.mock('react-native/Libraries/Modal/Modal', () => ({
  __esModule: true,
  default: (props: object) => {
    mockModal(props);
    return null;
  },
}));
jest.mock('@/components/focus/tv-focus', () => ({
  ...jest.requireActual('@/components/focus/tv-focus'),
  tvFocus: jest.fn(),
}));
jest.mock('@/player/engines', () => ({ ENGINE_LABELS: {} }));
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  useVersions: () => ({ data: undefined }),
}));

const controller = {
  playback: { method: 'direct', mediaInfo: { audioTracks: [], subtitleTracks: [] } },
  preferences: { engine: 'auto' },
  currentAudio: () => null,
  currentSubtitle: () => null,
  renditionOf: () => undefined,
} as unknown as PlaybackController;

function onTV(os: 'android' | 'ios') {
  jest.replaceProperty(Platform, 'OS', os);
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
}

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

beforeEach(() => {
  mockModal.mockClear();
  (tvFocus as jest.Mock).mockClear();
});

afterEach(() => jest.restoreAllMocks());

describe('player panels on Android TV (inline, no Modal window above the video)', () => {
  it('Info without a better version: the rows take focus, so the remote never stays on the bar behind', async () => {
    onTV('android');
    await renderWithProviders(
      <PlayerPanels panel="info" onClose={jest.fn()} controller={controller} title="Hope" />
    );
    expect(mockModal).not.toHaveBeenCalled();
    expect(screen.getByTestId('player-info-rows')).toBeOnTheScreen();
    await waitFor(() =>
      expect((tvFocus as jest.Mock).mock.calls.map(([target]) => target?.props?.testID)).toContain(
        'player-info-rows'
      )
    );
  });

  it('Apple TV keeps the Modal panel and no extra focus stop in Info', async () => {
    onTV('ios');
    await renderWithProviders(
      <PlayerPanels panel="info" onClose={jest.fn()} controller={controller} title="Hope" />
    );
    expect(mockModal).toHaveBeenCalled();
    expect(screen.queryByTestId('player-info-rows')).toBeNull();
  });
});
