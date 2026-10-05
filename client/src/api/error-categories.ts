import { isKnownErrorCode, type KnownErrorCode } from './error-codes';

/** Failure categories of the player state matrix (docs/client/player/state-matrix.md § 2 b.1). */
export const ERROR_CATEGORIES = [
  'T1',
  'T2',
  'T3',
  'T4',
  'T5',
  'T6',
  'T7',
  'T8',
  'T9',
  'T10',
  'T11',
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** T1 transport · T2 session gone · T3 signed out · T4 busy · T5 too slow · T6 server failure · T7 format/decoder · T8 content · T9 policy · T10 system · T11 client. */
export const CODE_CATEGORY: Record<KnownErrorCode, ErrorCategory> = {
  unknown: 'T11',
  network_unreachable: 'T1',
  timeout: 'T1',
  tls_error: 'T1',
  mixed_content: 'T1',
  aborted: 'T11',
  invalid_url: 'T11',
  not_streamarr: 'T1',
  server_error: 'T6',
  not_found: 'T2',
  session_ended: 'T3',
  token_storage_unavailable: 'T11',
  device_caps_unavailable: 'T11',
  decode_error: 'T7',
  encrypted_media: 'T8',
  player_load_failed: 'T11',
  video_stalled: 'T7',
  engine_error: 'T7',
  unexpected_format: 'T6',
  decoder_reclaimed: 'T6',
  audio_decode_error: 'T7',
  cleartext_not_permitted: 'T11',
  vlc_error: 'T7',
  vlc_dialog: 'T7',
  playback_stalled: 'T5',
  start_timeout: 'T7',
  picture_black: 'T7',
  picture_frozen: 'T7',
  audio_silent: 'T7',
  playback_slideshow: 'T5',
  player_internal_error: 'T11',
  step_timeout: 'T6',
  stream_interrupted: 'T1',
  seek_stalled: 'T5',
  module_disabled: 'T9',
  unauthorized: 'T3',
  forbidden: 'T9',
  invalid_request: 'T11',
  invalid_login: 'T3',
  invalid_credentials: 'T3',
  invalid_code: 'T3',
  mfa_expired: 'T3',
  account_disabled: 'T3',
  account_locked: 'T3',
  email_login_unavailable: 'T9',
  password_reset_unavailable: 'T9',
  rate_limited: 'T4',
  email_code_cooldown: 'T4',
  refresh_token_reused: 'T3',
  refresh_session_expired: 'T3',
  refresh_session_revoked: 'T3',
  refresh_token_unknown: 'T3',
  password_change_required: 'T3',
  invalid_password: 'T11',
  invalid_display_name: 'T11',
  invalid_email: 'T11',
  invalid_avatar: 'T11',
  email_taken: 'T9',
  email_unavailable: 'T9',
  email_delivery_failed: 'T6',
  totp_already_enabled: 'T11',
  totp_not_enabled: 'T11',
  totp_not_allowed: 'T9',
  totp_setup_missing: 'T11',
  session_not_found: 'T11',
  age_restricted: 'T9',
  invalid_work_id: 'T11',
  invalid_work_ids: 'T11',
  invalid_event: 'T11',
  missing_query: 'T11',
  invalid_query: 'T11',
  title_not_found: 'T9',
  season_not_found: 'T9',
  episode_not_found: 'T9',
  catalog_unavailable: 'T4',
  capacity_reached: 'T4',
  search_temporarily_unavailable: 'T4',
  invalid_device_profile: 'T11',
  invalid_playback_request: 'T11',
  playback_not_found: 'T2',
  too_many_streams: 'T9',
  too_many_playbacks: 'T4',
  release_dead: 'T8',
  repair_failed: 'T8',
  no_versions: 'T8',
  release_not_found: 'T8',
  transcoding_not_allowed: 'T9',
  transcoding_unavailable: 'T6',
  no_playable_method: 'T7',
  no_more_methods: 'T7',
  unknown_audio_stream: 'T11',
  unknown_subtitle_stream: 'T11',
  transcode_capacity: 'T4',
  remux_capacity: 'T4',
  probe_failed: 'T8',
  stream_expired: 'T2',
  no_playable_file: 'T8',
  invalid_release: 'T8',
  nzb_fetch_failed: 'T8',
  nzb_host_not_allowed: 'T9',
  usenet_unreachable: 'T6',
  resolve_failed: 'T8',
  playback_failed: 'T6',
  segment_timeout: 'T5',
  transcode_failed: 'T6',
  unknown_audio_rendition: 'T11',
  rendition_split_failed: 'T6',
  unknown_stream: 'T2',
  stream_capacity: 'T4',
  unknown_transcode: 'T2',
  unknown_segment: 'T8',
  end_of_stream: 'T8',
  session_closed: 'T2',
  segment_evicted: 'T6',
  init_unavailable: 'T6',
  segment_unavailable: 'T6',
  too_many_sessions: 'T4',
  ffmpeg_unavailable: 'T6',
  transcoding_disabled: 'T9',
  invalid_transcode_request: 'T11',
  remux_not_possible: 'T7',
  no_video_stream: 'T8',
  unknown_duration: 'T8',
  viewer_not_found: 'T3',
};

/** Category of an HTTP status without a known code. */
export function categoryOfStatus(status: number): ErrorCategory | undefined {
  if (status === 0 || status === 408) return 'T1';
  if (status === 401 || status === 423) return 'T3';
  if (status === 403 || status === 409) return 'T9';
  if (status === 404 || status === 410) return 'T2';
  if (status === 422) return 'T8';
  if (status === 429 || status === 503) return 'T4';
  if (status === 504) return 'T5';
  if (status >= 500) return 'T6';
  if (status >= 400) return 'T11';
  return undefined;
}

const NAME_RULES: readonly (readonly [RegExp, ErrorCategory])[] = [
  [/^refresh_|signed_out|revoked|password_change|session_ended/, 'T3'],
  [/capacity|busy|too_many|rate_limit/, 'T4'],
  [/timeout|too_slow/, 'T5'],
  [/not_allowed|disabled|restricted|forbidden/, 'T9'],
  [/_not_found$|^unknown_|_closed$|_expired$|_gone$/, 'T2'],
  [/unavailable|_failed$|server/, 'T6'],
  [/codec|decod|unsupported|format/, 'T7'],
];

/** Category of any error code: known codes by table, unknown ones by HTTP status, then by name, else T11. */
export function categoryOf(code: string, status?: number): ErrorCategory {
  if (isKnownErrorCode(code)) return CODE_CATEGORY[code];
  const byStatus = status === undefined ? undefined : categoryOfStatus(status);
  if (byStatus) return byStatus;
  return NAME_RULES.find(([pattern]) => pattern.test(code))?.[1] ?? 'T11';
}
