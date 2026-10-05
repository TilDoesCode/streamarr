import { screen } from '@testing-library/react-native';
import { Platform, StyleSheet } from 'react-native';

import i18n from '@/i18n';
import { PlayerStatusView } from '@/screens/player/player-status';
import { colors } from '@/theme';
import { renderWithProviders } from '@/../jest/render';

beforeAll(() => i18n.changeLanguage('en'));
afterEach(() => jest.restoreAllMocks());

describe('status hint buttons and focus (E12, review M15, S9a D10)', () => {
  const status = {
    spinner: false,
    hint: { key: 'reconnecting' as const, params: { seconds: 4 } },
    actions: ['tryNow' as const, 'back' as const],
  };

  it('touch: buttons, none of them asks for the preferred focus', async () => {
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    for (const action of ['tryNow', 'back'])
      expect(screen.getByTestId(`player-status-action-${action}`)).toHaveProp(
        'hasTVPreferredFocus',
        false
      );
  });

  it('the label is plain text in its own colour, never clamped to one line (empty pill on iPhone Safari)', async () => {
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    const label = screen.getByTestId('player-status-action-tryNow-label');
    expect(label).toHaveTextContent('Try now');
    expect(label.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(label.props.style).color).toBe(colors.primary.foreground);
  });

  it('TV: no buttons at all, so nothing can take the focus', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    expect(screen.queryByTestId('player-status-action-tryNow')).toBeNull();
  });
});
