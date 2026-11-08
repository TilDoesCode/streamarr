import { act, fireEvent, screen } from '@testing-library/react-native';
import { Platform } from 'react-native';

import i18n from '@/i18n';
import { PlayerOfferCard } from '@/screens/player/player-offer';
import { renderWithProviders } from '@/../jest/render';

afterAll(() => i18n.changeLanguage('en'));
afterEach(() => jest.restoreAllMocks());

describe('player offer card (owner decision 2026-11-06: offered, never switched)', () => {
  it('asks in German with Fortsetzen / Nein; Fortsetzen takes the remote focus', async () => {
    await act(() => i18n.changeLanguage('de'));
    jest.spyOn(Platform, 'isTV', 'get').mockReturnValue(true);
    const accept = jest.fn();
    const decline = jest.fn();
    await renderWithProviders(
      <PlayerOfferCard
        offer={{ kind: 'builtInPlayer', id: 1 }}
        onAccept={accept}
        onDecline={decline}
      />
    );
    expect(await screen.findByTestId('player-offer-builtInPlayer')).toHaveTextContent(
      'Die Wiedergabe ruckelt. Mit dem Streamarr-Player (ExoPlayer) fortsetzen?',
      { exact: false }
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.props.accessibilityLabel)).toEqual([
      'Fortsetzen',
      'Nein',
    ]);
    expect(buttons.map((button) => !!button.props.hasTVPreferredFocus)).toEqual([true, false]);
    expect(screen.getByTestId('player-offer-accept')).toHaveTextContent('Fortsetzen', {
      exact: false,
    });
    expect(screen.getByTestId('player-offer-decline')).toHaveTextContent('Nein', { exact: false });
    await act(async () => fireEvent.press(screen.getByTestId('player-offer-accept')));
    expect(accept).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.press(screen.getByTestId('player-offer-decline')));
    expect(decline).toHaveBeenCalledTimes(1);
  });

  it('asks in English whether to keep the choice', async () => {
    await act(() => i18n.changeLanguage('en'));
    await renderWithProviders(
      <PlayerOfferCard
        offer={{ kind: 'rememberBuiltInPlayer', id: 2 }}
        onAccept={jest.fn()}
        onDecline={jest.fn()}
      />
    );
    expect(await screen.findByTestId('player-offer-rememberBuiltInPlayer')).toHaveTextContent(
      'Always play Dolby Vision in the Streamarr player on this device?',
      { exact: false }
    );
    expect(screen.getByTestId('player-offer-accept')).toHaveTextContent('Always', { exact: false });
    expect(screen.getByTestId('player-offer-decline')).toHaveTextContent('Just this time', {
      exact: false,
    });
  });
});
