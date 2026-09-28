# Viewer accounts and watch state

Streamarr can manage its own **viewer accounts** — the people who watch on your server —
and track their watch state: resume positions, played flags, play counts, continue
watching, next up, and history. It is the minimal, integrated counterpart to Jellyfin's
users and user data, and the foundation for a Streamarr-native viewer frontend.

The feature is an **optional module** and is **off by default**.

- It lives in its own module (`server/src/Streamarr.Server/Viewers/`) with its own tables
  (`Viewers`, `ViewerSessions`, `ViewerOneTimeCodes`, `ViewerRecoveryCodes`,
  `ViewerWatchStates`, `ViewerConfig`).
- While it is disabled, every viewer endpoint (`/api/v1/viewer/*`) answers
  `404 module_disabled` and viewer tokens are rejected. Admins can still prepare
  accounts under `/api/v1/config/viewers`.
- Nothing about Jellyfin, the admin account, machine API keys, or playback changes.

## Viewers are not administrators

| | Administrator | Viewer |
|---|---|---|
| Stored in | `Users` | `Viewers` |
| Signs in at | `POST /api/v1/auth/login` | `POST /api/v1/viewer/auth/login` |
| Credential | Admin JWT / `streamarr_admin` cookie | Opaque `sva_…` access + `svr_…` refresh token, or the `streamarr_viewer` cookie |
| Reaches | Management UI, `/config/*`, everything | Only `/api/v1/viewer/*` |

The two worlds never overlap: a viewer token gets `401` on every admin or machine
endpoint, an admin JWT or machine API key gets `401` on every viewer endpoint, and a
viewer cannot sign in to the management UI even with the same username and password.
Every viewer response carries `"accountType": "viewer"`.

## Quick start

1. Open **Viewers → Settings** in the management UI and switch the module on.
2. Optional: choose an email mode. **Test outbox** captures messages in memory (shown in
   the test harness) so you can try password reset and sign-in codes without an SMTP
   server; **SMTP** delivers real mail.
3. In **Viewers → Accounts**, create a viewer. Leave the password empty to have one
   generated (shown exactly once); by default the viewer must replace it at first sign-in.
4. Open **Viewers → Test harness**. It behaves like a separate viewer app: it keeps its
   own tokens in memory, never uses your admin cookie, and logs every request. Sign in,
   play something in the simulated player, and watch continue watching, next up, and
   history update.

## Accounts and permissions

| Field | Meaning |
|---|---|
| Username | 3–32 characters (letters, digits, `.`, `_`, `-`), unique, case-insensitive. |
| Display name | Free text shown by clients. |
| Email | Optional. Needed only for password reset and sign-in codes. Addresses set by an admin count as verified; a viewer's own change is confirmed with an emailed code. |
| Age limit | `0`, `6`, `12`, `16`, `18`, or unrestricted. |
| Block unrated | With an age limit set, also block works without a known certification. |
| Allow transcoding | Stored for the viewer playback API. |
| Max. concurrent streams | Stored for the viewer playback API (empty = unlimited). |

Admins can also disable an account (all its sessions end immediately), unlock it after
too many failed sign-ins, assign or generate a new password, reset a lost authenticator,
sign the viewer out everywhere, read or clear its watch state, and delete it.

### Age limit

`GET /api/v1/viewer/access/{workId}` compares the viewer's limit with the work's TMDB
certification (US preferred, the same value Streamarr shows elsewhere). Certifications
map to a minimum age: US film (`G` 0, `PG` 10, `PG-13` 13, `R` 17, `NC-17` 18), US TV
(`TV-Y7` 7, `TV-PG` 10, `TV-14` 14, `TV-MA` 17), numeric systems such as FSK (`0`–`18`),
and BBFC-style values (`U`, `12A`, `15`, `18`, `R18`). If the rating cannot be looked up,
a restricted viewer is denied (`rating_unavailable`).

