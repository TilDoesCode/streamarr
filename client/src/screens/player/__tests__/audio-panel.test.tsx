import { fireEvent, screen } from '@testing-library/react-native';

import i18n from '@/i18n';
import type { PlaybackController } from '@/player/controller';
import { audioLayout } from '@/player/overlay-labels';
import { renderWithProviders } from '@/../jest/render';

import { PlayerPanels } from '../player-panels';

jest.mock('@/player/engines', () => ({ ENGINE_LABELS: {} }));
jest.mock('@/browse/queries', () => ({
  ...jest.requireActual('@/browse/queries'),
  useVersions: () => ({ data: undefined }),
}));

const renditions = [
  {
    id: '1',
    streamIndex: 1,
    language: 'de',
    label: 'Deutsch · AAC 2.0',
    channels: 2,
    codec: 'aac',
    default: true,
  },
  {
    id: '2',
    streamIndex: 2,
    language: 'en',
    label: 'English · AAC 2.0',
    channels: 2,
    codec: 'aac',
    default: false,
  },
];
const tracks = [
  {
    index: 1,
    language: 'ger',
    codec: 'ac3',
    channels: 6,
    renditionId: '1',
    title: 'Deutsch AC3 5.1',
  },
  { index: 2, language: 'eng', codec: 'ac3', channels: 2, renditionId: '2' },
];

function fakeController(over: { current: number; renditions?: boolean; audioTracks?: object[] }) {
  const audioTracks = (over.audioTracks ?? tracks) as never[];
  return {
    playback: { method: 'remux', mediaInfo: { audioTracks, subtitleTracks: [] } },
    preferences: { engine: 'auto' },
    currentAudio: () => over.current,
    currentSubtitle: () => null,
    renditionOf: (index: number) =>
      over.renditions === false ? undefined : renditions.find((item) => item.streamIndex === index),
    selectAudio: jest.fn(() => Promise.resolve()),
  } as unknown as PlaybackController & { selectAudio: jest.Mock };
}

const item = (name: RegExp) => screen.getByRole('radio', { name });

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('audio panel', () => {
  it('lists the renditions with what the viewer hears and the same layout as the chip', async () => {
    const controller = fakeController({ current: 1 });
    await renderWithProviders(
      <PlayerPanels panel="audio" onClose={jest.fn()} controller={controller} title="Sintel" />
    );
    expect(item(/^German, AAC 2\.0$/)).toBeTruthy();
    expect(item(/^English, AAC 2\.0$/)).toBeTruthy();
    expect(item(/^German/)).toBeChecked();
    expect(item(/^English/)).not.toBeChecked();
    // The chip reads "German 2.0": the layout comes from the same rendition as the panel's "AAC 2.0".
    expect(audioLayout(tracks[0] as never, renditions[0])).toBe('2.0');
  });

  it('marks the track the engine plays after an in-session switch and asks the controller to switch', async () => {
    const onClose = jest.fn();
    const controller = fakeController({ current: 2 });
    await renderWithProviders(
      <PlayerPanels panel="audio" onClose={onClose} controller={controller} title="Sintel" />
    );
    expect(item(/^English/)).toBeChecked();
    await fireEvent.press(item(/^German/));
    expect(onClose).toHaveBeenCalled();
    expect(controller.selectAudio).toHaveBeenCalledWith(tracks[0]);
  });

  it('shows the source format without renditions and the title for two tracks of one language', async () => {
    const controller = fakeController({
      current: 1,
      renditions: false,
      audioTracks: [
        tracks[0]!,
        { index: 3, language: 'ger', codec: 'aac', channels: 2, title: 'Kommentar' },
      ],
    });
    await renderWithProviders(
      <PlayerPanels panel="audio" onClose={jest.fn()} controller={controller} title="Sintel" />
    );
    expect(item(/^German · Deutsch AC3 5\.1, Dolby Digital 5\.1$/)).toBeTruthy();
    expect(item(/^German · Kommentar, AAC 2\.0$/)).toBeTruthy();
  });
});
