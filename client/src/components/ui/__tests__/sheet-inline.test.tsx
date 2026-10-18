import { screen, waitFor } from '@testing-library/react-native';
import { act } from 'react';
import { BackHandler, Platform } from 'react-native';

import '@/i18n';
import { tvFocus } from '@/components/focus/tv-focus';
import { renderWithProviders } from '@/../jest/render';

import { Sheet, SheetItem } from '../sheet';

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

const focused = () =>
  (tvFocus as jest.Mock).mock.calls.map(
    ([target]) => (target as { props?: { accessibilityLabel?: string } })?.props?.accessibilityLabel
  );

type BackListener = Parameters<typeof BackHandler.addEventListener>[1];
let backHandlers: BackListener[] = [];
const pressBack = () => act(() => void backHandlers.at(-1)?.({} as never));

beforeEach(() => {
  backHandlers = [];
  mockModal.mockClear();
  (tvFocus as jest.Mock).mockClear();
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation((_event, handler) => {
    backHandlers.push(handler);
    return {
      remove: () => {
        backHandlers = backHandlers.filter((item) => item !== handler);
      },
    };
  });
});

afterEach(() => jest.restoreAllMocks());

const sheet = (open: boolean, onClose = jest.fn(), preferred?: string) => (
  <Sheet open={open} onClose={onClose} title="Audio" inline testID="panel">
    <SheetItem label="Deutsch" preferred={preferred === 'Deutsch'} onPress={() => undefined} />
    <SheetItem label="English" preferred={preferred === 'English'} onPress={() => undefined} />
  </Sheet>
);

describe('inline Sheet (Android TV player: no Modal window above the video)', () => {
  it('draws in the screen without a Modal and shows its options at once', async () => {
    await renderWithProviders(sheet(true));
    expect(mockModal).not.toHaveBeenCalled();
    expect(screen.getByTestId('panel')).toBeOnTheScreen();
    expect(screen.getByText('English')).toBeOnTheScreen();
  });

  it('is gone in the same render it closes, so the next Back belongs to the screen', async () => {
    const { rerender } = await renderWithProviders(sheet(true));
    await rerender(sheet(false));
    expect(screen.queryByTestId('panel')).toBeNull();
    expect(backHandlers).toHaveLength(0);
  });

  it('Back closes the panel once and is consumed', async () => {
    const onClose = jest.fn();
    await renderWithProviders(sheet(true, onClose));
    await pressBack();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves focus into the panel: the preferred option, else the first one', async () => {
    const { rerender } = await renderWithProviders(sheet(true, jest.fn(), 'English'));
    await waitFor(() => expect(focused()).toEqual(['English']));

    await rerender(sheet(false));
    (tvFocus as jest.Mock).mockClear();
    await rerender(sheet(true));
    await waitFor(() => expect(focused()).toEqual(['Deutsch']));
  });

  it('a Modal sheet keeps the system focus of its window (no first-option fallback)', async () => {
    await renderWithProviders(
      <Sheet open onClose={() => undefined} title="Audio">
        <SheetItem label="Deutsch" onPress={() => undefined} />
      </Sheet>
    );
    expect(mockModal).toHaveBeenCalled();
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(tvFocus).not.toHaveBeenCalled();
  });
});
