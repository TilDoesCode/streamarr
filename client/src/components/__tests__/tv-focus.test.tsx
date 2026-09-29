import { act, fireEvent, screen } from '@testing-library/react-native';
import { Platform, Pressable } from 'react-native';
import type { TestInstance } from 'test-renderer';

import {
  END_OF_ROW,
  Focusable,
  FocusGuide,
  FocusLayer,
  FocusLift,
  FocusSection,
} from '@/components/focus';
import { focusTopLayer } from '@/components/focus/focus-layer';
import { Shelf } from '@/components/media/shelf';
import { ErrorState } from '@/components/states/error-state';
import { Text } from '@/components/ui/text';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

// RN's Jest mock of the native View lacks Commands; TVFocusGuideView sends setDestinations on TV.
jest.mock('react-native/Libraries/Components/View/ViewNativeComponent', () => ({
  ...jest.requireActual('@react-native/jest-preset/jest/mocks/ViewNativeComponent'),
  Commands: { setDestinations: jest.fn(), requestTVFocus: jest.fn() },
}));

// The TV code paths: Platform.isTV switches FocusGuide to TVFocusGuideView and DesignProvider to 'tv'.
beforeEach(() => {
  jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
});
afterEach(() => {
  jest.restoreAllMocks();
});

function layout(element: TestInstance, height: number) {
  return fireEvent(element, 'layout', {
    nativeEvent: { layout: { x: 0, y: 0, width: 800, height } },
  });
}

function ancestorWith(element: TestInstance, prop: string): TestInstance | null {
  let node: TestInstance | null = element;
  while (node && node.props[prop] === undefined) node = node.parent;
  return node;
}

describe('FocusGuide on TV', () => {
  it('maps remember to native autoFocus memory and traps only the given directions', async () => {
    await renderWithProviders(
      <>
        <FocusGuide testID="row" remember trap={END_OF_ROW}>
          <Text>{'x'}</Text>
        </FocusGuide>
        <FocusGuide testID="dialog" remember={false} trap={['up', 'down', 'left', 'right']}>
          <Text>{'y'}</Text>
        </FocusGuide>
      </>
    );
    const row = screen.getByTestId('row');
    expect(row.props.autoFocus).toBe(true);
    expect(row.props.trapFocusRight).toBe(true);
    expect(row.props.trapFocusLeft).toBeFalsy();
    expect(row.props.trapFocusUp).toBeFalsy();
    const dialog = screen.getByTestId('dialog');
    expect(dialog.props.autoFocus).toBe(false);
    for (const side of ['Up', 'Down', 'Left', 'Right'])
      expect(dialog.props[`trapFocus${side}`]).toBe(true);
  });
});

describe('EmptyState on TV', () => {
  it('keeps left and right inside its centred actions, but lets up and down leave', async () => {
    await renderWithProviders(
      <ErrorState code="age_restricted" actions={['goHome', 'back']} onAction={jest.fn()} />
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(2);
    const guide = ancestorWith(buttons[0]!, 'trapFocusLeft');
    expect(ancestorWith(buttons[1]!, 'trapFocusLeft')).toBe(guide);
    expect(guide?.props.trapFocusLeft).toBe(true);
    expect(guide?.props.trapFocusRight).toBe(true);
    expect(guide?.props.trapFocusUp).toBeFalsy();
    expect(guide?.props.trapFocusDown).toBeFalsy();
  });
});

describe('Focusable on TV', () => {
  it('requests preferred focus only when it can take focus', async () => {
    await renderWithProviders(
      <>
        <Focusable testID="preferred" hasTVPreferredFocus onPress={jest.fn()}>
          <Text>{'a'}</Text>
        </Focusable>
        <Focusable testID="disabled" hasTVPreferredFocus disabled onPress={jest.fn()}>
          <Text>{'b'}</Text>
        </Focusable>
      </>
    );
    expect(screen.getByTestId('preferred').props.hasTVPreferredFocus).toBe(true);
    expect(screen.getByTestId('disabled').props.hasTVPreferredFocus).toBeUndefined();
  });
});

describe('FocusSection on TV', () => {
  const tree = (
    <FocusSection testID="section">
      <Focusable testID="item" onPress={jest.fn()}>
        <FocusLift kind="none">
          <Text>{'x'}</Text>
        </FocusLift>
      </Focusable>
    </FocusSection>
  );

  it('snaps its own top while it fits the screen', async () => {
    await renderWithProviders(tree);
    await layout(screen.getByTestId('section'), 200);
    expect(screen.getByTestId('section').props.scrollSnapAlign).toBe('start');
    expect(screen.getByTestId('item').props.scrollSnapAlign).toBeUndefined();
  });

  it('centres each focused item instead when it is taller than the screen', async () => {
    await renderWithProviders(tree);
    await layout(screen.getByTestId('section'), 5000);
    expect(screen.getByTestId('section').props.scrollSnapAlign).toBeUndefined();
    expect(screen.getByTestId('item').props.scrollSnapAlign).toBe('center');
  });
});

describe('FocusLayer', () => {
  it('raises the top layer while an overlay is open and lowers it on close', async () => {
    const view = await renderWithProviders(
      <FocusLayer open>
        <Text>{'x'}</Text>
      </FocusLayer>
    );
    expect(focusTopLayer().get()).toBe(1);
    await view.rerender(
      <FocusLayer open={false}>
        <Text>{'x'}</Text>
      </FocusLayer>
    );
    expect(focusTopLayer().get()).toBe(0);
  });
});

describe('Shelf on TV', () => {
  const items = Array.from({ length: 20 }, (_, index) => `item-${index}`);
  const shelf = (
    <Shelf
      title="Row"
      memoryKey="tv.row"
      data={items}
      keyExtractor={(item) => item}
      itemWidth={100}
      artworkHeight={150}
      renderItem={({ item }) => (
        <Pressable testID={item}>
          <Text>{item}</Text>
        </Pressable>
      )}
    />
  );

  it('restores the remembered item after a remount, starting at the gutter', async () => {
    const first = await renderWithProviders(shelf);
    const list = ancestorWith(screen.getByTestId('item-0'), 'getItemLayout');
    // Offsets include the leading gutter (48 dp on TV), so FlatList's window math is exact.
    expect(list?.props.getItemLayout(null, 3)).toEqual({
      length: 114,
      offset: 48 + 3 * 114,
      index: 3,
    });
    // The last card has no trailing gap: content ends at the right gutter (no extra 14 dp).
    expect(list?.props.getItemLayout(null, 19)).toEqual({
      length: 100,
      offset: 48 + 19 * 114,
      index: 19,
    });
    expect(list?.props.contentContainerStyle).not.toHaveProperty('gap');
    expect(screen.getByTestId('item-3').parent).toHaveStyle({ marginRight: 14 });
    expect(list?.props.contentOffset).toBeUndefined();
    await fireEvent(screen.getByTestId('item-5').parent as TestInstance, 'focus', {});
    await act(async () => first.unmount());

    await renderWithProviders(shelf);
    const restored = ancestorWith(screen.getByTestId('item-5'), 'contentOffset');
    expect(restored?.props.contentOffset).toEqual({ x: 5 * 114, y: 0 });
    expect(restored?.props.initialScrollIndex).toBe(5);
  });

  it('does not restore off TV', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
    await renderWithProviders(shelf);
    expect(ancestorWith(screen.getByTestId('item-0'), 'contentOffset')).toBeNull();
  });
});
