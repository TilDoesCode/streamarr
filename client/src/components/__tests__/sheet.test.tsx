import { act, fireEvent, screen, userEvent, within } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';
import type { TestInstance } from 'test-renderer';

import { FocusLayer } from '@/components/focus';
import { focusTopLayer } from '@/components/focus/focus-layer';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import i18n from '@/i18n';
import { motion } from '@/theme';
import { renderWithProviders } from '@/../jest/render';

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

// react-native-tvos adds requestTVFocus() to host views; record it by accessibility label.
const tvFocus = jest.fn();
beforeAll(() => {
  const View = jest.requireMock<{ default: { prototype: object } }>(
    'react-native/Libraries/Components/View/View'
  ).default;
  Object.assign(View.prototype, {
    requestTVFocus(this: { props: { accessibilityLabel?: string } }) {
      tvFocus(this.props.accessibilityLabel);
    },
  });
});

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const OPTIONS = ['English', 'German', 'Commentary'];

// Host elements below `root` whose props match (RNTL 14 has no *ByType queries).
function findAll(root: TestInstance, match: (props: Record<string, unknown>) => boolean) {
  const found: TestInstance[] = [];
  const visit = (node: TestInstance | string) => {
    if (typeof node === 'string') return;
    if (match(node.props)) found.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  return found;
}

function modalShown() {
  return JSON.stringify(screen.toJSON()).includes('"type":"Modal"');
}

function radioGroup() {
  const [group] = findAll(screen.getByTestId('sheet-options'), (p) => p.role === 'radiogroup');
  if (!group) throw new Error('no radiogroup');
  return group;
}

function sheet(open: boolean, onClose = jest.fn(), onPick = jest.fn()) {
  return (
    <Sheet testID="sheet" open={open} onClose={onClose} title="Audio">
      {OPTIONS.map((label, index) => (
        <SheetItem
          key={label}
          label={label}
          selected={index === 1}
          preferred={index === 1}
          onPress={() => onPick(label)}
        />
      ))}
    </Sheet>
  );
}

describe('Sheet', () => {
  it('renders nothing while closed', async () => {
    await renderWithProviders(sheet(false));
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(modalShown()).toBe(false);
  });

  it('opens as a labelled dialog whose resting style is on screen (no transform)', async () => {
    await renderWithProviders(sheet(true));
    const panel = screen.getByTestId('sheet');
    expect(panel).toHaveProp('role', 'dialog');
    expect(panel).toHaveAccessibleName('Audio');
    // Regression: the slide is a mount animation; a lost animation frame must not leave it off screen.
    const style = StyleSheet.flatten(panel.props.style);
    expect(style.transform).toBeUndefined();
    expect(style).toMatchObject({ position: 'absolute', right: 0, top: 0, bottom: 0 });
    expect(screen.getByText('Audio')).toBeOnTheScreen();
  });

  it('lists the options as one radio group inside a scroll view', async () => {
    await renderWithProviders(sheet(true));
    expect(screen.getByTestId('sheet-options').type).toBe('RCTScrollView');
    const group = radioGroup();
    expect(group).toHaveProp('aria-label', 'Audio');
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect(within(group).getByRole('radio', { name: 'German' })).toBeChecked();
  });

  it('scrolls and shows a divider under the title only once the options overflow', async () => {
    await renderWithProviders(sheet(true));
    const options = screen.getByTestId('sheet-options');
    await fireEvent(options, 'layout', { nativeEvent: { layout: { height: 300 } } });
    await fireEvent(options, 'contentSizeChange', 400, 200);
    expect(options).toHaveProp('scrollEnabled', false);
    expect(options).toHaveStyle({ borderTopWidth: 0 });
    await fireEvent(options, 'contentSizeChange', 400, 900);
    expect(options).toHaveProp('scrollEnabled', true);
    expect(options).toHaveStyle({ borderTopWidth: 1 });
  });

  it('picks an option and closes on the scrim', async () => {
    const onClose = jest.fn();
    const onPick = jest.fn();
    await renderWithProviders(sheet(true, onClose, onPick));
    const user = userEvent.setup();
    await user.press(screen.getByRole('radio', { name: 'Commentary' }));
    expect(onPick).toHaveBeenCalledWith('Commentary');
    // The scrim sits beside the aria-modal panel, so screen readers skip it (back/Escape close instead).
    await fireEvent.press(screen.getByLabelText('Dismiss', { includeHiddenElements: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('removes the panel on close and hides the modal once the exit has played', async () => {
    jest.useFakeTimers();
    const view = await renderWithProviders(sheet(true));
    await view.rerender(sheet(false));
    expect(screen.queryByTestId('sheet')).toBeNull();
    expect(modalShown()).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(motion.exit + 100);
    });
    expect(modalShown()).toBe(false);
    await view.rerender(sheet(true));
    expect(screen.getByTestId('sheet')).toBeOnTheScreen();
  });

  it('hides the focus look of the screen below while open', async () => {
    const view = await renderWithProviders(sheet(true));
    expect(focusTopLayer().get()).toBe(1);
    await view.rerender(sheet(false));
    expect(focusTopLayer().get()).toBe(0);
  });
});

describe('Sheet on TV', () => {
  beforeEach(() => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
  });

  it('focuses the preferred option after mount, traps focus and centres the focused option', async () => {
    tvFocus.mockClear();
    await renderWithProviders(sheet(true));
    expect(screen.getByTestId('sheet-options')).toHaveProp('snapToAlignment', 'item');
    const group = radioGroup();
    for (const side of ['Up', 'Down', 'Left', 'Right'])
      expect(group.props[`trapFocus${side}`]).toBe(true);
    expect(screen.getByRole('radio', { name: 'German' })).toHaveProp('scrollSnapAlign', 'center');
    // Requested a frame after mount (rows attached), only for the preferred option.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(tvFocus.mock.calls).toEqual([['German']]);
  });
});

describe('FocusLayer', () => {
  const layers = (first: boolean, second: boolean) => (
    <>
      <FocusLayer open={first}>
        <Text>{'a'}</Text>
      </FocusLayer>
      <FocusLayer open={second}>
        <Text>{'b'}</Text>
      </FocusLayer>
    </>
  );

  it('keeps the layer raised while a sibling overlay is still open', async () => {
    const view = await renderWithProviders(layers(true, true));
    expect(focusTopLayer().get()).toBe(1);
    await view.rerender(layers(false, true));
    expect(focusTopLayer().get()).toBe(1);
    await view.rerender(layers(false, false));
    expect(focusTopLayer().get()).toBe(0);
  });

  it('tracks nested overlays', async () => {
    const nested = (inner: boolean) => (
      <FocusLayer open>
        <FocusLayer open={inner}>
          <Text>{'x'}</Text>
        </FocusLayer>
      </FocusLayer>
    );
    const view = await renderWithProviders(nested(true));
    expect(focusTopLayer().get()).toBe(2);
    await view.rerender(nested(false));
    expect(focusTopLayer().get()).toBe(1);
    await act(async () => view.unmount());
    expect(focusTopLayer().get()).toBe(0);
  });
});
