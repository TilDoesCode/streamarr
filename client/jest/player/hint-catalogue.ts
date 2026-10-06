import { categoryOf } from '@/api/error-categories';
import { CLIENT_ERROR_CODES, VIEWER_ERROR_CODES } from '@/api/error-codes';
import i18n from '@/i18n';
import { cardActions } from '@/player/recovery/ladder';
import { HINT_ACTIONS, HINT_KEYS, type HintKey } from '@/player/recovery/hints';

/** One catalogue row: a text key, sample params and when the viewer sees it. */
type Row = {
  id: string;
  key: string;
  params?: Record<string, unknown>;
  state: string;
  action?: string;
  shows: string;
  clears: string;
};

type Lang = 'de' | 'en';

const RECOVERY = 'the step is done: the picture plays again, or the next step or the card follows';

/** Status hints over the picture (recovery/status.ts); actions come from HINT_ACTIONS. */
const HINTS: Record<HintKey, Omit<Row, 'id' | 'key' | 'action'>> = {
  starting: {
    state: 'Start, no picture yet',
    shows: 'never on its own: the start stepper covers it',
    clears: 'first frame',
  },
  startSlow: {
    params: { cause: 'converting' },
    state: 'Start or reload takes longer than its budget',
    shows:
      'a start state lasts past its budget (queued/resolving 60 s, planning 30 s, starting 45 s), or no picture 10 s after a load',
    clears: 'first frame, or the start_stuck card',
  },
  slowNet: {
    params: { measured: 2.4, needed: 8.5 },
    state: 'Stall, measured throughput below the bitrate',
    shows: 'a stall lasts 4 s and the last segment came slower than 1.2 × the bitrate',
    clears: 'the picture runs again; after 15 s the stall ladder (lower quality) takes over',
  },
  serverSlow: {
    state: 'Stall, the server converts slower than real time',
    shows:
      'a stall of a converted playback lasts 4 s and the last 3 segments delivered less than real time',
    clears: 'the picture runs again; after 15 s the stall ladder',
  },
  reconnecting: {
    params: { seconds: 4 },
    state: 'Connection lost, the app retries',
    shows: 'an app request fails without an answer and the next try is scheduled',
    clears: 'the request goes through, or the T1 card',
  },
  offline: {
    state: 'This device has no network',
    shows: 'the device reports offline (at once)',
    clears: 'back online: the playback continues (reload at the position if needed)',
  },
  restarting: {
    params: { time: '42:10' },
    state: 'The server ended the playback (T2), a new one starts',
    shows: 'step N for T2 runs, after 4 s of a stalled picture',
    clears: RECOVERY,
  },
  recovering: {
    params: { time: '42:10' },
    state: 'Picture frozen while playback runs',
    shows: 'the watchdog sees no new frames while the clock runs',
    clears: RECOVERY,
  },
  noPicture: {
    state: 'Sound but no picture (black)',
    shows: 'the watchdog sees a black picture with moving frames, or a device failure recurs',
    clears: RECOVERY,
  },
  noAudio: {
    state: 'Picture but no sound',
    shows:
      'the watchdog hears silence while the audio track should play, or only the audio requests fail',
    clears: RECOVERY,
  },
  deviceSlow: {
    params: { percent: 37 },
    state: 'This device drops too many frames',
    shows: 'the watchdog counts more than the allowed share of dropped frames',
    clears: 'frames stay smooth again, or the viewer lowers the quality',
  },
  endedEarly: {
    params: { time: '1:31:02', missing: '12:40' },
    state: 'The file ends before its announced length',
    shows: 'the engine ends more than 12 s before the end and the server confirms the short file',
    clears: 'the viewer picks another version or leaves',
  },
  pausedBySystem: {
    params: { cause: 'call' },
    state: 'The system paused playback',
    shows: 'an engine pause the app did not ask for lasts 1 s',
    clears: 'the viewer resumes',
  },
  airplay: {
    params: { device: 'Living room' },
    state: 'Playing on an AirPlay device',
    shows: 'AirPlay is active',
    clears: 'AirPlay ends',
  },
  mutedAutoplay: {
    state: 'Web: the browser only allowed a muted start',
    shows: 'the muted autoplay fallback was used',
    clears: 'the viewer unmutes',
  },
  autoplayBlocked: {
    state: 'Web: the browser blocked the start',
    shows: 'play() was refused even muted',
    clears: 'the viewer presses Play',
  },
  serverBusy: {
    params: { seconds: 8 },
    state: 'Server busy (T4), the app waits for Retry-After',
    shows: 'a T4 answer with a wait time',
    clears: 'the retry goes through, or the T4 card',
  },
  waitingForStream: {
    params: { device: 'Apple TV' },
    state: 'Stream limit: waiting for the other device to stop',
    shows: 'too_many_streams names the device and the app waits',
    clears: 'the other playback stops, or the viewer goes back',
  },
  buffering: {
    state: 'Stall without a known cause',
    shows: 'a stall lasts 4 s and neither the connection nor the server is measured slow',
    clears: 'the picture runs again; after 15 s the stall ladder',
  },
  serverError: {
    params: { seconds: 2 },
    state: 'Server error (T6), the app retries',
    shows: 'a T6 answer and the next try is scheduled',
    clears: 'the retry goes through, or the next step',
  },
  reloading: {
    params: { time: '42:10' },
    state: 'Step R or N runs (reload or new start at the position)',
    shows: 'the step runs, after 4 s of a stalled picture',
    clears: RECOVERY,
  },
  lowering: {
    params: { time: '42:10' },
    state: 'Step Q runs (lower quality)',
    shows: 'the step runs',
    clears: RECOVERY,
  },
  steppingDown: {
    params: { time: '42:10' },
    state: 'Step S runs (another way to play)',
    shows: 'the step runs',
    clears: RECOVERY,
  },
  decoder: {
    params: { time: '42:10', format: 'HEVC' },
    state:
      'Step S runs after the device refused a named format (native decoder error, HDR tag mismatch)',
    shows: 'the step runs and the failure names a format (HEVC, AV1, Dolby Vision, HDR, E-AC-3 …)',
    clears: RECOVERY,
  },
  switchingVersion: {
    params: { time: '42:10' },
    state: 'Step V runs (another version)',
    shows: 'the step runs',
    clears: RECOVERY,
  },
  convertingAudio: {
    params: { time: '42:10' },
    state: 'Step A runs (sound converted on the server)',
    shows: 'the step runs',
    clears: RECOVERY,
  },
  serverRetrying: {
    state: 'A media request fails with a server status, the player retries',
    shows: 'a stall while the engine retries an HTTP 4xx/5xx',
    clears: 'the retry goes through, or the stall ladder',
  },
  serverRepairing: {
    state: 'The server repairs missing data of the file',
    shows: 'a stall while the server reports a repair',
    clears: 'the picture runs again',
  },
};

