import { fireEvent, screen } from '@testing-library/react-native';
import { createInstance, type TFunction } from 'i18next';
import { View } from 'react-native';

import en from '@/i18n/locales/en.json';
import { renderWithProviders } from '@/../jest/render';

import { PhoneDetail, watchedAction } from '../phone-detail';

const mockOpenAbout = jest.fn();
jest.mock('../about-sheet', () => ({
  useAboutSheet: (request: unknown) => ({ open: () => mockOpenAbout(request), drawer: null }),
}));
jest.mock('@/navigation/back-control', () => ({
  BackControl: () => null,
  PHONE_HEADER_HEIGHT: 56,
}));

let t: TFunction;
beforeAll(async () => {
  const instance = createInstance();
  await instance.init({ lng: 'en', resources: { en: { translation: en } } });
  t = instance.t;
});

describe('phone detail actions (Q1-38, Q1-44)', () => {
  it('"Details" opens the About sheet of the title instead of un-clamping the overview', async () => {
    await renderWithProviders(
      <PhoneDetail
        testID="movie-screen-1"
        kindLabel="Movie"
        title="Tears of Steel"
        facts={['2012']}
        overview="A long overview"
        about={{ kind: 'movie', tmdbId: 133701, title: 'Tears of Steel' }}>
        <View />
      </PhoneDetail>
    );
    await fireEvent.press(screen.getByTestId('movie-screen-1-details'));
    expect(mockOpenAbout).toHaveBeenCalledWith({
      kind: 'movie',
      tmdbId: 133701,
      title: 'Tears of Steel',
    });
  });

  it('labels the watched toggle as an action until watched, then shows the state', () => {
    expect(watchedAction(false, t)).toMatchObject({ label: 'Mark watched', selected: false });
    expect(watchedAction(true, t)).toMatchObject({
      label: 'Watched',
      accessibilityLabel: 'Mark as unwatched',
      selected: true,
    });
  });
});
