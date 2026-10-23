import { act, render } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import i18n from '@/i18n';

import { NativeTabsShell } from './native-tabs-shell';

const mockTriggers = new Map<string, Record<string, unknown>>();
let mockBadge = 0;
jest.mock('@/mylist/queries', () => ({ useMyListBadge: () => mockBadge }));
let mockDot = false;
jest.mock('@/diagnostics/service-status-ui', () => ({ useSettingsTabDot: () => mockDot }));
jest.mock('expo-router/unstable-native-tabs', () => {
  const Trigger = (props: { name: string; children?: ReactNode }) => {
    mockTriggers.set(props.name, props);
    return <>{props.children}</>;
  };
  Trigger.Icon = function Icon() {
    return null;
  };
  Trigger.Label = function Label({ children }: { children?: ReactNode }) {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    return <Text>{children}</Text>;
  };
  Trigger.Badge = function Badge({ children, hidden }: { children?: ReactNode; hidden?: boolean }) {
    const { Text } = jest.requireActual<typeof import('react-native')>('react-native');
    // No text is the native dot.
    if (hidden) return null;
    return children ? <Text testID="tab-badge">{children}</Text> : <Text testID="tab-dot" />;
  };
  return {
    NativeTabs: Object.assign(({ children }: { children?: ReactNode }) => <>{children}</>, {
      Trigger,
    }),
  };
});

describe('NativeTabsShell', () => {
  afterAll(() => i18n.changeLanguage('en'));

  it('follows a live language switch in labels and accessibility labels', async () => {
    await act(() => i18n.changeLanguage('en'));
    const screen = await render(<NativeTabsShell />);
    expect(screen.getByText('Settings')).toBeTruthy();
    expect(mockTriggers.get('(settings)')?.accessibilityLabel).toBe('Settings');
    await act(() => i18n.changeLanguage('de'));
    expect(screen.getByText('Einstellungen')).toBeTruthy();
    expect(mockTriggers.get('(settings)')?.accessibilityLabel).toBe('Einstellungen');
    expect(mockTriggers.get('(home)')?.accessibilityLabel).toBe('Start');
    expect(screen.getByText('Meine Liste')).toBeTruthy();
  });

  it('shows the count of new episodes on the My List tab only while there is one', async () => {
    mockBadge = 0;
    const screen = await render(<NativeTabsShell />);
    expect(screen.queryByTestId('tab-badge')).toBeNull();
    mockBadge = 12;
    await screen.rerender(<NativeTabsShell />);
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('9+');
    mockBadge = 2;
    await screen.rerender(<NativeTabsShell />);
    expect(screen.getByTestId('tab-badge')).toHaveTextContent('2');
  });

  it('marks the Settings tab with a dot only while a server service has a problem', async () => {
    mockBadge = 0;
    mockDot = false;
    const screen = await render(<NativeTabsShell />);
    expect(screen.queryByTestId('tab-dot')).toBeNull();
    mockDot = true;
    await screen.rerender(<NativeTabsShell />);
    expect(screen.getAllByTestId('tab-dot')).toHaveLength(1);
    mockDot = false;
  });
});
