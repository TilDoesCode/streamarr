import { outageButtons, outageExplains } from '@/screens/player/card-actions';

describe('failure card during a server outage', () => {
  it('leads with Server status, then Try again, another version only if offered, Back', () => {
    expect(outageButtons(['otherVersion', 'retry', 'useVlc', 'back'])).toEqual([
      'serverStatus',
      'retry',
      'otherVersion',
      'back',
    ]);
    expect(outageButtons(['lowerQuality', 'back'])).toEqual(['serverStatus', 'retry', 'back']);
  });

  it('an outage explains server-side failures, not the device, the app, sign-in or access', () => {
    expect(outageExplains('release_dead', ['otherVersion', 'back'])).toBe(true);
    expect(outageExplains('usenet_unreachable', ['retry', 'back'])).toBe(true);
    for (const code of ['network_unreachable', 'timeout', 'player_internal_error', 'forbidden'])
      expect(outageExplains(code, ['retry', 'back'])).toBe(false);
    expect(outageExplains('session_ended', ['signIn', 'back'])).toBe(false);
  });
});
