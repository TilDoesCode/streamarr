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

/** "Show server status" just before Back: the viewer can see whether the server's services caused the failure. */
export function withServerStatus(buttons: readonly ErrorAction[]): ErrorAction[] {
  const rest = buttons.filter((action) => action !== 'back' && action !== 'serverStatus');
  return [...rest, 'serverStatus', ...(buttons.includes('back') ? (['back'] as const) : [])];
}

/** Failures a server outage cannot explain: the device's connection, the app itself, sign-in, access, a missing title. */
const NOT_AN_OUTAGE = new Set([
  'network_unreachable',
  'network_intercepted',
  'timeout',
  'tls_error',
  'player_internal_error',
  'player_load_failed',
  'cleartext_not_permitted',
  'encrypted_media',
  'unauthorized',
  'forbidden',
  'age_restricted',
  'not_found',
]);

/** Whether a reported server outage explains this failure (the card then leads with the outage). */
export function outageExplains(code: string, buttons: readonly ErrorAction[]): boolean {
  return !NOT_AN_OUTAGE.has(code) && !buttons.includes('signIn');
}

/** During an outage: Server status first, then Try again, another version only if offered, Back. */
export function outageButtons(buttons: readonly ErrorAction[]): ErrorAction[] {
  return [
    'serverStatus',
    'retry',
    ...(buttons.includes('otherVersion') ? (['otherVersion'] as const) : []),
    'back',
  ];
}

/** "Play with VLC" only where VLC exists and the failed playback did not run on it (that would repeat VLC). */
export function vlcOffered(
  available: boolean,
  played: { engine?: string | null } | null | undefined,
  preferences: { engine?: string | null; forceEngine?: boolean | null } | undefined
): boolean {
  if (!available) return false;
  // An answer naming its engine decides; a failed start's answer may name none, then only a forced VLC pick is known.
  if (played?.engine) return played.engine !== 'vlc';
  return !(preferences?.engine === 'vlc' && preferences.forceEngine);
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
