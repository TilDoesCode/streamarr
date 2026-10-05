import { Platform } from 'react-native';

import i18n from '@/i18n';
import { PlayerStatusView } from '@/screens/player/player-status';
import { renderWithProviders } from '@/../jest/render';

const mockButtons: Record<string, unknown>[] = [];
jest.mock('@/components/glass', () => {
  const actual = jest.requireActual('@/components/glass');
  return {
    ...actual,
    GlassButton: (props: Record<string, unknown>) => {
      mockButtons.push(props);
      return actual.GlassButton(props);
    },
  };
});

beforeAll(() => i18n.changeLanguage('en'));
beforeEach(() => mockButtons.splice(0));

describe('status hint buttons and focus (E12, review M15)', () => {
  const status = {
    spinner: false,
    hint: { key: 'reconnecting' as const, params: { seconds: 4 } },
    actions: ['tryNow' as const, 'back' as const],
  };

  it('touch: buttons, none of them asks for the preferred focus', async () => {
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    expect(mockButtons.map((props) => props.testID)).toEqual(
      expect.arrayContaining(['player-status-action-tryNow', 'player-status-action-back'])
    );
    expect(mockButtons.every((props) => props.hasTVPreferredFocus === false)).toBe(true);
  });

  it('TV: no buttons at all, so nothing can take the focus', async () => {
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    await renderWithProviders(<PlayerStatusView status={status} onAction={jest.fn()} />);
    expect(mockButtons).toHaveLength(0);
    jest.restoreAllMocks();
  });
});