const STEPPER: Row[] = [
  {
    id: 'S01',
    key: 'stepper.title',
    state: 'Start card heading',
    shows: 'start begins',
    clears: 'first frame',
  },
  {
    id: 'S02',
    key: 'stepper.steps.resolving',
    state: 'Step label: version check',
    shows: 'server state resolving',
    clears: 'next state',
  },
  {
    id: 'S03',
    key: 'stepper.explain.resolving',
    state: 'Current step: version check',
    shows: 'server state resolving',
    clears: 'next state',
  },
  {
    id: 'S04',
    key: 'stepper.steps.fallback',
    state: 'Step label: next version',
    shows: 'server state fallback',
    clears: 'next state',
  },
  {
    id: 'S05',
    key: 'stepper.explain.fallback',
    params: { name: '2160p WEB-DL' },
    state: 'Current step: the version is missing data',
    shows: 'server state fallback',
    clears: 'next state',
  },
  {
    id: 'S06',
    key: 'stepper.steps.repairing',
    state: 'Step label: repair',
    shows: 'server state repairing',
    clears: 'next state',
  },
  {
    id: 'S07',
    key: 'stepper.explain.repairing',
    state: 'Current step: repair',
    shows: 'server state repairing',
    clears: 'next state',
  },
  {
    id: 'S08',
    key: 'stepper.repair',
    params: { percent: 0.42, eta: '3 min' },
    state: 'Repair progress with time left',
    shows: 'the server reports progress and an estimate',
    clears: 'repair done',
  },
  {
    id: 'S09',
    key: 'stepper.repairProgress',
    params: { percent: 0.42 },
    state: 'Repair progress without estimate',
    shows: 'the server reports progress only',
    clears: 'repair done',
  },
  {
    id: 'S10',
    key: 'stepper.steps.planning',
    state: 'Step label: choose how to play',
    shows: 'server state planning',
    clears: 'next state',
  },
  {
    id: 'S11',
    key: 'stepper.explain.planning',
    state: 'Current step: choose how to play',
    shows: 'server state planning',
    clears: 'next state',
  },
  {
    id: 'S12',
    key: 'stepper.steps.starting',
    state: 'Step label: start',
    shows: 'server state starting',
    clears: 'ready',
  },
  {
    id: 'S13',
    key: 'stepper.explain.starting',
    state: 'Current step: start',
    shows: 'server state starting',
    clears: 'ready',
  },
  {
    id: 'S14',
    key: 'stepper.explain.queued',
    state: 'Current step: queued for server capacity',
    shows: 'server state queued',
    clears: 'next state',
  },
  {
    id: 'S15',
    key: 'stepper.attempt.resolving',
    state: 'A version in the list is being checked',
    shows: 'attempt state resolving',
    clears: 'checked',
  },
  {
    id: 'S16',
    key: 'stepper.attempt.ready',
    state: 'A version in the list is ready',
    shows: 'attempt state ready',
    clears: '—',
  },
  {
    id: 'S17',
    key: 'stepper.attempt.degraded',
    state: 'A version in the list misses parts that can be repaired',
    shows: 'attempt state degraded',
    clears: 'repaired',
  },
  {
    id: 'S18',
    key: 'stepper.attempt.dead',
    state: 'A version in the list misses data for good',
    shows: 'attempt state dead',
    clears: '—',
  },
  {
    id: 'S19',
    key: 'stepper.switching',
    state: 'A viewer switch runs (quality, version, audio)',
    shows: 'phase switching',
    clears: 'the new source plays, or the switch failed notice',
  },
  {
    id: 'S20',
    key: 'stepper.failed',
    state: 'Start card heading after a failed start',
    shows: 'the start failed',
    clears: 'retry or leave',
  },
];

