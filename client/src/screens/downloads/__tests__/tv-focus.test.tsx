import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import {
  clearWorld,
  open,
  resetWorld,
  startThroughCore,
  WAIT,
  world,
} from '@/../jest/downloads-ui-world';
import * as focusModule from '@/components/focus/tv-focus';

jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const WORK = 'tmdb-movie-123';
const control = (action: string) => screen.getByTestId(`download-${WORK}-${action}`);
const tvFocus = () => jest.spyOn(focusModule, 'tvFocus');
// The host views focus was handed to (printing them whole would not end: they reference their fibers).
const focusedIds = (focus: ReturnType<typeof tvFocus>) =>
  focus.mock.calls.map(
    ([target]) => (target as { props?: { testID?: string } } | null)?.props?.testID
  );

beforeEach(async () => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  await resetWorld();
});
afterEach(() => {
  clearWorld();
  jest.restoreAllMocks();
});

/** Focuses the primary action and presses select on it, as the D-pad does. */
async function select(action: string, find = control) {
  const button = find(action);
  await fireEvent(button, 'focus', {});
  await fireEvent.press(button);
  return button;
}

/** Still the same mounted control, reachable and enabled (a disabled view drops the focus on Android). */
function expectHoldsFocus(button: ReturnType<typeof control>, label: RegExp) {
  expect(button.props.accessibilityLabel).toMatch(label);
  expect(button).not.toHaveProp('focusable', false);
  expect(button).toBeEnabled();
}

describe('TV: the primary action of a download row keeps the focus while its state changes', () => {
  it('Pause → Resume → Pause: one control, relabelled, focus never moved', async () => {
    await open('/downloads');
    const id = await startThroughCore(WORK, { title: 'Sintel' });
    const focus = tvFocus();
    const button = await select('pause');
    await waitFor(() => expect(world.downloads!.store.get(id)?.state).toBe('paused'), WAIT);
    expect(control('resume')).toBe(button);
    expectHoldsFocus(button, /^Resume /);

    await fireEvent.press(button);
    await waitFor(() => expect(world.downloads!.store.get(id)?.state).toBe('downloading'), WAIT);
    expect(control('pause')).toBe(button);
    expectHoldsFocus(button, /^Pause /);
    expect(focusedIds(focus)).toEqual([]);
  });

  it('Retry → downloading: the Retry control becomes Pause', async () => {
    await open('/downloads');
    const id = await startThroughCore(WORK, { title: 'Sintel' });
    await act(async () => world.downloads!.engine.controls.fail(id, 'network'));
    await waitFor(() => expect(control('retry')).toBeOnTheScreen(), WAIT);
    const focus = tvFocus();
    const button = await select('retry');
    await waitFor(() => expect(world.downloads!.store.get(id)?.state).toBe('downloading'), WAIT);
    expect(control('pause')).toBe(button);
    expectHoldsFocus(button, /^Pause /);
    expect(focusedIds(focus)).toEqual([]);
  });
});

describe('TV: the detail page download card keeps the focus on its primary action', () => {
  it('Pause → Resume → Pause: one control, Cancel never takes the focus', async () => {
    await open('/movie/123');
    const id = await startThroughCore(WORK, { title: 'Sintel' });
    const card = (action: string) => screen.getByTestId(`detail-download-${action}`);
    await waitFor(() => expect(card('pause')).toBeOnTheScreen(), WAIT);
    const focus = tvFocus();
    const button = await select('pause', card);
    await waitFor(() => expect(world.downloads!.store.get(id)?.state).toBe('paused'), WAIT);
    await waitFor(() => expect(card('resume')).toBe(button), WAIT);
    expectHoldsFocus(button, /^Resume /);

    await fireEvent.press(button);
    await waitFor(() => expect(world.downloads!.store.get(id)?.state).toBe('downloading'), WAIT);
    await waitFor(() => expect(card('pause')).toBe(button), WAIT);
    expectHoldsFocus(button, /^Pause /);
    expect(focusedIds(focus)).toEqual([]);
  });
});

describe('TV: Delete never receives the focus from a state change', () => {
  it('a primary action that goes away hands the focus to the row, not to Delete', async () => {
    await open('/downloads');
    const id = await startThroughCore(WORK, { title: 'Sintel' });
    const focus = tvFocus();
    await fireEvent(control('pause'), 'focus', {});
    // The release died: no retry, so the row has no primary action any more.
    await act(async () => {
      world.downloads!.store.update(id, {
        state: 'failed',
        error: { code: 'release_dead', actions: ['otherVersion'], at: 0 },
      });
    });
    await waitFor(() => expect(screen.queryByTestId(`download-${WORK}-pause`)).toBeNull(), WAIT);
    const row = control('row');
    expect(focusedIds(focus)).toEqual([`download-${WORK}-row`]);
    expect(row).toHaveProp('focusable', true);
  });
});
