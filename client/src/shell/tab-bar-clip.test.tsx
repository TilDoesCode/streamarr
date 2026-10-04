import { render, screen } from '@testing-library/react-native';
import { Platform, Text } from 'react-native';

import { SHELL } from './shell-metrics';
import { TabBarClip } from './tab-bar-clip';

jest.mock('./use-shell', () => ({ useShell: () => ({ s: (value: number) => value }) }));

const os = Platform.OS;
afterEach(() => {
  Platform.OS = os;
  jest.restoreAllMocks();
});

describe('TabBarClip (I4 item 5: Settings under the Apple TV tab bar)', () => {
  it('starts the page at the tab bar bottom edge on Apple TV', async () => {
    Platform.OS = 'ios';
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await render(
      <TabBarClip>
        <Text>page</Text>
      </TabBarClip>
    );
    expect(screen.getByTestId('tab-bar-clip')).toHaveStyle({ marginTop: SHELL.tvosTabBarBottom });
  });

  it.each([
    ['android', true],
    ['ios', false],
  ] as const)('leaves %s (TV %s) unchanged', async (osName, tv) => {
    Platform.OS = osName;
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(tv);
    await render(
      <TabBarClip>
        <Text>page</Text>
      </TabBarClip>
    );
    expect(screen.queryByTestId('tab-bar-clip')).toBeNull();
    expect(screen.getByText('page')).toBeTruthy();
  });
});
