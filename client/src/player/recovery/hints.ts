import type { PlayerKey, PlayerT } from '@/player/use-player-t';

import type { SystemCause } from './classify';

/** One status hint per situation (state-matrix § 2 b.4): what happened, what the app does. */
export const HINT_KEYS = [
  'starting',
  'startSlow',
  'slowNet',
  'serverSlow',
  'reconnecting',
  'offline',
  'serverDown',
  'restarting',
  'recovering',
  'noPicture',
  'noAudio',
  'decoder',
  'deviceSlow',
  'endedEarly',
  'subtitleFailed',
  'pausedBySystem',
  'airplay',
  'mutedAutoplay',
  'autoplayBlocked',
  'signedOut',
  'serverBusy',
  'waitingForStream',
  'buffering',
  'serverError',
  'reloading',
  'lowering',
  'steppingDown',
  'switchingVersion',
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
  serverDown: ['tryNow', 'back'],
  restarting: [],
  recovering: [],
  noPicture: [],
  noAudio: ['otherAudio'],
  decoder: [],
  deviceSlow: ['lowerQuality'],
  endedEarly: ['otherVersion', 'back'],
  subtitleFailed: ['otherSubtitles'],
  pausedBySystem: ['resume'],
  airplay: [],
  mutedAutoplay: ['unmute'],
  autoplayBlocked: ['play'],
  signedOut: ['signIn'],
  serverBusy: ['tryNow'],
  waitingForStream: ['back'],
  buffering: ['lowerQuality'],
  serverError: ['tryNow'],
  reloading: [],
  lowering: [],
  steppingDown: [],
  switchingVersion: [],
};

/** `{cause}` of `startSlow` and `pausedBySystem`. */
export type HintCause =
  | Exclude<SystemCause, 'airplay' | 'autoplayMuted' | 'autoplayBlocked'>
  | 'converting'
  | 'slowConnection'
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
