import type { ErrorAction } from '@/components/states/error-state';

/** Card actions the player can carry out; the server may suggest others the player has no button for. */
const CARD_ACTIONS = new Set<ErrorAction>([
  'retry',
  'otherVersion',
  'lowerQuality',
  'useVlc',
  'signIn',
]);

/** The failure card's buttons: what the ladder and the server offer, then Back. */
export function cardButtons(actions: readonly string[] | undefined): ErrorAction[] {
  return [
    ...(actions ?? ['retry']).filter((action): action is ErrorAction =>
      CARD_ACTIONS.has(action as ErrorAction)
    ),
    'back',
  ];
}