## Sign-in and security

- **Password** sign-in with username or verified email. Passwords use the same versioned
  PBKDF2-SHA256 hashing as the admin account. The minimum length is configurable
  (default 8).
- **Authenticator apps (TOTP)** via [Otp.NET](https://github.com/kspearrin/Otp.NET):
  setup returns an `otpauth://` URI for a QR code; enabling it issues ten single-use
  recovery codes. Used codes cannot be replayed. Admins can reset a lost authenticator.
- **Email sign-in codes** and **password reset codes**: eight characters from an
  unambiguous alphabet (`ABCD-EFGH`), valid for 10 (sign-in) or 30 minutes, burned after
  five wrong attempts, at most five per hour. Requests for unknown accounts receive the
  same `202` answer, so the endpoint does not reveal who has an account. Mail is sent with
  [MailKit](https://github.com/jstedfast/MailKit) off the request path.
- **Sessions** are per device: a short-lived opaque access token (default 60 minutes) and
  a rotating refresh token (default 30 days). Reusing an old refresh token after the
  30-second concurrency grace ends the session. Viewers see and revoke their devices;
  admins can revoke all of them.
- **Lockout** after repeated failures (default 10 attempts → 15 minutes). A locked
  account only says so when the correct password is supplied.
- **Rate limit** per client IP on all sign-in, code, and reset endpoints
  (`Streamarr:ViewerAuthAttemptsPerMinute`, default 20).
- **Browser clients** can pass `"useCookies": true` to receive HttpOnly,
  `SameSite=Strict` cookies scoped to `/api/v1/viewer` instead of tokens in JSON.
  Cookie-authenticated state changes require a same-origin `Origin` header.
- An admin-assigned password can require a change: until then every viewer endpoint
  except the profile, password change, device list, and sign-out answers
  `403 password_change_required`.

## Watch state

Clients report playback with `POST /api/v1/viewer/watch/progress`
(`start`, periodic `progress`, `stop`) using canonical work ids — `tmdb-movie-603`,
`tmdb-tv-1396-s01e01`. The rules follow Jellyfin's defaults and are configurable:

| Setting | Default | Effect |
|---|---|---|
| Minimum resume | 5 % | Below it, no resume point is kept. |
| Played at | 90 % | The work is marked played, its position resets, and the play count increases once per `playbackId`. |
| Minimum resumable length | 300 s | Shorter items never get a resume point. |
| Next-up window | 365 days | Series without activity for longer are left out of next up. |

- **Continue watching** lists works with a resume position, most recent first.
- **Next up** takes the furthest played episode of each recently watched series and
  suggests the first unplayed, already aired episode after it, crossing into the next
  season when needed. Episode lists come from TMDB (cached; no indexer searches). If
  TMDB cannot be asked for a series, the response sets `incomplete: true`.
- **Played / unplayed** accept movie and episode ids, and also season (`tmdb-tv-1396-s02`)
  and series (`tmdb-tv-1396`) ids that expand to all aired episodes.
- A report that includes a `releaseId` (and optionally the stream token) is also passed
  on to the shared playback event stream with source `streamarr-viewer`, so
  notifications, playback ranges, and next-episode pre-downloads behave as they do for
  Jellyfin.

## Email delivery

| Mode | Behaviour |
|---|---|
| Disabled | No mail. Sign-in codes and password reset are unavailable. |
| SMTP | Real delivery through MailKit (host, port, `auto` / `none` / `startTls` / `sslOnConnect`, optional credentials, sender). The password is encrypted at rest and never returned by the API. **Send test email** reports transport errors directly. |
| Test outbox | The last 50 messages stay in memory and are visible to admins in the test harness (`GET /api/v1/config/viewers/outbox`). Nothing leaves the server. |

## API overview

See [API reference § 12](api.md#12-viewer-accounts-and-watch-state) and the OpenAPI
document for the complete contract.