const NOTICES: Row[] = [
  {
    id: 'N01',
    key: 'notice.stepDown',
    params: { reason: 'T5' },
    state: 'Step S switched the way to play',
    action: '—',
    shows: 'step S succeeded',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N02',
    key: 'notice.stepDownVlc',
    state: 'Step S switched to VLC',
    action: '—',
    shows: 'step S chose VLC',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N03',
    key: 'notice.stepDownDirect',
    state: 'Step S switched to direct play',
    action: '—',
    shows: 'step S chose direct play',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N04',
    key: 'notice.stepDownRemux',
    state: 'Step S switched to direct stream',
    action: '—',
    shows: 'step S chose direct stream',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N05',
    key: 'notice.stepDownTranscode',
    state: 'Step S switched to conversion',
    action: '—',
    shows: 'step S chose conversion',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N06',
    key: 'notice.because.T7',
    state: 'Reason before a step-down: decoding failed',
    action: '—',
    shows: 'with N01–N05',
    clears: 'with the notice',
  },
  {
    id: 'N07',
    key: 'notice.because.T5',
    state: 'Reason before a step-down: too slow',
    action: '—',
    shows: 'with N01–N05',
    clears: 'with the notice',
  },
  {
    id: 'N08',
    key: 'notice.because.T6',
    state: 'Reason before a step-down: server problem',
    action: '—',
    shows: 'with N01–N05',
    clears: 'with the notice',
  },
  {
    id: 'N09',
    key: 'notice.because.picture_timeout',
    state: 'Reason before a step-down: black picture',
    action: '—',
    shows: 'with N01–N05',
    clears: 'with the notice',
  },
  {
    id: 'N10',
    key: 'notice.otherVersion',
    state: 'Step V switched the version',
    action: '—',
    shows: 'step V succeeded',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N11',
    key: 'notice.audioFallback',
    state: 'Step A converted the sound',
    action: '—',
    shows: 'step A succeeded',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N12',
    key: 'notice.audioRestarted',
    state: 'An audio switch needed a new start',
    action: '—',
    shows: 'the in-session audio switch timed out and the server switched',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N13',
    key: 'notice.switchFailed',
    state: 'A viewer switch was refused, the old source plays on',
    action: '—',
    shows: 'the switch request failed (reason: the code’s text)',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N14',
    key: 'notice.subtitleFailed',
    params: { label: 'English (SDH)', retry: 'later' },
    state: 'Subtitles failed once, retried later',
    action: 'Other subtitles (menu)',
    shows: 'first subtitle failure',
    clears: '6 s (TV 8 s); retried after 60 s',
  },
  {
    id: 'N15',
    key: 'notice.subtitleFailed',
    params: { label: 'English (SDH)', retry: 'none' },
    state: 'Subtitles failed again, off for good',
    action: 'Other subtitles (menu)',
    shows: 'second failure within 2 min',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N16',
    key: 'notice.subtitleNotDeliverable',
    params: { label: 'English (PGS)' },
    state: 'Subtitles this device cannot show',
    action: 'Other subtitles (menu)',
    shows: 'the server cannot deliver them for this engine',
    clears: '6 s (TV 8 s)',
  },
  {
    id: 'N17',
    key: 'notice.subtitleNotDeliverableVlc',
    params: { label: 'English (PGS)' },
    state: 'Subtitles only VLC can show',
    action: 'Player → VLC (menu)',
    shows: 'as N16, VLC available',
    clears: '6 s (TV 8 s)',
  },
];

