import { fireEvent, screen } from '@testing-library/react-native';

import { describeError } from '@/api/error-text';
import i18n from '@/i18n';
import { renderWithProviders } from '@/../jest/render';
import { PlayerErrorBoundary } from '@/screens/player/player-error-boundary';

const mockRouter = { back: jest.fn(), replace: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

describe('PlayerErrorBoundary', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('shows the player card for a render error, with retry and back', async () => {
    const retry = jest.fn(async () => undefined);
    await renderWithProviders(
      <PlayerErrorBoundary error={new Error('render broke')} retry={retry} />
    );
    const text = describeError(i18n.t, { code: 'player_internal_error' });
    expect(screen.getByText(text.title)).toBeOnTheScreen();
    await fireEvent.press(screen.getByText(i18n.t('errors.actions.retry')));
    expect(retry).toHaveBeenCalled();
    await fireEvent.press(screen.getByText(i18n.t('errors.actions.back')));
    expect(mockRouter.back).toHaveBeenCalled();
  });
});
