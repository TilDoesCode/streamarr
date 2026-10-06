import { act, fireEvent, screen } from '@testing-library/react-native';
import { FlatList, Platform, Pressable } from 'react-native';
import type { TestInstance } from 'test-renderer';

import {
  END_OF_ROW,
  Focusable,
  FocusGuide,
  FocusLayer,
  FocusLift,
  FocusMemoryContext,
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

describe('Text on TV', () => {
  it('is never selectable (a selectable Android TextView steals remote focus when attached)', async () => {
    await renderWithProviders(
      <Text testID="message" selectable>
        {'m'}
      </Text>
    );
    expect(screen.getByTestId('message').props.selectable).toBe(false);
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

  it('reports its focus to the screen memory and is forgotten when it unmounts', async () => {
    const memory = { remember: jest.fn(), forget: jest.fn() };
    const view = { requestTVFocus: jest.fn() };
    const { unmount } = await renderWithProviders(
      <FocusMemoryContext value={memory}>
        <Focusable testID="card" onPress={jest.fn()}>
          <Text>{'a'}</Text>
        </Focusable>
      </FocusMemoryContext>
    );
    await act(async () => {
      fireEvent(screen.getByTestId('card'), 'focus', { currentTarget: view });
    });
    expect(memory.remember).toHaveBeenCalledWith(view);
    await act(async () => unmount());
    expect(memory.forget).toHaveBeenCalledWith(view);
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

  it('scrolls the page back to its top for the first section (pageTop)', async () => {
    await renderWithProviders(
      <FocusSection testID="section" pageTop>
        <Text>{'x'}</Text>
      </FocusSection>
    );
    await layout(screen.getByTestId('section'), 200);
    expect(screen.getByTestId('section').props.scrollSnapAlign).toBeUndefined();
    expect(screen.getByTestId('section').props.scrollSnapOffset).toBeGreaterThan(10_000);
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
    // Offsets include the 48 dp TV gutter; the gap is the 40 pt card gap scaled to the 750 dp window (15.5 dp).
    expect(list?.props.getItemLayout(null, 3)).toEqual({
      length: 115.5,
      offset: 48 + 3 * 115.5,
      index: 3,
    });
    // The last card has no trailing gap: content ends at the right gutter (no trailing gap).
    expect(list?.props.getItemLayout(null, 19)).toEqual({
      length: 100,
      offset: 48 + 19 * 115.5,
      index: 19,
    });
    expect(list?.props.contentContainerStyle).not.toHaveProperty('gap');
    expect(screen.getByTestId('item-3').parent).toHaveStyle({ marginRight: 15.5 });
    expect(list?.props.contentOffset).toBeUndefined();
    await fireEvent(screen.getByTestId('item-5').parent as TestInstance, 'focus', {});
    await act(async () => first.unmount());

    await renderWithProviders(shelf);
    const restored = ancestorWith(screen.getByTestId('item-5'), 'contentOffset');
    expect(restored?.props.contentOffset).toEqual({ x: 5 * 115.5, y: 0 });
    // The cards before the remembered one render too (initialScrollIndex would leave them blank).
    expect(restored?.props.initialScrollIndex).toBeUndefined();
    expect(screen.getByTestId('item-0')).toBeOnTheScreen();
  });

  it('renders a remembered item beyond the first batch, so focus can return to it', async () => {
    const long = <Shelf {...shelf.props} memoryKey="tv.long" />;
    // Two visits: the first batch (12) reaches item 10, a restore at 10 reaches item 15.
    for (const index of [10, 15]) {
      const view = await renderWithProviders(long);
      await fireEvent(screen.getByTestId(`item-${index}`).parent as TestInstance, 'focus', {});
      await act(async () => view.unmount());
    }
    await renderWithProviders(long);
    expect(screen.getByTestId('item-15')).toBeOnTheScreen();
  });

  it('keeps the first batch small for a far remembered card and scrolls to it after layout (F10 P3-7)', async () => {
    const many = Array.from({ length: 100 }, (_, index) => `item-${index}`);
    const long = <Shelf {...shelf.props} memoryKey="tv.far" data={many} />;
    const stride = 115.5;
    // What the native row reports: its size, the content size, then a scroll to `x`.
    const scrollTo = async (x: number) => {
      const list = ancestorWith(screen.getByTestId('item-0'), 'getItemLayout') as TestInstance;
      const size = { width: 800, height: 200 };
      await fireEvent(list, 'layout', { nativeEvent: { layout: { x: 0, y: 0, ...size } } });
      await fireEvent(list, 'contentSizeChange', 48 * 2 + 100 * stride, 200);
      await fireEvent(list, 'scroll', {
        nativeEvent: {
          contentOffset: { x, y: 0 },
          contentSize: { width: 48 * 2 + 100 * stride, height: 200 },
          layoutMeasurement: size,
        },
      });
    };
    const first = await renderWithProviders(long);
    await scrollTo(80 * stride);
    await fireEvent(screen.getByTestId('item-80').parent as TestInstance, 'focus', {});
    await act(async () => first.unmount());

    const scrolled = jest.spyOn(FlatList.prototype, 'scrollToOffset');
    await renderWithProviders(long);
    // Before: the first batch was 80 + 12 cards, and VirtualizedList never unmounts it.
    expect(screen.getAllByTestId(/^item-/).length).toBeLessThanOrEqual(12);
    await scrollTo(0);
    expect(scrolled).toHaveBeenCalledWith({ offset: 80 * stride, animated: false });
    await scrollTo(80 * stride);
    expect(screen.getByTestId('item-80')).toBeOnTheScreen();
    expect(screen.queryByTestId('item-20')).toBeNull();
  });

  it('renders the first card on a remount with a remembered item, before the row has focus (F10 S4y-9)', async () => {
    const row = (data: string[]) => (
      <Shelf
        title="Continue"
        memoryKey="tv.short"
        data={data}
        keyExtractor={(item) => item}
        itemWidth={100}
        artworkHeight={56}
        renderItem={({ item }) => (
          <Pressable testID={item}>
            <Text>{item}</Text>
          </Pressable>
        )}
      />
    );
    const first = await renderWithProviders(row(['cw-0', 'cw-1', 'cw-2']));
    await fireEvent(screen.getByTestId('cw-1').parent as TestInstance, 'focus', {});
    await act(async () => first.unmount());

    // A short row cannot scroll to the remembered offset, so no scroll event ever widens the window.
    await renderWithProviders(row(['cw-0', 'cw-1', 'cw-2']));
    expect(screen.getByTestId('cw-0')).toBeOnTheScreen();
    expect(screen.getByTestId('cw-1')).toBeOnTheScreen();
  });

  it('does not restore off TV', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(false);
    await renderWithProviders(shelf);
    expect(ancestorWith(screen.getByTestId('item-0'), 'contentOffset')).toBeNull();
  });
});

describe('FocusGuide with destinations on Apple TV', () => {
  const os = Platform.OS;
  afterEach(() => {
    Platform.OS = os;
  });

  it('keeps autoFocus so the guide itself never takes focus when a destination does not resolve', async () => {
    Platform.OS = 'ios';
    await renderWithProviders(
      <FocusGuide testID="panel" remember={false} destinations={[]}>
        <Text>{'x'}</Text>
      </FocusGuide>
    );
    expect(screen.getByTestId('panel').props.autoFocus).toBe(true);
  });

  it('leaves Android TV guides as given', async () => {
    Platform.OS = 'android';
    await renderWithProviders(
      <FocusGuide testID="panel" remember={false} destinations={[]}>
        <Text>{'x'}</Text>
      </FocusGuide>
    );
    expect(screen.getByTestId('panel').props.autoFocus).toBe(false);
  });
});
