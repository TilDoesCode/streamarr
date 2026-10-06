import type { PlayerKey, PlayerT } from '@/player/use-player-t';

/** One status hint per situation (state-matrix § 2 b.4): what happened, what the app does. */
export const HINT_KEYS = [
  'starting',
  'startSlow',
  'slowNet',
  'serverSlow',
  'reconnecting',
  'offline',
  'restarting',
  'recovering',
  'noPicture',
  'noAudio',
  'deviceSlow',
  'endedEarly',
  'pausedBySystem',
  'airplay',
  'decoder',
  'mutedAutoplay',
  'autoplayBlocked',
  'serverBusy',
  'waitingForStream',
  'buffering',
  'serverError',
  'reloading',
  'lowering',
  'steppingDown',
  'switchingVersion',
  'convertingAudio',
  'serverRetrying',
  'serverRepairing',
] as const;
export type HintKey = (typeof HINT_KEYS)[number];

export type HintAction =
  | 'lowerQuality'
  | 'cancel'
  | 'tryNow'
  | 'back'
  | 'otherVersion'
  | 'otherAudio'
  | 'otherSubtitles'
  | 'resume'
  | 'unmute'
  | 'play'
  | 'signIn';

/** What the viewer can do about each hint, primary action first. */
export const HINT_ACTIONS: Record<HintKey, readonly HintAction[]> = {
  starting: [],
  startSlow: ['lowerQuality', 'cancel'],
  slowNet: ['lowerQuality'],
  serverSlow: ['lowerQuality'],
  reconnecting: ['tryNow', 'back'],
  offline: ['back'],
  restarting: [],
  recovering: [],
  noPicture: [],
  noAudio: ['otherAudio'],
  deviceSlow: ['lowerQuality'],
  endedEarly: ['otherVersion', 'back'],
  pausedBySystem: ['resume'],
  airplay: [],
  decoder: [],
  mutedAutoplay: ['unmute'],
  autoplayBlocked: ['play'],
  serverBusy: ['tryNow'],
  waitingForStream: ['back'],
  buffering: ['lowerQuality'],
  serverError: ['tryNow'],
  reloading: [],
  lowering: [],
  steppingDown: [],
  switchingVersion: [],
  convertingAudio: [],
  serverRetrying: [],
  serverRepairing: [],
};

/** `{cause}` of `startSlow` and `pausedBySystem`. */
export type HintCause =
  | 'call'
  | 'otherAudio'
  | 'headphones'
  | 'locked'
  | 'pipClosed'
  | 'airplayLost'
  | 'converting'
  | 'slowConnection'
  | 'loadingFile'
  | 'preparing'
  | 'outside';

export type HintParams = Record<string, string | number>;

export const hintKey = (key: HintKey): PlayerKey => `hints.${key}`;
export const hintActionKey = (action: HintAction): PlayerKey => `hints.actions.${action}`;

/** The hint line in the viewer's language; a `cause` param is translated first. */
export function hintText(pt: PlayerT, key: HintKey, params: HintParams = {}): string {
  const { cause, ...rest } = params;
  const causeText = typeof cause === 'string' ? pt(`hints.causes.${cause as HintCause}`) : '';
  return pt(hintKey(key), { ...rest, cause: causeText });
}
