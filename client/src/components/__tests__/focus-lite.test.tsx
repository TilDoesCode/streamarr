import { act, fireEvent, screen } from '@testing-library/react-native';
import { Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { Focusable, FocusLift } from '@/components/focus';
import { ringStrength, timedLift } from '@/components/focus/focusable';
import { Text } from '@/components/ui/text';
import { writePerformancePreference } from '@/performance';
import { colors } from '@/theme';
import { renderWithProviders } from '@/../jest/render';

type MockTiming = { to: number; duration: number };
type MockBox = { value: number; from: number; to: number; start: number; duration: number };

// A Reanimated stand-in with a clock: shared values persist across renders and withTiming runs linearly in time.
jest.mock('react-native-reanimated', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const base = jest.requireActual('react-native-reanimated/mock');
  const clock = { now: 0 };
  const read = (box: MockBox) => {
    if (box.duration <= 0) return box.to;
    const t = Math.min(1, (clock.now - box.start) / box.duration);
    return box.from + (box.to - box.from) * t;
  };
  const make = (init: number) => {
    const box: MockBox = { value: init, from: init, to: init, start: 0, duration: 0 };
    return {
      get: () => read(box),
      set: (next: number | MockTiming) => {
        const current = read(box);
        if (typeof next === 'number') Object.assign(box, { from: next, to: next, duration: 0 });
        else
          Object.assign(box, {
            from: current,
            to: next.to,
            start: clock.now,
            duration: next.duration,
          });
      },
      get value() {
        return read(box);
      },
    };
  };
  return {
    ...base,
    __clock: clock,
    useReducedMotion: () => false,
    makeMutable: make,
    useSharedValue: (init: number) => React.useRef(make(init)).current,
    useDerivedValue: (fn: () => number) => ({
      get: fn,
      get value() {
        return fn();
      },
    }),
    useAnimatedStyle: (fn: () => object) => fn(),
    useAnimatedReaction: () => undefined,
    withTiming: (to: number, config?: { duration?: number }) => ({
      to,
      duration: config?.duration ?? 300,
    }),
    withSpring: (to: number) => to,
  };
});

const clock = jest.requireMock<{ __clock: { now: number } }>('react-native-reanimated').__clock;

const CARDS = ['a', 'b', 'c', 'd'];

function Row() {
  return (
    <>
      {CARDS.map((id) => (
        <Focusable key={id} testID={id} onPress={jest.fn()}>
          <FocusLift kind="card" radius={8} scale={1.1}>
            <Text testID={`${id}-label`}>{id}</Text>
          </FocusLift>
        </Focusable>
      ))}
    </>
  );
}

type HostNode = { props?: { style?: unknown }; children?: (HostNode | string)[] | null };

function hostNodes(): HostNode[] {
  const nodes: HostNode[] = [];
  const walk = (node: HostNode | HostNode[] | string | null) => {
    if (!node || typeof node === 'string') return;
    if (Array.isArray(node)) return node.forEach(walk);
    nodes.push(node);
    node.children?.forEach(walk);
  };
  walk(screen.toJSON() as HostNode | HostNode[] | null);
  return nodes;
}

/** The ring (focus colour border) and the lift (scale transform) of every card, as drawn now. */
function frame() {
  const styled = hostNodes().map(
    (node): ViewStyle => StyleSheet.flatten(node.props?.style as StyleProp<ViewStyle>) ?? {}
  );
  const rings = styled.filter((style) => style.borderColor === colors.focus.DEFAULT);
  const lifts = styled.filter((style) => !!style.transform);
  return {
    ring: rings.map((style) => Number(style.opacity)),
    glow: rings.map((style) => style.boxShadow),
    scale: lifts.map((style) =>
      (style.transform as unknown as { scale: number }[]).reduce(
        (product, step) => product * step.scale,
        1
      )
    ),
  };
}

async function draw(at: number) {
  clock.now = at;
  await screen.rerender(<Row />);
  return frame();
}

const move = (from: string | null, to: string) =>
  act(async () => {
    if (from) fireEvent(screen.getByTestId(from), 'blur', {});
    fireEvent(screen.getByTestId(to), 'focus', {});
  });

describe('focus animation', () => {
  afterEach(() => {
    writePerformancePreference('auto');
    jest.restoreAllMocks();
  });

  it('pure frames: the lite ring leaves at once, the timed lift never overshoots', () => {
    expect(ringStrength(0.6, 0, 0, true)).toBe(0);
    expect(ringStrength(0.6, 0, 0, false)).toBe(0.6);
    expect(ringStrength(0.3, 1, 0, true)).toBe(0.3);
    expect(timedLift(0.5, 0, 1.06)).toBeCloseTo(1.03);
    expect(timedLift(1.4, 0, 1.06)).toBeCloseTo(1.06);
    expect(timedLift(0, 0, 1.06)).toBe(1);
  });

  it('lite: rapid D-pad moves leave exactly one ring, on the focused card, and the lift animates', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    writePerformancePreference('on');
    clock.now = 0;
    await renderWithProviders(<Row />);
    await move(null, 'a');
    // Four presses 40 ms apart: faster than the 160 ms focus fade.
    for (const [index, [from, to]] of [
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
      ['d', 'c'],
    ].entries()) {
      clock.now = 40 * (index + 1);
      await move(from!, to!);
      const now = await draw(clock.now + 20);
      const lit = now.ring
        .map((opacity, card) => (opacity > 0 ? CARDS[card] : null))
        .filter(Boolean);
      expect(lit).toEqual([to]);
    }
    const mid = await draw(160 + 80);
    expect(mid.scale[2]).toBeGreaterThan(1);
    expect(mid.scale[2]).toBeLessThan(1.06);
    const settled = await draw(1000);
    expect(settled.ring).toEqual([0, 0, 1, 0]);
    expect(settled.scale.map((scale) => Number(scale.toFixed(3)))).toEqual([1, 1, 1.06, 1]);
    expect(settled.glow.every((glow) => glow === undefined)).toBe(true);
  });

  it('full UI: the spring lift reaches the full scale and the ring glows', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    writePerformancePreference('off');
    clock.now = 0;
    await renderWithProviders(<Row />);
    await move(null, 'b');
    const settled = await draw(1000);
    expect(settled.ring).toEqual([0, 1, 0, 0]);
    expect(settled.scale[1]).toBeCloseTo(1.1);
    expect(settled.glow[1]).toBeTruthy();
  });
});