const TRIED: Row[] = ['W', 'R', 'N', 'Q', 'S', 'V', 'A', 'G'].map((step, index) => ({
  id: `W${String(index + 1).padStart(2, '0')}`,
  key: `tried.${step}`,
  params: { time: '42:10' },
  state: `Ladder step ${step} in the card’s list`,
  shows: 'failure card after the ladder ran',
  clears: 'with the card',
}));

/** Codes the player can put on its card: device and engine codes, then everything from the playback API on. */
export const PLAYER_CODES: string[] = [
  ...CLIENT_ERROR_CODES.filter(
    (code) => !['invalid_url', 'not_streamarr', 'token_storage_unavailable'].includes(code)
  ),
  ...VIEWER_ERROR_CODES.slice(VIEWER_ERROR_CODES.indexOf('invalid_device_profile' as never)),
];

/** Keys that are not states (control labels, menus) and stay out of the catalogue. */
export const NOT_STATES =
  /^(controls|methods|quality|enginePref|info|resume|upNext|endCard|ended|subtitlesOff|forced|trackFallback)\b/;

/** Different states that share a text because the viewer does the same about them. */
export const SHARED_TEXTS: Record<string, string> = {
  'Server is busy': 'transcode/remux/stream capacity and too_many_sessions: all wait and retry',
  'Video not ready yet': 'init_unavailable and segment_unavailable: both retry or lower quality',
  'Stream ended on the server': 'unknown_transcode and session_closed: both start again',
  'Signed out': 'T3 and session_ended: both sign in again',
};

/** Card messages shared on purpose: the engine and the watchdog see the same frozen picture. */
export const SHARED_MESSAGES: Record<string, string> = {
  'video_stalled = picture_frozen':
    'the engine (video_stalled) and the watchdog (picture_frozen) report the same frozen picture; titles differ, the advice is the same',
};

const t = (lang: Lang, key: string, params?: Record<string, unknown>) =>
  i18n.getFixedT(lang)(key, params as never) as unknown as string;
const pt = (lang: Lang, key: string, params?: Record<string, unknown>) =>
  t(lang, key, { ...params, ns: 'player' });

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const hintParams = (lang: Lang, params?: Record<string, unknown>) =>
  params && typeof params.cause === 'string'
    ? { ...params, cause: pt(lang, `hints.causes.${params.cause}`) }
    : params;

function noticeText(lang: Lang, row: Row): string {
  if (row.key === 'notice.stepDown')
    return `${pt(lang, 'notice.because.T5')} ${pt(lang, 'notice.stepDown')}`;
  if (row.key === 'notice.switchFailed')
    return pt(lang, row.key, { reason: t(lang, 'errors.codes.transcode_capacity.message') });
  return pt(lang, row.key, row.params);
}

