import { fireEvent, within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import {
  clearWorld,
  ITEMS,
  json,
  noContent,
  open,
  resetWorld,
  WAIT,
  world,
} from '../../../../jest/mylist-world';

let mockWindow: { width: number; height: number; scale: number; fontScale: number } | undefined;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => {
  const actual = jest.requireActual('react-native/Libraries/Utilities/useWindowDimensions');
  return { __esModule: true, default: () => mockWindow ?? actual.default() };
});

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(() => {
  mockWindow = undefined;
  clearWorld();
});

describe('My List', () => {
  it('shows new episodes first, then continue, want to watch, caught up and watched', async () => {
    await open('/mylist');
    const rows = ['new', 'watching', 'want', 'caughtUp', 'watched'];
    for (const row of rows)
      expect(await screen.findByTestId(`mylist-row-${row}`, {}, WAIT)).toBeOnTheScreen();
    const page = screen.getByTestId('mylist-screen');
    const order = within(page)
      .getAllByRole('heading')
      .map((heading) => heading.props.children);
    expect(order).toEqual([
      'My List',
      'New episodes',
      'Continue watching',
      'Want to watch',
      'Caught up',
      'Watched',
    ]);
    expect(screen.getByText('New episodes in 1 title')).toBeOnTheScreen();

    const fresh = within(screen.getByTestId('mylist-item-tmdb-tv-600'));
    expect(fresh.getByText('NEW')).toBeOnTheScreen();
    expect(fresh.getByText('S1, E4 · 3/4')).toBeOnTheScreen();
    expect(
      within(screen.getByTestId('mylist-item-tmdb-tv-720')).getByText(/^Next episode /)
    ).toBeOnTheScreen();
    // A season entry names its series.
    expect(
      within(screen.getByTestId('mylist-item-tmdb-tv-710-s01')).getByText('Ended Show')
    ).toBeOnTheScreen();
  });

  it('badges the tab with the count of titles that have new episodes', async () => {
    await open('/');
    const tab = await screen.findByTestId('nav-mylist', {}, WAIT);
    expect(await within(tab).findByTestId('mylist-badge', {}, WAIT)).toHaveTextContent('1');
    expect(within(tab).getByTestId('mylist-badge')).toHaveAccessibleName(
      '1 title with new episodes'
    );
  });

  it('shows no badge and an empty page while nothing is on the list', async () => {
    world.handlers['/api/v1/viewer/list'] = () =>
      json(200, { items: [], total: 0, incomplete: false });
    world.handlers['/api/v1/viewer/list/summary'] = () =>
      json(200, { newCount: 0, total: 0, wantToWatch: 0, watching: 0, caughtUp: 0, watched: 0 });
    await open('/mylist');
    expect(await screen.findByTestId('mylist-empty', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByText('Your list is empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('mylist-badge')).toBeNull();
  });

  it('phones: the action row has My List next to Watched', async () => {
    mockWindow = { width: 390, height: 844, scale: 3, fontScale: 1 };
    world.handlers['GET /api/v1/viewer/list/tmdb-movie-123'] = () =>
      json(200, { workId: 'tmdb-movie-123', onList: true });
    await open('/movie/123');
    // The action row appears with the detail.
    await screen.findByTestId('movie-mark', {}, WAIT);
    const action = await screen.findByTestId('movie-list', {}, WAIT);
    await waitFor(() => expect(action).toHaveAccessibleName('Remove from My List'), WAIT);
    expect(within(action).getByText('On My List')).toBeOnTheScreen();
  });

  // Last in the file: after a list mutation expo-router renders nothing for a further test here.
  it('adds a movie from its detail page; the button flips and a toast confirms', async () => {
    let onList = false;
    world.handlers['GET /api/v1/viewer/list/tmdb-movie-123'] = () =>
      json(200, { workId: 'tmdb-movie-123', onList });
    world.handlers['PUT /api/v1/viewer/list/tmdb-movie-123'] = () => {
      onList = true;
      return json(200, { ...ITEMS[2], workId: 'tmdb-movie-123', tmdbId: 123, title: 'Sintel' });
    };
    world.handlers['DELETE /api/v1/viewer/list/tmdb-movie-123'] = () => {
      onList = false;
      return noContent();
    };
    await open('/movie/123');
    // The actions appear with the detail.
    await screen.findByTestId('movie-mark', {}, WAIT);
    const button = await screen.findByTestId('movie-list', {}, WAIT);
    await waitFor(() => expect(button).toBeEnabled(), WAIT);
    expect(button).toHaveAccessibleName('Add to My List');
    fireEvent.press(button);
    expect(await screen.findByText('“Sintel” added to My List', {}, WAIT)).toBeOnTheScreen();
    expect(world.requests).toContain('PUT /api/v1/viewer/list/tmdb-movie-123');
    await waitFor(
      () => expect(screen.getByTestId('movie-list')).toHaveAccessibleName('Remove from My List'),
      WAIT
    );
    fireEvent.press(screen.getByTestId('movie-list'));
    expect(await screen.findByText('“Sintel” removed from My List', {}, WAIT)).toBeOnTheScreen();
    expect(world.requests).toContain('DELETE /api/v1/viewer/list/tmdb-movie-123');
  });
});
