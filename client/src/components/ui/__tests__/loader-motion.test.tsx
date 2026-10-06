import { act, screen } from '@testing-library/react-native';
import { NavigationContext } from 'expo-router/react-navigation';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { StyleSheet } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import '@/i18n';
import { renderWithProviders } from '@/../jest/render';

/** A screen's navigation object whose focus the test switches like a close or a push would. */
function fakeScreen() {
  let focused = true;
  const listeners = new Map<string, Set<() => void>>();
  const navigation = {
    isFocused: () => focused,
    addListener: (event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => void set.delete(listener);
    },
  };
  const emit = async (event: 'focus' | 'blur') => {
    focused = event === 'focus';
    await act(async () => listeners.get(event)?.forEach((listener) => listener()));
  };
  return { navigation: navigation as never, emit, listeners };
}

const animationOf = (testID: string) =>
  StyleSheet.flatten(screen.getByTestId(testID, { includeHiddenElements: true }).props.style)
    .animationName;

describe('endless loaders stop when their screen closes (F12, R1 release logs)', () => {
  it.each([
    ['spinner', <Spinner key="s" testID="loader" />],
    ['skeleton', <Skeleton key="k" height={20} testID="loader" />],
  ])(
    '%s: animates while its screen is focused, stops at the blur a close starts with, and unsubscribes on unmount',
    async (_, loader) => {
      const { navigation, emit, listeners } = fakeScreen();
      const view = await renderWithProviders(
        <NavigationContext value={navigation}>{loader}</NavigationContext>
      );
      expect(animationOf('loader')).toBeDefined();
      await emit('blur');
      expect(animationOf('loader')).toBeUndefined();
      await emit('focus');
      expect(animationOf('loader')).toBeDefined();
      await view.unmount();
      expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    }
  );

  it('outside a navigator (gallery, tests) a loader still animates', async () => {
    await renderWithProviders(<Spinner testID="loader" />);
    expect(animationOf('loader')).toBeDefined();
  });

  it('every endless animation in src stops with its screen (static guard)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== '__tests__') walk(path);
        } else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(path);
      }
    };
    walk(join(__dirname, '../../..'));
    const unguarded = files.filter((path) => unguardedLoops(readFileSync(path, 'utf8')) > 0);
    expect(unguarded).toEqual([]);
  });

  it('the guard sees every loop form, one stop per loop (verify B4, B5)', () => {
    expect(unguardedLoops(`{ animationIterationCount: "infinite" }`)).toBe(1);
    expect(unguardedLoops(`{ animationIterationCount: 'infinite' }`)).toBe(1);
    expect(unguardedLoops('Animated.loop(Animated.timing(value, {}))')).toBe(1);
    expect(unguardedLoops('withRepeat(withTiming(1), -1)')).toBe(1);
    const twoLoops = `useLoaderMotion(); withRepeat(a); withRepeat(b);`;
    expect(unguardedLoops(twoLoops)).toBe(1);
    expect(unguardedLoops(`useLoaderMotion(); { animationIterationCount: 'infinite' }`)).toBe(0);
  });
});

/** Endless loops in a source file minus their stops (each loop needs its own useLoaderMotion or cancelAnimation). */
function unguardedLoops(source: string): number {
  const count = (pattern: RegExp) => source.match(pattern)?.length ?? 0;
  const loops =
    count(/animationIterationCount:\s*(?:'infinite'|"infinite"|`infinite`|Infinity\b)/g) +
    count(/withRepeat\(/g) +
    count(/Animated\.loop\(/g);
  return Math.max(0, loops - count(/useLoaderMotion\(\)/g) - count(/cancelAnimation\(/g));
}
