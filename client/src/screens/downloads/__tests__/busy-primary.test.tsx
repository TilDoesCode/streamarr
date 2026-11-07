import { act, fireEvent, screen, waitFor } from 'expo-router/testing-library';
import { Platform } from 'react-native';

import { clearWorld, GB, open, resetWorld, WAIT, world } from '@/../jest/downloads-ui-world';

jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const sintel = {
  workId: 'tmdb-movie-123',
  meta: { title: 'Sintel' },
  completedAt: null,
  sizeBytes: 2 * GB,
  bytesWritten: GB / 2,
};
const SCREENS = [
  ['the Downloads list', '/downloads', 'download-tmdb-movie-123-pause'],
  ['the detail card', '/movie/123', 'detail-download-pause'],
] as const;

beforeEach(() => {
  jest.replaceProperty(Platform, 'OS', 'android');
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  clearWorld();
  jest.restoreAllMocks();
});

/** Reachable by the D-pad and not natively disabled (Android would drop the focus), yet reported busy. */
function expectBusyButFocusable(button: ReturnType<typeof screen.getByTestId>, label: string) {
  expect(button).toHaveProp('focusable', true);
  expect(button).toBeEnabled();
  expect(button.props.accessibilityState?.busy).toBe(true);
  expect(button).toHaveProp('accessibilityLabel', label);
}

describe('C4-05: an inert primary tells assistive tech why it cannot act', () => {
  it.each(SCREENS)(
    '%s: verifying reads "Checking the file", busy; a press does nothing',
    async (_, path, id) => {
      await resetWorld([{ ...sintel, state: 'verifying' }]);
      await open(path);
      const button = await screen.findByTestId(id, {}, WAIT);
      expectBusyButFocusable(button, 'Sintel: Checking the file');
      const pause = jest.spyOn(world.downloads!.manager, 'pause');
      await fireEvent.press(button);
      expect(pause).not.toHaveBeenCalled();
      expect(world.downloads!.store.all()[0]!.state).toBe('verifying');
    }
  );

  it.each([
    ['downloading', 'pause', 'Sintel: Pausing…'],
    ['paused', 'resume', 'Sintel: Resuming…'],
  ] as const)(
    'the detail card while the engine is still %s → %s: busy with what it waits for; a press does nothing',
    async (state, action, label) => {
      await resetWorld([{ ...sintel, state }]);
      await open('/movie/123');
      const button = await screen.findByTestId(`detail-download-${action}`, {}, WAIT);
      let finish = () => undefined as void;
      const call = jest
        .spyOn(world.downloads!.manager, action)
        .mockImplementation(() => new Promise<void>((done) => void (finish = done)));
      await fireEvent.press(button);
      expect(call).toHaveBeenCalledTimes(1);
      expectBusyButFocusable(button, label);
      await fireEvent.press(button);
      expect(call).toHaveBeenCalledTimes(1);
      await act(async () => finish());
      await waitFor(() => expect(button.props.accessibilityState?.busy).toBeFalsy());
      expect(button.props.accessibilityLabel).toMatch(action === 'pause' ? /^Pause / : /^Resume /);
    }
  );
});