function table(head: string[], rows: string[][]): string {
  return [
    `| ${head.join(' | ')} |`,
    `|${head.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
}

const hintAction = (lang: Lang, key: HintKey) =>
  HINT_ACTIONS[key].map((action) => pt(lang, `hints.actions.${action}`)).join(', ') || '—';

/** Every player-facing text as rows: [layer, key, de, en]; the test checks jargon, length and duplicates on these. */
export function catalogueTexts(): { layer: string; key: string; de: string; en: string }[] {
  const out: { layer: string; key: string; de: string; en: string }[] = [];
  for (const row of STEPPER)
    out.push({
      layer: 'start',
      key: row.key,
      de: pt('de', row.key, row.params),
      en: pt('en', row.key, row.params),
    });
  for (const key of HINT_KEYS) {
    const { params } = HINTS[key];
    out.push({
      layer: 'hint',
      key: `hints.${key}`,
      de: pt('de', `hints.${key}`, hintParams('de', params)),
      en: pt('en', `hints.${key}`, hintParams('en', params)),
    });
  }
  for (const row of NOTICES)
    out.push({
      layer: 'notice',
      key: row.key,
      de: noticeText('de', row),
      en: noticeText('en', row),
    });
  for (const category of ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'])
    for (const part of ['title', 'message'])
      out.push({
        layer: `card-${part}`,
        key: `errors.categories.${category}.${part}`,
        de: t('de', `errors.categories.${category}.${part}`),
        en: t('en', `errors.categories.${category}.${part}`),
      });
  for (const code of PLAYER_CODES)
    for (const part of ['title', 'message'])
      out.push({
        layer: `card-${part}`,
        key: `errors.codes.${code}.${part}`,
        de: t('de', `errors.codes.${code}.${part}`),
        en: t('en', `errors.codes.${code}.${part}`),
      });
  const reasons = i18n.getResource('en', 'translation', 'errors.reasons') as object;
  for (const reason of Object.keys(reasons))
    out.push({
      layer: 'card-message',
      key: `errors.reasons.${reason}`,
      de: t('de', `errors.reasons.${reason}`),
      en: t('en', `errors.reasons.${reason}`),
    });
  return out;
}

/** The whole catalogue (docs/client/player/hint-catalogue.md), rendered from the locale files. */
export function buildCatalogue(): string {
  const hintRows = HINT_KEYS.map((key, index) => {
    const meta = HINTS[key];
    return [
      `H${String(index + 1).padStart(2, '0')}`,
      meta.state,
      pt('de', `hints.${key}`, hintParams('de', meta.params)),
      pt('en', `hints.${key}`, hintParams('en', meta.params)),
      `${hintAction('de', key)} / ${hintAction('en', key)}`,
      meta.shows,
      meta.clears,
    ];
  });
  const plain = (rows: Row[], text: (lang: Lang, row: Row) => string) =>
    rows.map((row) => [
      row.id,
      row.state,
      text('de', row),
      text('en', row),
      row.action ?? '—',
      row.shows,
      row.clears,
    ]);
  const causes = [
    'call',
    'otherAudio',
    'headphones',
    'locked',
    'pipClosed',
    'airplayLost',
    'outside',
    'converting',
    'slowConnection',
    'loadingFile',
    'preparing',
  ];
  const categories = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9', 'T10', 'T11'].map(
    (category) => [
      category,
      `${t('de', `errors.categories.${category}.title`)} — ${t('de', `errors.categories.${category}.message`)}`,
      `${t('en', `errors.categories.${category}.title`)} — ${t('en', `errors.categories.${category}.message`)}`,
      cardActions(category as never, '')
        .map((action) => t('en', `errors.actions.${action}`))
        .join(', ') || '—',
    ]
  );
  const codes = PLAYER_CODES.map((code, index) => {
    const category = categoryOf(code);
    return [
      `F${String(index + 1).padStart(2, '0')}`,
      `\`${code}\` (${category})`,
      `**${t('de', `errors.codes.${code}.title`)}** — ${t('de', `errors.codes.${code}.message`)}`,
      `**${t('en', `errors.codes.${code}.title`)}** — ${t('en', `errors.codes.${code}.message`)}`,
      [...cardActions(category, code), 'back']
        .map((action) => t('en', `errors.actions.${action}`))
        .join(', '),
    ];
  });
  const reasons = Object.keys(
    i18n.getResource('en', 'translation', 'errors.reasons') as object
  ).map((reason) => [
    `\`${reason}\``,
    t('de', `errors.reasons.${reason}`),
    t('en', `errors.reasons.${reason}`),
  ]);
  const actions = ['retry', 'otherVersion', 'lowerQuality', 'useVlc', 'signIn', 'back'].map(
    (action) => [
      `\`${action}\``,
      t('de', `errors.actions.${action}`),
      t('en', `errors.actions.${action}`),
    ]
  );
  const hintActions = [
    'lowerQuality',
    'cancel',
    'tryNow',
    'back',
    'otherVersion',
    'otherAudio',
    'otherSubtitles',
    'resume',
    'unmute',
    'play',
    'signIn',
  ].map((action) => [
    `\`${action}\``,
    pt('de', `hints.actions.${action}`),
    pt('en', `hints.actions.${action}`),
  ]);
  const head = ['Row', 'State', 'de', 'en', 'Action', 'Shows when', 'Clears when'];
  return `# Player hint catalogue

Every text the player shows about a state, in German and English, as the viewer reads it. Generated from the locale
files (\`client/src/i18n/locales/{player.,}{de,en}.json\`) by \`client/jest/player/hint-catalogue.ts\`; the test
\`client/src/player/__tests__/hint-catalogue.test.ts\` fails when this file and the locale files disagree. Regenerate
with \`UPDATE_CATALOGUE=1 npx jest hint-catalogue\` from \`client/\`. Placeholders are filled with sample values
(times, a device name, measured numbers) so number formats per locale are visible.

Every text says what happened, then what the app does about it, and where the viewer can do something, what.
The layers, from first seen to last resort: the start card (S), status hints over the picture (H), notices after
the app changed something (N), the failure card (C categories, F codes, its reason line and actions), and the card's
"What was tried" list (W).

## Start card (S)

${table(
  head,
  plain(STEPPER, (lang, row) => pt(lang, row.key, row.params))
)}

## Status hints over the picture (H)

At most one hint at a time, under the spinner. A hint appears 4 s after a stall or as soon as a recovery step runs;
during a step the viewer's own actions wait (none shown).

${table(head, hintRows)}

### Causes inside a hint

${table(
  ['Cause', 'de', 'en'],
  causes.map((cause) => [
    `\`${cause}\``,
    pt('de', `hints.causes.${cause}`),
    pt('en', `hints.causes.${cause}`),
  ])
)}

