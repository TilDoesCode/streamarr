import type { ErrorAction } from '@/components/states/error-state';

/** Card actions the player can carry out; the server may suggest others the player has no button for. */
const CARD_ACTIONS = new Set<ErrorAction>([
  'retry',
  'otherVersion',
  'lowerQuality',
  'useVlc',
  'signIn',
]);

/** The failure card's buttons: what the ladder and the server offer, then Back; VLC only where it exists. */
export function cardButtons(
  actions: readonly string[] | undefined,
  { vlc = true }: { vlc?: boolean } = {}
): ErrorAction[] {
  return [
    ...(actions ?? ['retry']).filter(
      (action): action is ErrorAction =>
        CARD_ACTIONS.has(action as ErrorAction) && (vlc || action !== 'useVlc')
    ),
    'back',
  ];
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The server's `params.reason` under the card: its own words where known, else the code (B07, B10). */
export function failureReason(
  t: Translate,
  params: Readonly<Record<string, string>> | undefined,
  known: (reason: string) => boolean
): string | null {
  const reason = params?.reason;
  if (!reason) return null;
  return known(reason) ? t(`errors.reasons.${reason}`) : t('errors.reasonLabel', { reason });
}
