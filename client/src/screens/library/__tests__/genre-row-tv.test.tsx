import { screen, within } from '@testing-library/react-native';
import { Platform, View } from 'react-native';

import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

import { GenreRow } from '../genre-row';

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

beforeEach(() => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
});

const chips = Array.from({ length: 3 }, (_, index) => ({ id: index + 1, name: `G${index}` }));
const row = (trailing?: React.ReactNode) => (
  <GenreRow
    chips={chips}
    selected={null}
    selectedRef={{ current: null }}
    selectedNode={null}
    label="Genres"
    onSelect={() => undefined}
    onChipFocus={() => undefined}
    trailing={trailing}
  />
);

describe('GenreRow on TV', () => {
  it('ends the row with a trap when nothing follows the chips', async () => {
    await renderWithProviders(row());
    expect(screen.getByTestId('library-genres')).toHaveProp('trapFocusRight', true);
    expect(screen.queryByTestId('library-genre-line')).toBeNull();
  });

  it('puts a trailing control (Apple TV sort) in the same line, reachable by Right from the last chip', async () => {
    await renderWithProviders(row(<View testID="sort" />));
    const line = screen.getByTestId('library-genre-line');
    expect(line).toHaveStyle({ flexDirection: 'row' });
    expect(within(line).getByTestId('sort')).toBeOnTheScreen();
    expect(within(line).getByTestId('library-genres')).not.toHaveProp('trapFocusRight', true);
  });
});
