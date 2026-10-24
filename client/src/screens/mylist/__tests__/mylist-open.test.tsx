import { fireEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import {
  clearWorld,
  noContent,
  open,
  resetWorld,
  WAIT,
  world,
} from '../../../../jest/mylist-world';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('My List card', () => {
  it('opening a new title clears its flag and lands on the episode to watch', async () => {
    let seen = 0;
    world.handlers['POST /api/v1/viewer/list/tmdb-tv-600/seen'] = () => {
      seen += 1;
      return noContent();
    };
    const { router } = await open('/mylist');
    fireEvent.press(await screen.findByTestId('mylist-item-tmdb-tv-600', {}, WAIT));
    await waitFor(() => expect(seen).toBe(1), WAIT);
    await waitFor(() => expect(router.getPathname()).toBe('/series/600'), WAIT);
    expect(router.getSearchParams()).toMatchObject({ season: '1', episode: '4' });
  });
});
