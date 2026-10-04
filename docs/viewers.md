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
- Nothing about Jellyfin, the admin account, machine API keys, or Jellyfin playback changes.

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
| Allow transcoding | Off blocks **full video transcodes** in [playback](#playback) (including burned-in subtitles and reduced quality). A remux, which copies the video and may convert the audio, stays allowed. The catalog's playback prediction flags versions that would need a transcode (`transcoding_not_allowed`). |
| Max. concurrent streams | How many [playbacks](#playback) may run at once across the viewer's devices (empty = unlimited). |

Admins can also disable an account (all its sessions end immediately), unlock it after
too many failed sign-ins, assign or generate a new password, reset a lost authenticator,
sign the viewer out everywhere, read or clear its watch state, and delete it.

### Age limit

`GET /api/v1/viewer/access/{workId}` compares the viewer's limit with the work's TMDB
certification (US preferred, the same value Streamarr shows elsewhere). Certifications
map to a minimum age: US film (`G` 0, `PG` 10, `PG-13` 13, `R` 17, `NC-17` 18), US TV
(`TV-Y7` 7, `TV-PG` 10, `TV-14` 14, `TV-MA` 17), numeric systems such as FSK (`0`–`18`),
and BBFC-style values (`U`, `12A`, `15`, `18`, `R18`). If TMDB does not know the title,
a restricted viewer is denied (`rating_unavailable`); while TMDB cannot be reached (and the rating
is not cached) the request answers `503 catalog_unavailable` so the app can retry.

The same rule runs through the [catalog](#catalog): search results, home rows and the Movies/Series pages simply leave
out titles the viewer may not watch (and unrated ones when **Block unrated** is on), while
details, seasons and versions of such a title answer `403 age_restricted` with the reason.

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
  same `202` answer, so the endpoint does not reveal who has an account. Username and e-mail address of
  one account are not linkable either: the only "wait" answer (`429`) is a cooldown per typed login, and
  asking by the other login while the account's code was just sent answers `202` without a second mail
  (at most one code per 30 seconds and five per hour per account, whichever login is used). Mail is sent with
  [MailKit](https://github.com/jstedfast/MailKit) off the request path.
- **Sessions** are per device: a short-lived opaque access token (default 60 minutes) and
  a rotating refresh token (default 30 days). Each refresh hands out a new pair. The
  previous refresh token gets that same pair again within 30 seconds (two tabs refreshing at
  once) and also later while the new pair is still unused — no request was authenticated with
  its access token and its refresh token was never presented — as long as the previous token
  is within its own lifetime. That covers an app killed after the server rotated but before it
  stored the new pair; if the replayed access token has expired meanwhile, a fresh one comes with
  the same refresh token. Once the new pair has been used, presenting the previous token — or
  any older one of the session — ends the session (`refresh_token_reused`, theft detection).
  A refused refresh says why: `refresh_session_expired` (refresh window over), `refresh_session_revoked` with
  `params.reason` (`signed_out`, `revoked_by_viewer`, `session_limit`, `admin`, `password_changed`,
  `account_disabled`, `token_reused`), or `refresh_token_unknown` (no session matches — e.g. a device restored
  from an old backup or emulator snapshot). Deleted sessions leave 30-day tombstones (refresh-token hashes,
  session/viewer id, reason) so old tokens keep their reason; lookups are by token hash only, and refusals are
  logged with case and ids, never with token material (see api.md → Refresh failures).
  Viewers see and revoke their devices; admins can revoke all of them.
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
- **No caching of secrets**: every `/api` response carries `Cache-Control: private, no-store`,
  `Pragma: no-cache` and `Expires: 0` (one central rule, see `docs/api.md` → Caching). Native
  clients keep tokens in the platform keystore and must not let their HTTP stack persist
  responses: iOS `NSURLCache` stored a `no-store` second-factor response with both tokens in
  `Library/Caches/<bundle>/Cache.db`, so the app disables or clears its URL cache.

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

- **Continue watching** lists works with a resume position, most recent first. Once a playback
  crosses the played threshold, later reports of that same playback (late or out-of-order progress,
  seeking back during the credits) leave the work played without a resume point, so it leaves
  continue watching and next up moves on to the next episode. Watching a played work again
  (a new `playbackId`) keeps it played and gives it a resume point that playback starts offer
  (`resumePositionTicks`). A replay inside the same playback counts the same way: once a report of
  the completing playback goes back below the minimum resume percentage, it starts a new viewing
  (later reports set a resume point again, the work stays played, reaching the end counts another play).
- **Next up** takes the furthest played episode of each recently watched series and
  suggests the first unplayed, already aired episode after it, crossing into the next
  season when needed. Episode lists come from TMDB (cached; no indexer searches). If
  TMDB cannot be asked for a series, the response sets `incomplete: true`.
- **Current episode of a series:** an episode with a resume point that was played more recently
  than the latest completion in its series (e.g. a replay of a watched episode) wins over next up —
  in next up, continue watching (which then shows only that episode of the series) and the series'
  `nextEpisode`. Next up never skips an episode without versions; it comes with `available: false`.
- **Played / unplayed** accept movie and episode ids, and also season (`tmdb-tv-1396-s02`)
  and series (`tmdb-tv-1396`) ids that expand to all aired episodes.
- A report that includes a `releaseId` (and optionally the stream token) is also passed
  on to the shared playback event stream with source `streamarr-viewer`, so
  notifications, playback ranges, and next-episode pre-downloads behave as they do for
  Jellyfin. A report with the `playbackId` of a [server playback](#playback) fills both in
  and doubles as that playback's heartbeat.

## Catalog

`/api/v1/viewer/catalog` is what a viewer app browses. It is a thin layer over what the server
already has — TMDB metadata, the viewer's watch state and the normal search ranking — so it
needs no extra setup beyond a TMDB credential and at least one indexer.

| What | How it works | Cost |
|---|---|---|
| Search | TMDB movie and series candidates for a query. | TMDB only (cached) |
| Home rows | TMDB **trending** and **popular** movies and series. | TMDB only, cached for `Tmdb:DiscoverCacheTtlHours` (default 6 h) |
| Movies / Series pages | One page of TMDB discover for movies or series, filtered by genre and sorted by popular, top rated or newest, with paging; the genre list comes from TMDB. | TMDB only, each page cached like the home rows; genres for `Tmdb:CacheTtlHours` |
| Movie / series details | Metadata (incl. title logo, certification), the viewer's watch state, and for series the season list with played counts and the **next episode** to play (`start`, `next` or `resume`). | TMDB only (cached) |
| Season | Every episode with its watch state; with `availability=true` also how many versions each episode has. | TMDB only; `availability=true` runs one season-wide indexer search |
| Versions | The releases of a movie or episode the server would play, best first, with parsed attributes (resolution, codec, HDR incl. Dolby Vision, audio, languages, size, estimated bitrate, age, health, local pre-download) and the recommended one. | One indexer search per movie or season, cached |

- Rows, pages and search results are TMDB data: a title can appear there and still have no versions.
- Every title carries a **palette** (`tint` accent, `tint2` deep shade) extracted from its artwork in
  the background and cached; the first listing of a new title may come without it.
- List items carry a small **spec summary** (resolution, HDR, codec, audio) of the best version
  known from the last version lookup; it stays empty until someone opened the title's versions.
- When TMDB cannot be reached, the catalog says so (`503 catalog_unavailable`, retry) instead of
  answering "not found" or an empty list; home rows leave out only the rows that failed.
- Versions never contain NZB links, indexer names or keys.
- Version lists are cached for `Streamarr:ViewerVersionsCacheSeconds` (default 600 seconds) per
  movie and per season, shared by all viewers; a client can ask for `?refresh=true` (answered from
  the cache while a search runs or the list is younger than a minute). Health and
  local pre-downloads are always current: a release a playback just found dead drops out
  immediately.
- A client can send a compact device profile with the versions request to get a
  **predicted playback method** (`direct`, `remux`, `transcode`; `vlc` with `vlcAvailable=true`) per
  version. It is a prediction from the release name, labelled with every assumption it makes; the
  server decides for real when playback starts. Once the server has opened a release (a playback
  probe or a live stream), the prediction uses its real container instead of assuming MKV.
- **Recommended depends on the device.** With a device profile, the recommended version is the best
  quality that plays **without a server transcode** (the device's player directly, a server remux, or
  VLC); at the same resolution direct beats remux beats VLC, and health and the ranker score order
  the rest. Only when nothing plays without a transcode is the best transcode recommended; a version
  the device cannot play at all is never recommended. The list follows that order (`rank`);
  `qualityRank` keeps the device-independent quality order. A plain "Play" (playback without a
  version) starts the same pick for the device it sends.

See [API reference § 13](api.md#13-viewer-catalog-and-playback) for the contract.

## Playback

`/api/v1/viewer/playback` is how a viewer app starts watching. The app sends the work, optionally a
version, and what the device can play (a **device profile**: platform, its native or web player's
containers and codecs with limits, subtitle formats, HLS support, whether VLC is bundled, an
optional bandwidth cap) plus the viewer's preferences (engine, maximum height or bitrate, audio and
subtitle language, subtitle mode). The server then works asynchronously and the app polls a state
(a long-poll with `?waitMs=` answers as soon as it changes):

`queued → resolving → (fallback) → (repairing) → planning → starting → ready | failed`

- **Resolve** is the same pipeline the Jellyfin plugin uses: a Usenet health check, automatic
  fallback to the next healthy version when the chosen one is dead (every hop is listed in
  `attempts`), and a PAR2 repair with progress and ETA when nothing else is left. Without a version,
  the version recommended for the sent device profile plays.
- **Decision.** The server probes the file and picks, in this order: the device's own player
  playing the original file, the device's player via a server **remux** (video copied, audio copied
  or converted, text subtitles as WebVTT), **VLC** playing the original file (only when the app
  bundles it), and last a full **transcode** (only when the viewer may transcode; at most 1080p
  unless the viewer asks for more, text subtitles as WebVTT, played by the device's own player even
  when the viewer prefers VLC). An engine that tone-maps HDR itself (VLC, browsers) gets HDR10/HLG
  files without a transcode. Image subtitles
  the device's player cannot show are played with VLC, else burned into a transcode, else left out
  (and said so). Audio and subtitle tracks follow the viewer's languages; forced subtitles for the
  audio language are the default.
- **Ready** carries the method, the engine, a URL, full track lists (what is delivered how) and
  the reasons for the decision as stable codes the app can translate. **Failed** carries an error
  code and what the viewer can do next (retry, another version, lower quality, use VLC).
- **URLs need no credentials.** They are capability paths on the server (`/api/v1/stream/…` for the
  original file, `/api/v1/transcode/…/master.m3u8` for HLS), so any player can open them. HLS URLs
  stop working when the playback ends; an original-file URL is the stream capability itself and
  works until it expires (24 h by default). A web app on another origin needs
  `Streamarr:ViewerCorsOrigins` ([setup](setup.md#7-configuration-reference-streamarroptions)).
- **Switching** audio, subtitles, engine, quality or version re-plans the same playback at the
  current position; the old URL keeps working for 30 seconds after the new one is ready. A player
  error can ask for the next method (`stepDown`).
- **Limits.** The age gate applies on start and on every switch (`403 age_restricted`). With
  **Max. concurrent streams**, a playback counts while it is prepared and while its app reports
  progress or its player fetches the HLS stream (within `Streamarr:ViewerPlaybackHeartbeatSeconds`,
  default 60 s); a second device at the
  limit gets `409 too_many_streams` naming the device that is playing, while the same device simply
  replaces its previous playback. Stopping (or `event: stop` in watch progress) ends the server's
  remux/transcode and frees the slot.
- **Ownership and expiry.** A playback belongs to the device that started it; everyone else gets
  `404`. Playbacks without polls, progress, switches or HLS fetches for `Streamarr:ViewerPlaybackIdleSeconds`
  (default 600 s) are stopped. They are kept in memory only.

The Dev World (`server/tests/Streamarr.DevWorld`) exercises all of it against real generated media;
`server/tests/Streamarr.DevWorld/tools/e2e_playback.py` plays every variant with Android TV, Apple TV,
Chrome and Safari profiles, and `tools/contract_check.py` checks the viewer API's real responses
(long-poll, switch errors, WebVTT in transcodes, HDR tone mapping, …) against `server/openapi/v1.json`.

## Email delivery

| Mode | Behaviour |
|---|---|
| Disabled | No mail. Sign-in codes and password reset are unavailable. |
| SMTP | Real delivery through MailKit (host, port, `auto` / `none` / `startTls` / `sslOnConnect`, optional credentials, sender). The password is encrypted at rest and never returned by the API. **Send test email** reports transport errors directly. |
| Test outbox | The last 50 messages stay in memory and are visible to admins in the test harness (`GET /api/v1/config/viewers/outbox`). Nothing leaves the server. |

## API overview

See [API reference § 12](api.md#12-viewer-accounts-and-watch-state) (accounts and watch
state), [§ 13](api.md#13-viewer-catalog-and-playback) (catalog and playback) and the OpenAPI document for the complete
contract.