### Hint actions

${table(['Action', 'de', 'en'], hintActions)}

## Notices (N)

A short banner after the app changed something on its own, or when a change the viewer asked for failed. A
step-down notice says the reason first (N06–N09), then what changed.

${table(head, plain(NOTICES, noticeText))}

## Failure card (C, F)

The card shows when the recovery ladder has nothing left to try (or the failure has no step, e.g. signed out). Title
and message come from the code (F); a code without its own text uses its category's text (C). Below them: the
server's reason line, the "What was tried" list and the actions — the ladder's actions for the category, then Back.

### Categories (C) — the text of a code without its own

${table(['Category', 'de', 'en', 'Actions'], categories)}

### Codes (F)

${table(['Row', 'Code (category)', 'de', 'en', 'Actions (en)'], codes)}

### Reason line (server \`params.reason\`)

${table(['Reason', 'de', 'en'], reasons)}

Unknown reasons read “${t('de', 'errors.reasonLabel', { reason: 'xyz' })}” / “${t('en', 'errors.reasonLabel', { reason: 'xyz' })}”.

### Card actions

${table(['Action', 'de', 'en'], actions)}

## What was tried (W)

Heading “${pt('de', 'tried.title')}” / “${pt('en', 'tried.title')}”; one line per ladder step that ran, with the time.

${table(
  head,
  plain(TRIED, (lang, row) => pt(lang, row.key, row.params))
)}

## Texts shared on purpose

${table(['Text (en)', 'Why it is the same'], Object.entries(SHARED_TEXTS))}

${table(['Card messages', 'Why they are the same'], Object.entries(SHARED_MESSAGES))}
`;
}
