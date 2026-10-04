/** Error codes produced on the device (no server answer, or an answer that is not Streamarr's). */
export const CLIENT_ERROR_CODES = [
  'unknown',
  'network_unreachable',
  'timeout',
  'tls_error',
  'mixed_content',
  'aborted',
  'invalid_url',
  'not_streamarr',
  'server_error',
  'not_found',
  'session_ended',
  'token_storage_unavailable',
] as const;

/** Every error code the viewer API documents (docs/api.md §12–13, docs/viewers.md); each has de/en text. */
export const VIEWER_ERROR_CODES = [
  // Module, auth and session.
  'module_disabled',
  'unauthorized',
  'forbidden',
  'invalid_request',
  'invalid_login',
  'invalid_credentials',
  'invalid_code',
  'mfa_expired',
  'account_disabled',
  'account_locked',
  'email_login_unavailable',
  'password_reset_unavailable',
  'rate_limited',
  'email_code_cooldown',
  'refresh_token_reused',
  'refresh_session_expired',
  'password_change_required',
  // The signed-in viewer (/viewer/me).
  'invalid_password',
  'invalid_display_name',
  'invalid_email',
  'invalid_avatar',
  'email_taken',
  'email_unavailable',
  'email_delivery_failed',
  'totp_already_enabled',
  'totp_not_enabled',
  'totp_not_allowed',
  'totp_setup_missing',
  'session_not_found',
  // Catalog and watch state.
  'age_restricted',
  'invalid_work_id',
  'invalid_work_ids',
  'invalid_event',
  'missing_query',
  'invalid_query',
  'title_not_found',
  'season_not_found',
  'episode_not_found',
  'catalog_unavailable',
  'capacity_reached',
  'search_temporarily_unavailable',
  // Playback requests.
  'invalid_device_profile',
  'invalid_playback_request',
  'playback_not_found',
  'too_many_streams',
  'too_many_playbacks',
  // Failed playback states (error.code).
  'release_dead',
  'repair_failed',
  'no_versions',
  'release_not_found',
  'transcoding_not_allowed',
  'transcoding_unavailable',
  'no_playable_method',
  'no_more_methods',
  'unknown_audio_stream',
  'unknown_subtitle_stream',
  'transcode_capacity',
  'remux_capacity',
  'probe_failed',
  'stream_expired',
  'no_playable_file',
  'invalid_release',
  'nzb_fetch_failed',
  'nzb_host_not_allowed',
  'usenet_unreachable',
  'resolve_failed',
  'playback_failed',
  'segment_timeout',
  'transcode_failed',
  // Audio rendition requests of an HLS session (in-session audio switch).
  'unknown_audio_rendition',
  'rendition_split_failed',
] as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];
export type ViewerErrorCode = (typeof VIEWER_ERROR_CODES)[number];
export type KnownErrorCode = ClientErrorCode | ViewerErrorCode;

const KNOWN: ReadonlySet<string> = new Set([...CLIENT_ERROR_CODES, ...VIEWER_ERROR_CODES]);

export function isKnownErrorCode(code: string): code is KnownErrorCode {
  return KNOWN.has(code);
}
