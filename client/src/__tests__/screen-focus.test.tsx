import { act, fireEvent, screen } from '@testing-library/react-native';
import { useEffect, type ReactNode, type Ref } from 'react';
import { Platform } from 'react-native';

import { Focusable } from '@/components/focus';
import { Text } from '@/components/ui/text';
import '@/i18n';
import {
  RESTORE_ATTEMPTS,
  RESTORE_INTERVAL_MS,
  ScreenFocusProvider,
  ScreenFocusScope,
  useScreenFocusHost,
} from '@/navigation/screen-focus';
import { renderWithProviders } from '@/../jest/render';

// The screen's native focus guide: Jest's host views have no requestTVFocus.
const mockGuideFocus = jest.fn();
jest.mock('@/components/focus/focus-guide', () => ({
  ...jest.requireActual('@/components/focus/focus-guide'),
  FocusGuide: function MockGuide({ ref, children }: { ref?: Ref<unknown>; children: ReactNode }) {
    jest.requireActual<typeof import('react')>('react').useImperativeHandle(ref, () => ({
      requestTVFocus: mockGuideFocus,
    }));
    return children;
  },
}));

type Listener = () => void;
const mockNavigation = {
  focused: true,
  listeners: new Map<string, Set<Listener>>(),
  isFocused() {
    return this.focused;
  },
  addListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    this.listeners.set(type, set);
    set.add(listener);
    return () => set.delete(listener);
  },
};

jest.mock('expo-router', () => ({ useNavigation: () => mockNavigation }));

/** The navigator shows (focus) or hides (blur) the screen. */
async function emit(type: 'focus' | 'blur') {
  mockNavigation.focused = type === 'focus';
  await act(async () => mockNavigation.listeners.get(type)?.forEach((listener) => listener()));
}

let shell: ReturnType<typeof useScreenFocusHost>;

function Shell({ showScreen }: { showScreen: boolean }) {
  const host = useScreenFocusHost();
  useEffect(() => {
    shell = host;
  });
  return (
    <ScreenFocusProvider value={host.host}>
      {showScreen ? (
        <ScreenFocusScope>
          <Focusable testID="card" onPress={jest.fn()}>
            <Text>{'a'}</Text>
          </Focusable>
        </ScreenFocusScope>
      ) : null}
    </ScreenFocusProvider>
  );
}

const guideRequests = () => mockGuideFocus.mock.calls.length;

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
}

/** A Focusable of the screen reports native focus (the view it hands to the screen memory). */
async function focusCard(view = { requestTVFocus: jest.fn() }) {
  await act(async () => {
    fireEvent(screen.getByTestId('card'), 'focus', { currentTarget: view });
  });
  return view;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  mockGuideFocus.mockClear();
  mockNavigation.focused = true;
  mockNavigation.listeners.clear();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('ScreenFocusScope on TV', () => {
  it('keeps its own initial focus when it opens without a request', async () => {
    await renderWithProviders(<Shell showScreen />);
    await advance(RESTORE_ATTEMPTS * RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(0);
  });

  it('takes focus after a rail tab switch and retries until one of its elements has it', async () => {
    const { rerender } = await renderWithProviders(<Shell showScreen={false} />);
    shell.focusNext();
    await act(async () => rerender(<Shell showScreen />));
    await advance(0);
    expect(guideRequests()).toBe(1);
    // First visit: the views were not attached yet, nothing took focus, so it asks again.
    await advance(RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(2);
    await focusCard();
    await advance(RESTORE_ATTEMPTS * RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(2);
  });

  it('gives up after a bounded number of attempts', async () => {
    const { rerender } = await renderWithProviders(<Shell showScreen={false} />);
    shell.focusNext();
    await act(async () => rerender(<Shell showScreen />));
    await advance(10 * RESTORE_ATTEMPTS * RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(RESTORE_ATTEMPTS);
  });

  it('gives focus back to the element that opened the screen above it', async () => {
    await renderWithProviders(<Shell showScreen />);
    const opener = await focusCard();
    await emit('blur');
    await emit('focus');
    await advance(0);
    expect(opener.requestTVFocus).toHaveBeenCalledTimes(1);
    await focusCard(opener);
    await advance(RESTORE_ATTEMPTS * RESTORE_INTERVAL_MS);
    expect(opener.requestTVFocus).toHaveBeenCalledTimes(1);
    expect(guideRequests()).toBe(0);
  });

  it('takes focus when it is first shown after mounting behind a deep-linked screen', async () => {
    mockNavigation.focused = false;
    await renderWithProviders(<Shell showScreen />);
    await advance(RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(0);
    await emit('focus');
    await advance(0);
    expect(guideRequests()).toBe(1);
  });

  it('hands focus to the visible screen when the rail closes and stops once it is gone', async () => {
    const { rerender } = await renderWithProviders(<Shell showScreen />);
    const last = await focusCard();
    expect(shell.focusActive()).toBe(true);
    await advance(0);
    expect(last.requestTVFocus).toHaveBeenCalledTimes(1);
    await act(async () => rerender(<Shell showScreen={false} />));
    expect(shell.focusActive()).toBe(false);
  });

  it('stops restoring when the screen is hidden again', async () => {
    const { rerender } = await renderWithProviders(<Shell showScreen={false} />);
    shell.focusNext();
    await act(async () => rerender(<Shell showScreen />));
    await advance(0);
    await emit('blur');
    await advance(RESTORE_ATTEMPTS * RESTORE_INTERVAL_MS);
    expect(guideRequests()).toBe(1);
  });
});
