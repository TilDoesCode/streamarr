# API contract — `/api/v1`

The Core Server's HTTP API is **the** cross-interface contract (BRIEF §3.1): the
Jellyfin plugin, the Management UI, and any future client all speak it. The Management
UI generates its TypeScript types from the frozen spec at
[`server/openapi/v1.json`](../server/openapi/v1.json); the Jellyfin plugin maintains
bounded DTOs for only the fields it consumes, and future clients can generate from the
same spec. This document is the human-readable companion to that spec — it does not add
or remove endpoints, it explains them. **If an endpoint is not in `v1.json`, it does
not exist.**

The spec is served live at `/openapi/v1.json` (all environments) and, in Development,
browsable at `/swagger`. Viewer endpoints declare their gate responses too (`401`,
`403 password_change_required`, `404 module_disabled`, `400 invalid_request`). Properties the
server may send as `null` are `nullable` (object-typed ones as `allOf: [$ref]` + `nullable: true`,
so generated types read `X | null`). `server/tests/Streamarr.DevWorld/tools/contract_check.py`
checks live Dev World responses of the viewer API against the spec.

> Shapes are domain-shaped around *works*, *releases*, *streams*, *sessions*, and
> *profiles* — never around Jellyfin. `/resolve` returns a neutral `mediaStreams`
> shape, not Jellyfin's `MediaStream`; the plugin maps it. See
> [`architecture.md`](./architecture.md).

---

## 1. Authentication

Administrative and machine API endpoints use one authentication scheme with three
credential transports (viewer accounts use a separate scheme, see
[§ 12](#12-viewer-accounts-and-watch-state)), resolved by
([`StreamarrAuthenticationHandler`](../server/src/Streamarr.Server/Auth/StreamarrAuthenticationHandler.cs)):

| Mode | Token | Scope |
|---|---|---|
| **Machine / API key** | The static bootstrap key (`Streamarr:ApiKey`) or a key minted via `POST /config/apikeys`. | `search`, `resolve`, two-phase `playback-sessions`, release `local-availability`, `events`, `caps`, and shallow `health`. **Not** `/config`, `/debug`, repair administration, session listing, or metrics. |
| **Browser admin session** | The HttpOnly, `SameSite=Strict` cookie set by `POST /auth/login`. | Everything, including `/config/*` and `/debug/search`. Unsafe requests additionally require an exact same-origin `Origin` header. |
| **Non-browser admin session** | A short-lived JWT from `POST /auth/login`, sent as a bearer token. | The same admin scope; retained for CLI and API clients. |

- An explicit bearer header takes precedence over the ambient cookie. API keys are
  tried first (a constant-time hash compare); anything else is validated as a JWT.
- The Management UI never stores or sends the JWT. It uses the same-origin HttpOnly
  cookie and keeps only non-secret username, role, and expiry metadata in browser
  storage. `POST /auth/logout` expires the cookie and invalidates all issued admin
  tokens; a password change does the same.
- **`/stream/{token}` is capability-authorized.** Resolve creates a random 192-bit,
  short-lived session token. Possession of that exact path authorizes only that stream;
  no admin JWT or reusable machine API key belongs in the URL or query string. Treat the
  complete stream path as a secret and redact it from proxy access logs.
- `POST /sessions/{token}/close` uses the same capability. Listing sessions and reading
  metrics require an admin session.
- **Admin-only** endpoints (`/config/*`, `/config/apikeys`, `/auth/password`,
  `/debug/search`) reject a machine key with `403`. Machine keys cannot mint or revoke
  keys.
- `GET /health` is anonymous, shallow liveness by default. `?deep=true` performs cached,
  rate-limited dependency checks and requires an admin session.

### `POST /api/v1/auth/login`

Exchange admin credentials for a session token (anonymous).

```http
POST /api/v1/auth/login
Content-Type: application/json

{ "username": "admin", "password": "•••••" }
```
```json
{
  "token": "eyJhbGciOi…",
  "tokenType": "Bearer",
  "expiresInSeconds": 86400,
  "expiresAt": "2026-07-14T11:00:00Z",
  "refreshExpiresAt": "2026-08-12T11:00:00Z",
  "username": "admin",
  "role": "admin"
}
```
`401` on bad credentials. The access JWT and HttpOnly browser cookie live for
`Streamarr:AdminSessionTtlSeconds` (default 86400 / 24 hours). Browser logins also receive a
Strict, HttpOnly refresh cookie with a sliding `Streamarr:AdminRefreshTokenTtlSeconds`
window (default 2592000 / 30 days); its opaque value is never returned in JSON. The Management
UI calls `POST /auth/refresh` before access expiry, which rotates the refresh token and restarts
that 30-day window. The returned bearer token remains available for non-browser clients.
Related: `GET /auth/me` (identity behind the current credential), `POST /auth/logout` (`204`),
and `POST /auth/password` (admin self-service change; `204`). Logout and password changes
revoke the affected refresh session(s).

---

## 2. The error envelope

Every non-2xx response uses one typed envelope:

```json
{ "error": { "code": "release_not_found", "message": "No release is registered for id …" } }
```

`code` is a stable machine-readable slug; `message` is human-readable. The Management
UI renders this consistently (toasts + inline field errors). Representative codes:
`missing_query`, `release_not_found`, `no_playable_file`, `invalid_release`,
`usenet_unreachable`, `nzb_fetch_failed`, `unknown_stream`.

Some errors add an optional `params` object of string values for localized messages, for
example `403 age_restricted` from the viewer catalog
(`"params": { "reason": "above_age_limit", "rating": "R", "minimumAge": "17", "viewerMaxAge": "12" }`).
The key is omitted when an error has no parameters.

A `429` that knows how long the caller must wait (e.g. `email_code_cooldown`) also carries a typed
`retryAfterSeconds` integer next to `code`, the same value in `params.retryAfterSeconds` and in the
`Retry-After` header. The key is omitted otherwise.

Cross-origin viewer apps (`Streamarr:ViewerCorsOrigins`) can read `Retry-After`, `Content-Type`,
`Content-Length`, `Content-Range`, `Accept-Ranges`, `Location` and `ETag` on every answer of the viewer API and of the
`/stream` and `/transcode` URLs (`Access-Control-Expose-Headers`, also on errors such as `503`/`504` segments).
Players that load segments themselves (hls.js) do not pass response headers on; such a client can only honour the
`Retry-After` of requests it makes with `fetch`/XHR directly.

### Caching

Every response under `/api` (any status, method or caller) carries `Cache-Control: private, no-store, max-age=0`,
`Pragma: no-cache` and `Expires: 0`. One central rule applies this (`NoStoreApiResponses`, stamped again just before the
headers are sent, so an endpoint cannot weaken it); it covers every route that returns a secret: admin and viewer
sign-in, second factor, e-mail codes, refresh, password reset, 2FA setup and recovery codes, generated passwords,
playback responses with stream URLs, and the `/stream` and `/transcode` capability URLs. New endpoints under `/api` are
covered automatically; `NoStoreRouteWalkTests` walks every operation in the OpenAPI document and checks the headers.
Clients must still keep secrets out of their own HTTP caches: iOS `NSURLCache` was seen writing a `no-store` sign-in
response to `Cache.db` (the client clears or disables its URL cache; see `docs/viewers.md`). Only the static
`/watch` app shell and its hashed assets are cacheable.

---

## 3. Search

### `GET /api/v1/search`

Query params: `q` (required unless `imdbId`/`tmdbId` given), `type`
(`movie`|`tv`|`any`), `season`, `episode`, `imdbId`, `tmdbId`, `profileId` (optional
ranking-profile override). Returns works, each with its **ranked** releases. The NZB
URL and indexer API keys are never present (BRIEF §6.2).

Free-text queries are resolved to TMDB's ordered movie/TV candidates first, so aliases
such as `Dune 2` can be intersected with the releases returned by indexers. A public
search result is an identity and availability promise: unidentified parser buckets and
rejected releases are omitted, and a work is omitted when none of its releases pass the
selected profile's rejection checks. Use `/debug/search` to inspect raw or rejected
candidates and their reasons. With no TMDB key, this public endpoint returns an empty
result while `/debug/search` continues to expose the raw indexer pipeline.

```json
{
  "results": [
    {
      "workId": "tmdb-movie-12345",
      "mediaType": "movie",
      "title": "Example", "year": 2021,
      "tmdbId": 12345, "imdbId": "tt1234567",
      "overview": "…", "posterUrl": "https://…", "backdropUrl": "https://…",
      "runtimeMinutes": 130,
      "releases": [
        {
          "releaseId": "sha256-of-guid",
          "title": "Example.2021.1080p.WEB-DL.x265.DDP5.1-GROUP",
          "indexer": "indexerName",
          "sizeBytes": 5368709120,
          "quality": {
            "resolution": "1080p", "source": "WEB-DL", "codec": "x265",
            "hdr": "HDR10", "audio": "DDP5.1", "edition": null,
            "proper": false, "repack": false
          },
          "languages": ["de", "en"],
          "releaseGroup": "GROUP",
          "ageDays": 12, "grabs": 34,
          "score": 850,
          "rejected": false, "rejectionReasons": [],
          "health": "unknown"
        }
      ]
    }
  ]
}
```

`health` is `"unknown"` until a release has been resolved (or is cached dead by the
health cache); it is one of `unknown` | `ready` | `degraded` | `dead`. `mediaType` on
a work is `"movie"` or `"tv"`; TV works also carry `season`/`episode`.

### Lazy TV catalog

TV discovery uses a hierarchy rather than returning a random flat sample of episodes:

| Request | Result | External cost on a cache miss |
|---|---|---|
| `GET /api/v1/tv/search?q=Suits&limit=3` | Up to three TMDB-ranked series works | One TMDB search; **no indexer call** |
| `GET /api/v1/tv/37680` | Series metadata plus every season summary | One TMDB series-detail call; **no indexer call** |
| `GET /api/v1/tv/37680/seasons/1` | Every canonical episode, with accepted releases overlaid | One TMDB season-detail call plus **one season-scoped fan-out per configured indexer** |

The server does not issue one indexer request per episode. A season is searched once,
then parsed episode coordinates are distributed over the complete TMDB episode directory.
Episodes with no accepted release remain in the response with `"releases": []`, allowing
clients to show the complete season and distinguish “not found” from missing metadata.

**Season packs are matched.** A release whose name parses as a full-season pack
(`Show.S01`, `Show Season 1`) is overlaid onto every canonical episode of that season and
registered under each episode work. Resolving it with an episode `workId` streams exactly
that episode's payload: the episode's own file or RAR set inside the NZB when names carry
episode numbering, or — for a monolithic RAR set — the matching stored file inside the
archive, located byte-exactly through the RAR header chain (no extraction; seeking stays
pure offset arithmetic). A pack that does not contain the requested episode fails the
resolve with `no_playable_file` rather than ever streaming a wrong episode. Known
limitations: multi-season packs (`S01-S05`) are only overlaid onto their first season, and
packs whose *inner* file names are fully obfuscated cannot be episode-matched and are
refused for safety.

The series-search `limit` is constrained to `1..3`. The season endpoint accepts the same
optional `profileId` ranking override as `/search` and returns per-indexer diagnostics in
`indexers`. All three endpoints use the normal machine/admin authentication policy.

### `POST /api/v1/debug/search` (admin only)

The single most valuable dev/tuning tool. Same query shape as `/search` (as a JSON
body), but returns **every** release including rejected ones, each with its parsed
fields, per-rule score breakdown, and rejection reasons — plus per-indexer fan-out
diagnostics. It also accepts an inline **draft `profile`** so the Management UI can
re-rank against an unsaved profile without persisting it.

```json
{
  "results": [
    {
      "workId": "tmdb-movie-12345", "mediaType": "movie", "title": "Example",
      "releases": [
        {
          "releaseId": "…", "title": "Example.2021.1080p.WEB-DL.x265-GROUP",
          "indexer": "indexerName", "sizeBytes": 5368709120,
          "ageDays": 12, "grabs": 34, "score": 850, "rejected": false,
          "health": "unknown",
          "parsed": {
            "title": "Example", "year": 2021, "mediaType": "movie",
            "resolution": "1080p", "source": "WEB-DL", "videoCodec": "x265",
            "hdr": "HDR10", "audioCodec": "DDP", "audioChannels": "5.1",
            "atmos": false, "edition": null, "releaseGroup": "GROUP",
            "proper": false, "repack": false, "languages": ["de","en"]
          },
          "scoreBreakdown": [
            { "rule": "resolution", "points": 100 },
            { "rule": "source", "points": 64 },
            { "rule": "codec", "points": 40 }
          ],
          "rejections": []
        }
      ]
    }
  ],
  "indexers": [
    { "indexerId": "abc", "indexerName": "indexerName",
      "status": "ok", "itemCount": 42, "elapsedMs": 812.4, "error": null }
  ]
}
```

The rejection `code` values and the `scoreBreakdown` `rule` names are documented in
[`ranker-tuning.md`](./ranker-tuning.md). Neither search endpoint ever exposes an NZB
URL or indexer key.

---

## 4. Resolve

### `POST /api/v1/resolve`

Fetches the release's NZB, identifies the primary media file (unwrapping RAR),
STAT-samples its segments for a health classification, opens a session, and
**ffprobes the stream server-side** so the caller gets pre-probed media info and never
has to probe a slow remote source (BRIEF §11).

```json
{
  "releaseId": "sha256-of-guid",
  "workId": "tmdb-tv-90228-s01e02",
  "client": "web",
  "autoFallback": true
}
```

| Field | Meaning |
|---|---|
| `releaseId` | The release to resolve (required). |
| `workId` | Owning work from the search result. Optional for legacy single-owner releases, but required to disambiguate a multi-episode release and keep fallback/session attribution on the selected episode. |
| `client` | Originating front-end for session attribution (`"jellyfin"`, `"web"`, …). |
| `autoFallback` | **Default `true`.** When a release resolves `dead`, transparently retry the next-best release of the same work, bounded by `Streamarr:MaxFallbackHops` (default 3), and return the first healthy one. Set `false` to get the raw classification of exactly this release plus a `suggestedFallbackReleaseId`. |

A healthy (`ready` or `degraded`) response:

```json
{
  "releaseId": "sha256-of-guid",
  "status": "ready",
  "streamUrl": "/api/v1/stream/<opaque-token>",
  "container": "mkv",
  "sizeBytes": 5368709120,
  "runTimeTicks": 78000000000,
  "mediaStreams": [
    { "type": "Video", "codec": "hevc", "width": 1920, "height": 1080 },
    { "type": "Audio", "codec": "eac3", "channels": 6, "language": "deu" },
    { "type": "Subtitle", "codec": "subrip", "language": "eng" }
  ],
  "sessionTtlSeconds": 86400,
  "suggestedFallbackReleaseId": null,
  "fallbackFromReleaseId": null,
  "attempts": [ { "releaseId": "sha256-of-guid", "status": "ready" } ]
}
```

**Status** is `ready` | `degraded` | `dead`. `degraded` still returns a session and a
stream URL (some sampled segments were missing but the release is playable); `dead`
returns no `streamUrl`.

**M7 auto-fallback fields:**

- `attempts` — the chain of releases the pipeline tried, in order, each with its health
  classification. A front-end can surface exactly what happened.
- `fallbackFromReleaseId` — set when the returned release came via auto-fallback; it is
  the release **originally requested** (which resolved dead). `null` when the requested
  release resolved directly. (The server counts a resolve as `viaFallback` in
  `/metrics` iff this is non-null.)
- `suggestedFallbackReleaseId` — the next-best release of the same work, set **when the
  requested release is dead and auto-fallback is disabled or exhausted**, so a client
  can still retry manually. A cached-dead release is skipped when choosing this.

A dead-and-exhausted response (e.g. `autoFallback: false` on a dead release):

```json
{
  "releaseId": "sha256-of-guid",
  "status": "dead",
  "streamUrl": null,
  "sessionTtlSeconds": 86400,
  "suggestedFallbackReleaseId": "sha256-of-next-best",
  "fallbackFromReleaseId": null,
  "attempts": [ { "releaseId": "sha256-of-guid", "status": "dead" } ]
}
```

Errors: `404 release_not_found`; `422 no_playable_file` / `invalid_release` (the NZB
has no playable media file, or is malformed); `502 usenet_unreachable` /
`nzb_fetch_failed` (the provider or indexer could not be reached, or the indexer returned
an HTML page instead of an NZB document). A dead classification is **not** an error — it
is a `200` with `status: "dead"`.

Whatever the outcome, a dead release is recorded in the health cache
(`Streamarr:HealthCacheTtlSeconds`) so it is demoted/rejected on later searches and
skipped as a future fallback (see [`architecture.md`](./architecture.md) §5.3).

---

## 5. Stream

### `GET|HEAD /api/v1/stream/{token}`

A plain, capability-authorized, **Range-capable** HTTP byte stream (BRIEF §3.3). Player-
agnostic by contract — ffmpeg, mpv, VLC, `<video>`, ExoPlayer, AVPlayer. **No
Jellyfin-specific behavior may ever be added here.**

- Honors `Range: bytes=…` → `206 Partial Content` with a correct `Content-Range` and
  `Accept-Ranges: bytes`. No `Range` header → `200` with the full body.
- `HEAD` returns the same immutable `Content-Length`, `Content-Type`, and range support
  without opening the payload or consuming a stream-capacity lease.
- Supports open-ended (`bytes=N-`) and suffix (`bytes=-N`) ranges, and seeking to
  **anywhere** in the file — including across RAR volume boundaries, since the streaming
  core does random access over the RAR-wrapped payload.
- `404 unknown_stream` when the token maps to no live session (closed or expired).

```http
GET /api/v1/stream/abc123 HTTP/1.1
Range: bytes=1048576-2097151
```
```http
HTTP/1.1 206 Partial Content
Accept-Ranges: bytes
Content-Range: bytes 1048576-2097151/5368709120
Content-Type: video/x-matroska
Content-Length: 1048576
```

The same URL works in browser `<video>` and Jellyfin/ffmpeg without attaching a reusable
credential. Seek and time-to-first-byte characteristics are measured in
[`m1-latency.md`](./m1-latency.md); concurrent-range behavior in
[`m7-cache-loadtest.md`](./m7-cache-loadtest.md).

---

## 6. Sessions

### `GET /api/v1/sessions`

Lists live sessions — release, work, state, bytes served, NNTP usage, originating
client, timestamps:

```json
[
  {
    "token": "abc123", "releaseId": "…", "workId": "tmdb-movie-12345",
    "state": "streaming", "container": "mkv",
    "sizeBytes": 5368709120, "bytesServed": 734003200,
    "nntpConnectionsInFlight": 3, "nntpCommandsTotal": 512,
    "client": "web",
    "retentionPriority": "normal",
    "preDownloadKind": "currentFile", "preDownloadState": "downloading",
    "preDownloadReason": "Playback passed 10 seconds",
    "preDownloadedBytes": 2147483648, "preDownloadTotalBytes": 5368709120,
    "preDownloadPercent": 40, "localCacheReady": false,
    "createdAt": "2026-07-13T11:20:00Z",
    "lastAccessedAt": "2026-07-13T11:24:10Z",
    "expiresAt": "2026-07-13T12:20:00Z"
  }
]
```

### `POST /api/v1/sessions/{token}/close`

Immediately tears a capability down (`204`; `404` if unknown). This is reserved for rejected or
administratively cancelled opens; ordinary Jellyfin/Swiftfin stop and `CloseLiveStream` callbacks
are telemetry only because those callbacks can be transient.

Core owns normal lifecycle deterministically. Full decoded file sizes count against
`Streamarr:EphemeralCacheSizeMb`; admitting a new file evicts whole entries by oldest actual byte
access until it fits, while one oversized file may stand alone. Every entry also expires at
`createdAt + SessionTtlSeconds` regardless of access. The sweep may therefore revoke an open
stream only at that configured hard deadline, not because a client briefly reported playback as
stopped.

### `GET /api/v1/ephemeral-files` (admin only)

Operational view of the server-owned ephemeral file cache — one row per live file with its
requester, decoded-size allocation, chunk footprint, resident storage, LRU access, hard expiry,
and an `isStreaming` flag marking files with at least one open HTTP stream. Pre-downloaded files
also expose their disk bytes, completion state, trigger reason, and `retentionPriority`.

### `POST /api/v1/ephemeral-files/{token}/purge` (admin only)

Manually reclaims one **idle** cached file (`204`). Refuses with `409 stream_active` while the
file is being actively streamed (`isStreaming: true`) so operator cleanup never interrupts live
playback, and `404 unknown_ephemeral_file` if no live file exists for the token. Unlike the
hard-TTL sweep and LRU eviction, this guard protects in-flight streams; use
`POST /sessions/{token}/close` when a stream must be torn down regardless.

### `POST /api/v1/releases/local-availability`

Machine-authenticated, user-scoped lookup used by the Jellyfin plugin before it projects
episode versions. The request carries 1–200 exact `workIds`, `client`, and `requestedById`;
the response lists up to 20 matching, unexpired sessions per work that have a pre-download file,
with state `ready` or `downloading`. When the release is still registered, its public metadata is
included so Jellyfin can transiently expose a local release even when it fell outside the normal
top-20 projection; NZB locations are never returned. Jellyfin keeps Core's release ranking within
each state but places ready releases first, then in-progress local releases, and prefixes their
version names with `[D]` or `[~]`. A failed lookup is treated as no local information, preserving
normal ranking.

---

## 7. Events

### `POST /api/v1/events`

Ingests a playback event from any front-end into SQLite (BRIEF §6.1 module 7). This is
how watch state escapes a front-end's own DB. `202 Accepted`.

```json
{
  "releaseId": "…", "workId": "tmdb-tv-90228-s01e02",
  "event": "progress", "positionTicks": 42000000000,
  "durationTicks": 56000000000, "sessionToken": "<opaque-token>",
  "source": "jellyfin"
}
```
`event` is `"start"` | `"progress"` | `"stop"`; `source` is the originating front-end.
`durationTicks` makes the next-episode threshold a watch-position percentage, independent of
downloaded bytes. `sessionToken` binds the event to the exact live capability that may trigger a
pre-download.

### `GET /api/v1/pre-downloads` (admin only)

Lists live and recently finished pre-download jobs. Optional `sessionToken` filtering returns
jobs where that session is either the playback source or the prepared target. Each row keeps the
watch-trigger snapshot (`watchPositionTicks`, `watchDurationTicks`, `watchProgressPercent`)
separate from disk materialization (`bytesDownloaded`, `totalBytes`, `progressPercent`) and also
reports kind, reason, target episode, low priority, timestamps, and any skip/failure code.

---

## 8. Health, caps, metrics, logs

### `GET /api/v1/health`

Anonymous, rate-limited liveness is shallow by default. Pass `?deep=true` with an admin
session to run cached, time-boxed per-indexer (`t=caps`) and per-provider (connect +
`AUTHINFO`) reachability checks. Dependency errors are reduced to safe status values;
one dead dependency never turns the liveness endpoint into a server error. The Compose
healthcheck uses the default shallow form.

```json
{
  "status": "ok", "version": "0.1.0",
  "indexers": [ { "name": "indexerName", "reachable": true, "latencyMs": 812.4, "error": null } ],
  "providers": [ { "name": "primary", "reachable": true, "latencyMs": 143.0, "error": null } ]
}
```

### `GET /api/v1/caps`

The categories the configured indexers search and the providers streaming can draw
from — a front-end's view of what this server supports (`mediaTypes`, `categories[]`,
`providers[]` with `priority`/`enabled`/`backupOnly`).

### `GET /api/v1/metrics`

Admin-only operational snapshot (BRIEF §10-M7). It includes provider and session
activity, so machine keys are intentionally insufficient.

```json
{
  "sessions":     { "active": 2, "openedTotal": 57, "closedTotal": 55 },
  "connections":  {
    "budget": 20, "inUse": 5,
    "providers": [
      { "name": "primary", "priority": 0,
        "liveConnections": 8, "activeConnections": 5, "idleConnections": 3,
        "availableConnections": 2, "tripped": false },
      { "name": "block-account", "priority": 1,
        "liveConnections": 0, "activeConnections": 0, "idleConnections": 0,
        "availableConnections": 10, "tripped": false }
    ]
  },
  "resolves":     { "total": 40, "viaFallback": 6 },
  "searchCache":  { "entries": 12, "hits": 88, "misses": 30, "hitRate": 0.7459 },
  "bytesServedTotal": 10737418240,
  "indexers": [
    { "id": "abc", "name": "indexerName",
      "requests": 30, "failures": 1, "lastLatencyMs": 812.4, "avgLatencyMs": 771.9 }
  ]
}
```

| Group | Fields |
|---|---|
| `sessions` | `active` (live now), `openedTotal`, `closedTotal` (cumulative). |
| `connections` | `budget` (= `Streamarr:ConnectionBudget`), `inUse` (NNTP commands occupying a connection now), and per provider: `liveConnections`, `activeConnections`, `idleConnections`, `availableConnections`, `tripped` (circuit breaker open → failover in effect). |
| `resolves` | `total`, `viaFallback` (resolves that returned a release reached via auto-fallback). |
| `searchCache` | `entries`, `hits`, `misses`, `hitRate` (= hits / (hits+misses); 0 before any lookup). |
| `bytesServedTotal` | Cumulative bytes streamed by `/stream`. |
| `indexers[]` | Per-indexer `requests`, `failures`, `lastLatencyMs`, `avgLatencyMs`. |

### `GET /api/v1/logs`

Admin-only, newest-first operational log feed used by the global **Logs** page and each
stream detail page. A machine key is intentionally insufficient because exceptions and
release/work identifiers are operator diagnostics.

| Query | Default | Meaning |
|---|---:|---|
| `source` | `all` | `all`, `core`, or `jellyfin`. Selecting `core` never performs a Jellyfin request. |
| `minimumLevel` | `information` | `trace`, `debug`, `information`, `warning`, or `error`; inclusive. |
| `search` | — | Case-insensitive message/category/exception/identifier filter, at most 256 characters. |
| `streamToken` | — | Correlates Core events by attempt/token and then release/work fallback; Jellyfin lines require the retained release/work identifier. |
| `limit` | `200` | `1..500`; non-positive values use the default and larger values are clamped. |

```json
{
  "entries": [
    {
      "id": "core-1842",
      "atUtc": "2026-08-17T16:42:18.934Z",
      "level": "error",
      "source": "core",
      "category": "Streamarr.Server.Services.SessionManager",
      "message": "Stream read failed for release …",
      "exception": "UsenetArticleNotFoundException: …",
      "releaseId": "…",
      "workId": "…"
    }
  ],
  "sources": [
    { "source": "core", "configured": true, "available": true, "lastCheckedAt": "…" },
    { "source": "jellyfin", "configured": false, "available": false, "message": "…" }
  ],
  "generatedAt": "2026-08-17T16:42:19.441Z",
  "hasMore": false
}
```

The Core source is a sanitized, process-local ring containing the newest 2,000 Serilog
events since startup. It retains only display fields and stream correlation—not arbitrary
structured properties—and redacts credentials and capability paths. Jellyfin is optional;
its availability or configuration failure is returned in `sources[]` without failing the
Core feed. See the setup guide for its bounded full-file retrieval policy and environment
variables.

---

## 9. Config API (admin only)

CRUD for the SQLite-backed config store. **Secrets never cross the wire in plaintext**
(BRIEF §6.3): reads return a masked value plus a `has…` boolean, writes are
omit-to-keep (send a new value to change it; omit to keep the stored one).

### Indexers — `/api/v1/config/indexers`

`GET` (list) · `POST` (create) · `GET/PUT/DELETE /{id}` · `POST /{id}/test`.

```json
// IndexerWrite (POST/PUT)
{ "name": "indexerName", "baseUrl": "https://indexer.example/api",
  "apiKey": "secret", "categories": [2000, 5000], "enabled": true, "priority": 0 }
```
Reads return `IndexerResponse` with `apiKey` masked and `hasApiKey: true`. `POST
/{id}/test` runs a `t=caps` roundtrip and reports `success`, `latencyMs`,
`serverTitle`/`serverVersion`, `categoryCount`, and search-capability flags.

### Providers — `/api/v1/config/providers`

`GET` · `POST` · `GET/PUT/DELETE /{id}` · `POST /{id}/test` · `POST /{id}/speedtest`.
Multiple priority-ordered providers are supported (DECISIONS.md #6): primary +
block-account backup.

```json
// ProviderWrite (POST/PUT)
{ "name": "primary", "host": "news.example.com", "port": 563, "useSsl": true,
  "username": "user", "password": "secret", "maxConnections": 20,
  "priority": 0, "enabled": true, "isBackupOnly": false }
```
Reads return `ProviderResponse` with `password` masked and `hasPassword: true`. `POST
/{id}/test` connects + `AUTHINFO` and reports `success`, `achievableConnections`
(≤ `maxConnections`), and `requestedConnections`.

`POST /{id}/speedtest` opens the provider's configured NNTP connections and transfers
real article bodies for 8 seconds or 512 MiB, whichever comes first. Streamarr discovers
a recent article through common binary test groups; providers that disable `OVER` can be
tested with `{ "messageId": "segment@example", "durationSeconds": 8 }`. The response
includes Mbps/MB/s, setup and first-byte timing, connections used, a conservative maximum
video bitrate with 30% headroom, estimated simultaneous 4K/1080p streams, and a
`streamingTier` (`insufficient`, `sd`, `720p`, `1080p`, or `4k`). The endpoint is
admin-only and consumes provider traffic.

### General — `/api/v1/config/general`

`GET` / `PUT`. TMDB credential (a v3 API key or API Read Access Token; write-only,
masked on read as `hasTmdbApiKey`, omit-to-keep on write), plus `sessionTtlSeconds`,
`searchCacheTtlSeconds`, `segmentCacheSizeMb`, `connectionBudget`. Credential changes
take effect immediately; other scalar changes take effect on restart.

### Pre-download — `/api/v1/config/pre-download`

`GET` / `PUT` the live background-cache policy. Writes are partial and take effect immediately:

```json
{
  "enabled": true,
  "downloadCurrentFile": true,
  "currentFileThresholdSeconds": 10,
  "downloadNextEpisode": true,
  "nextEpisodeThresholdPercent": 75,
  "preferSimilarNextEpisodeRelease": true,
  "nextEpisodeReleaseSimilarityThresholdPercent": 75,
  "maxConcurrentDownloads": 1
}
```

Current-file work completes the already requested session after its watch-time grace period.
Next-episode work resolves the immediate canonical TMDB episode after the configured watch
percentage and admits it at lower retention priority. When release continuity is enabled, the
closest eligible release title at or above the configured similarity threshold is preferred; if
none qualifies, the normal highest-ranked release remains the fallback. Explicit, non-overlapping
language tags never qualify as continuous even when release group and quality otherwise match.
Both job types share the
normal ephemeral TTL and logical byte budget; background NNTP transfers use low priority so
playback traffic wins.

### Notifications — `/api/v1/config/notifications`

`GET` / `PUT` configure Pushover credentials, event switches, message-content switches,
priorities, cooldowns, and dependency-monitor thresholds. The application token and
user/group key are encrypted, masked on reads, and omit-to-keep on writes.
`POST /test` performs an immediate Pushover roundtrip using the saved credentials.
Routine delivery uses a bounded background queue; the test endpoint is synchronous so
configuration errors are returned to the operator.

### Profiles — `/api/v1/config/profiles`

`GET` · `POST` · `GET/PUT/DELETE /{id}`. Quality preference profiles (the ranker
knobs). The built-in default profile is always listed and cannot be edited or deleted;
user profiles are stored as JSON. No secrets. Full field reference in
[`ranker-tuning.md`](./ranker-tuning.md).

### API keys — `/api/v1/config/apikeys`

`GET` (list; prefix + metadata only) · `POST` (create) · `DELETE /{id}` (revoke).

```json
// POST body → response (plaintext token returned ONCE)
{ "name": "jellyfin-plugin" }
→ { "id": "…", "name": "jellyfin-plugin", "token": "sk_live_…" }
```
The plaintext `token` is returned only at creation; thereafter only its `prefix` and
metadata are visible. Keys are **revoked (soft-deleted)**, not hard-deleted, so past
issuance stays auditable.

---

## 10. PAR2 repair & two-phase playback admission

### Additive resolve fields

`POST /api/v1/resolve` responses gained three **additive** fields (absent on older
servers; the legacy meaning of `status=ready|degraded|dead` is unchanged):

```json
{
  "status": "degraded",
  "streamUrl": "/api/v1/stream/<capability>",
  "originHealth": "dead",
  "playability": "progressive",
  "repair": {
    "jobId": "…", "disposition": "repairable", "state": "downloadingRecovery",
    "phase": "recovery", "processedBytes": 123, "totalBytes": 456,
    "progressPercent": 27, "etaSeconds": 180, "retryAfterSeconds": 5,
    "progressiveEligible": true
  }
}
```

- `originHealth` (`unknown|ready|degraded|dead`) is **upstream evidence only** — a
  locally repaired release stays `dead` here while `status` reads `ready` for old
  clients.
- `playability`: `remoteReady | progressive | repairing | repairedReady | unavailable`.
- `repair.disposition`: `unknown | notNeeded | repairable | insufficientParity |
  unsupported | limitsExceeded`; `repair.state`: `none | queued | planning |
  materializingSources | downloadingRecovery | reconstructing | verifying | ready |
  failed | cancelled | evicted`.

### Repair endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/repairs` | admin | Jobs + artifacts + cache budget overview (redacted event log per job). |
| `GET /api/v1/repairs/{jobId}` | admin | One job. |
| `POST /api/v1/repairs` `{releaseId, workId?}` | admin | Idempotent manual start (bypasses the failure backoff; an active job for the fingerprint is returned as-is). |
| `POST /api/v1/repairs/{jobId}/cancel` | admin | Cancels an active job. |
| `GET /api/v1/sessions/{token}/repair` | stream capability | Playability + repair progress for exactly this live session; possession of the token is the authorization (same model as `/timeline`). |

Responses never contain message-ids, workspace paths, passwords or credentials.

### `POST /api/v1/playback-sessions` (two-phase admission)

Same body and machine-auth posture as `/resolve`. Answers within a short hard budget:
`200 {phase:"ready", resolve:{…}}` on the fast path, or `202 {phase:"preparing",
admissionId, retryAfterSeconds}` while health check, materialization, ffprobe and
repair analysis continue server-side under the admission's own lifetime.
`GET /api/v1/playback-sessions/{admissionId}` polls the phase; terminal answers are
`ready` (with the full resolve payload — a dead resolve arrives as `failed` **with**
the resolve payload so fallback attribution survives) or `failed` with a stable,
redacted `error` code (`unknown_release`, `no_playable_file`, `prepare_timeout`, …).

Terminal ownership is explicit:

| Endpoint | Result |
|---|---|
| `POST /api/v1/playback-sessions/{admissionId}/claim` | Atomically consumes a terminal admission and returns its final response. Returns `409` while preparing and `404` when unknown or already claimed. |
| `DELETE /api/v1/playback-sessions/{admissionId}` | Idempotently abandons pending work and closes any idle capability it created. A short claimed-admission handle accepts cleanup after a lost claim response; expiry of that handle does not shorten the capability's normal session lifetime, and cleanup never tears down a stream that has started. |

The Jellyfin plugin polls under an 11-minute deadline, claims only after validating the
terminal response, and abandons every unclaimed path. Jellyfin necessarily holds its
global live-stream lock until `OpenMediaSource` returns; two-phase admission instead
decouples Core work from a single HTTP request and makes cancellation and capability
ownership deterministic. Older Core versions remain supported through a direct
`POST /resolve` fallback.

---

## 11. Server-side transcoding

A separate ffmpeg → HLS path ([`transcoding.md`](./transcoding.md)). It consumes a stream
token like any other player and never changes `/stream`, sessions, or the Jellyfin flow.

### `POST /api/v1/transcoding/sessions`

Admin **or machine key**. Starts an HLS rendition of a live stream capability (or, admin
only, a built-in test sample) and returns a new, unguessable playlist capability.

```json
// TranscodeSessionCreateRequest — exactly one of streamToken / sampleId
{ "streamToken": "abc123", "mode": "auto", "maxHeight": 1080, "maxBitrateKbps": 8000,
  "audioStreamIndex": 1, "audioRenditions": [1, 2], "subtitleStreamIndex": 3, "startPositionSeconds": 0, "clientName": "my-tv-app",
  "client": { "videoCodecs": ["h264", "hevc"], "audioCodecs": ["aac", "ac3", "eac3"], "containers": ["mp4"],
              "maxAudioChannels": 6, "supportsHdr": true, "supports10Bit": true,
              "hdrFormats": ["hdr10", "hlg"], "subtitleFormats": ["srt", "webvtt"] } }
```

`mode` picks the delivery: `auto` (remux when the video can be copied for this client, else
transcode), `remux` (fail with `422 remux_not_possible` otherwise) or `transcode`. Sessions default to
`transcode` so existing callers are unchanged; `POST /transcoding/plan` defaults to `auto` and may also
answer `direct`. `hdrFormats` (`hdr10`, `hlg`, `dolbyvision`) overrides `supportsHdr`;
`subtitleFormats` declares what the player renders from the original file (direct-play check for
`subtitleStreamIndex`). `audioRenditions` (optional, up to 8 indexes, at most 4 are used together with
`audioStreamIndex`) asks for HLS audio renditions: with two or more distinct streams the audio is demuxed into an
`AUDIO` group (see below and [transcoding.md](./transcoding.md#audio-renditions)); without it the selected track is
muxed into the video segments as before. Remuxes are described in [transcoding.md](./transcoding.md#remux-direct-stream).
```json
// 201 TranscodeSessionCreatedResponse (a remux of a 4K HDR10 MKV)
{ "handle": "a53f5b44829f", "mode": "remux",
  "playlistUrl": "/api/v1/transcode/<capability>/master.m3u8",
  "mediaPlaylistUrl": "/api/v1/transcode/<capability>/main.m3u8",
  "durationSeconds": 7201.5, "segmentLengthSeconds": 6, "segmentCount": 1187,
  "plan": { "mode": "remux",
            "reasons": [ { "code": "container_unsupported", "message": "Container 'mkv' is not supported by the player.", "params": { "container": "mkv" } },
                         { "code": "audio_converted", "message": "Audio 'truehd' 8 ch is converted to 'eac3' 6 ch because …",
                           "params": { "from": "truehd", "to": "eac3", "channels": "6" } } ],
            "remuxPossible": true, "remuxBlockers": [],
            "subtitles": [ { "index": 3, "codec": "subrip", "language": "en", "name": "English", "forced": false,
                             "isDefault": false, "textBased": true, "deliveredAs": "webvtt" },
                           { "index": 4, "codec": "hdmv_pgs_subtitle", "language": "de", "name": "German", …, "deliveredAs": "none" } ],
            "keyframeIndex": { "source": "matroska-cues", "keyframes": 2400, "buildMs": 38, "segments": 1187, "maxSegmentSeconds": 8.3 },
            "directPlayPossible": false, "directPlayBlockers": ["…"],
            "target": { "videoCodec": "hevc", "width": 3840, "height": 2160, "videoCopy": true, "videoRange": "PQ",
                        "codecs": "hvc1.2.4.L153.90,ec-3", "audioCodec": "eac3", "audioCopy": false, "audioChannels": 6, … },
            "encoder": "copy", "hardwareDecode": false, "toneMap": "notneeded", … } }
```

Reason codes are stable for localization: direct-play blockers `container_unsupported`,
`video_codec_unsupported`, `bit_depth_unsupported`, `hdr_unsupported`, `interlaced`,
`audio_codec_unsupported`, `subtitle_format_unsupported`, `resolution_exceeds_limit`,
`bitrate_exceeds_limit`; remux blockers additionally `video_codec_not_remuxable`,
`video_profile_unsupported`, `dolby_vision_profile_unsupported`, `keyframe_index_unavailable`; decisions
`direct_play`, `hls_requested`, `transcode_requested`, `audio_copied`, `audio_converted`,
`subtitle_not_deliverable` (`params`: `index`, `codec`, `mode`; an image stream in a remux, or an image
stream a transcode does not burn in), `subtitle_burned_in` (only viewer playback, § 13, burns an image
subtitle into a transcode; these sessions do not). `deliveredAs` is `webvtt` (text streams: an HLS rendition
of a remux or a transcode), `embedded` (direct play), `burnedIn` or `none`. `target` describes what the player receives: the
original streams for `direct` (`videoCopy`/`audioCopy` true, `encoder: none`), the copied video for a
remux (`encoder: copy`), the encoder output for a transcode. `audioRenditions` lists the HLS audio renditions
when the request offers two or more tracks (`audioRenditions` in the body): `id`, `streamIndex`, `language`,
`name` (the playlist `NAME`), `codec`, `channels`, `copy`, `default`; empty when the audio stays muxed.

Errors: `400 invalid_transcode_request` (also for an unknown `mode`), `404 unknown_stream`,
`409 transcoding_disabled`, `422` planning errors (`no_video_stream`, `unknown_duration`,
`unknown_audio_stream`, `unknown_subtitle_stream`, `remux_not_possible`), `502 probe_failed`,
`503 ffmpeg_unavailable`, `503 transcode_capacity`, `503 remux_capacity`, `503 too_many_sessions`. `POST /api/v1/transcoding/plan` takes
the same body and returns only the `plan` without starting ffmpeg.

### `GET /api/v1/transcode/{capability}/…`

Anonymous; the path capability is the credential (like `/stream`), so hls.js, Safari,
and TV players need no headers. `Cache-Control: private, no-store`.

| Path | Result |
|---|---|
| `master.m3u8` | One variant with `BANDWIDTH`, `AVERAGE-BANDWIDTH`, `CODECS`, `RESOLUTION`, `FRAME-RATE`, `VIDEO-RANGE` (`SDR` for transcodes; `PQ`/`HLG`/`SDR` for remuxes). The stream's colour tags always match: a transcode of an HDR source is tagged BT.709 (VUI and `colr`, no mastering/CLL metadata), a remux keeps the source's PQ/HLG tags. Remuxes and transcodes add one `#EXT-X-MEDIA:TYPE=SUBTITLES` per delivered text stream and `CLOSED-CAPTIONS=NONE`. With audio renditions: one `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="…",LANGUAGE="…",DEFAULT=YES\|NO,AUTOSELECT=YES,CHANNELS="n",URI="audio/{id}/main.m3u8"` per offered track (exactly one `DEFAULT=YES`: the selected track; `LANGUAGE` is BCP-47 and omitted when unknown), the variant carries `AUDIO="audio"`, `CODECS` lists the video codec and every rendition codec, `BANDWIDTH` includes the largest rendition. |
| `main.m3u8` | Complete VOD playlist (fMP4, `#EXT-X-MAP`, `#EXT-X-ENDLIST`): a fixed grid for transcodes, keyframe-aligned real durations for remuxes. |
| `subtitles/{streamIndex}/main.m3u8` · `…/{n}.vtt` | WebVTT rendition of a remux or transcode, aligned with the video segments (`text/vtt`, `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000`, cue times on the media timeline). A segment no live run covers starts ffmpeg there and waits for its cues, like a video segment; a transcode is never restarted backwards for subtitles (a segment behind its encoder returns the cues known so far). `404` for streams that are not delivered. |
| `init.mp4` | Initialization segment; identical across ffmpeg restarts. Video only when the master has audio renditions. |
| `{n}.m4s` | Segment `n`; waits while ffmpeg produces it, restarts ffmpeg for a far seek and for a seek back to a segment the run already wrote but segment retention deleted (it would never be written again). Video only when the master has audio renditions. |
| `audio/{id}/main.m3u8` · `…/init.mp4` · `…/{n}.m4s` | Audio rendition `id` (the source stream index): the same timeline, segment count and `EXTINF` durations as `main.m3u8`; segment `n` covers the same time range as video segment `n` (both are cut from the same fragment, so they are aligned by construction). One audio track per init. Fetching an audio segment drives ffmpeg exactly like the video segment of the same index (same errors). `404 unknown_audio_rendition` for an id the session does not offer; `500 rendition_split_failed` when the muxed fragment cannot be split (a malformed or truncated fragment; logged; never happens with ffmpeg's own output). Each audio track carries its ISO 639-2 language in the fMP4. |

`init.mp4`, `{n}.m4s` and `{n}.vtt` can start ffmpeg, so they share these errors: `404 unknown_transcode` /
`unknown_segment` / `end_of_stream`, `410 session_closed`, `500 transcode_failed`,
`503 transcode_capacity` / `remux_capacity` / `init_unavailable` / `segment_unavailable`,
`504 segment_timeout`. One request waits at most `Streamarr:Transcoding:SegmentWaitTimeoutSeconds` (default 25 s,
below the players' fragment timeouts) in total, across ffmpeg restarts, then answers `504 segment_timeout`. A
segment deleted between the wait and the read answers `503 segment_evicted`. Of two requests competing for
far-apart positions of one session the newer position wins; the other waits (no restart back) while the newer one was
used in the last 3 s, so it gets its segment or `504 segment_timeout` instead of a restart storm (see transcoding.md).
Every `503` and `504` carries
`Retry-After: 1` (retry the same URL). Every fetch of a playlist or segment counts
as activity of the session (and of the viewer playback that owns it, § 13).
| `DELETE` on the capability root | Ends the session and its ffmpeg process (`204`). |

### Admin endpoints

| Endpoint | Purpose |
|---|---|
| `GET/PUT /api/v1/transcoding/config` | Settings (`PUT` is a partial update; `hardwareDecodingAuto: true` follows the self-tests; `maxConcurrentRemuxes` 1–64 is the separate remux pool). |
| `GET /api/v1/transcoding/capabilities` · `POST …/refresh` | ffmpeg version, encoders, filters, platform, and per-backend self-test results with setup notes. `detecting` is true while a detection runs. |
| `GET /api/v1/transcoding/samples` · `POST …/samples/{id}/generate` | Synthetic test media and its generation state. |
| `GET/POST /api/v1/transcoding/benchmarks` · `GET …/{id}` | Queue a benchmark (`sampleId`, `maxHeight`, `bitrateKbps`, optional `acceleration` override) and read its graded result. |
| `GET /api/v1/transcoding/sessions` · `DELETE …/{handle}` | Live sessions with `mode` (`remux`/`transcode`), plan, ffmpeg job state, redacted command and log tail; stop by public handle. |

## 12. Viewer accounts and watch state

An optional, separately authenticated module ([`viewers.md`](./viewers.md)); its catalog and
playback are § 13. While it is disabled (the default), every `/api/v1/viewer/*` endpoint answers
`404 module_disabled`.
Viewer credentials never unlock admin or machine endpoints, and admin/machine credentials
never unlock viewer endpoints.

### Viewer authentication — `/api/v1/viewer/auth`

| Endpoint | Purpose |
|---|---|
| `GET …/options` | Anonymous. Which sign-in methods the server offers (`emailCodeLogin`, `passwordReset`, `twoFactor`, `passwordMinLength`). |
| `POST …/login` | `{ login, password, deviceName, clientName, useCookies }` → `ViewerAuthResponse`. |
| `POST …/login/second-factor` | `{ mfaToken, code }` with a 6-digit authenticator code or a recovery code. |
| `POST …/email-code` · `POST …/email-code/verify` | Request (always `202`) and redeem an emailed sign-in code. |
| `POST …/password/forgot` · `POST …/password/reset` | Request (always `202`) and redeem a reset code with a new password (`204`, ends all sessions). |
| `POST …/refresh` | `{ refreshToken }` or the refresh cookie → rotated tokens. The previous refresh token is answered with the same rotated pair within 30 s and later while that pair is unused (a fresh access token if its own expired); after the pair was used, the previous or any older token gets `401 refresh_token_reused` and ends the session (see viewers.md). Other refusals say which case they are (below). |
| `POST …/logout` | Ends the current session (bearer, refresh token, or cookies). |

```json
// ViewerAuthResponse
{ "status": "authenticated",            // or "mfa_required" with mfaToken + mfaExpiresAt
  "session": { "sessionId": "…", "tokenType": "Bearer",
               "accessToken": "sva_…", "accessExpiresAt": "…",
               "refreshToken": "svr_…", "refreshExpiresAt": "…", "cookieMode": false },
  "viewer": { "accountType": "viewer", "id": "…", "username": "anna", "displayName": "Anna",
              "mustChangePassword": false, "twoFactorEnabled": true,
              "permissions": { "maxAge": 12, "blockUnrated": true, "allowTranscoding": true, "maxConcurrentStreams": null } } }
```

Errors: `401 invalid_credentials`, `401 invalid_code`, `401 mfa_expired`,
`403 account_disabled`, `423 account_locked`, `403 email_login_unavailable` /
`password_reset_unavailable`, `429 rate_limited`, `429 email_code_cooldown`.

**Refresh failures.** `POST …/refresh` answers every refusal with `401` and one of these codes (cookies are cleared):

| Code | When |
|---|---|
| `refresh_token_reused` | A previous or older token of a live session was presented after the rotated pair was used; this request ended the session (theft detection). |
| `refresh_session_expired` | The session exists (or existed) and its refresh window is over. Nothing was revoked. |
| `refresh_session_revoked` | The session was ended on purpose; `params.reason` says why (below). |
| `refresh_token_unknown` | No session and no tombstone matches: malformed, never issued by this server, deleted more than 30 days ago, or a device restored from an old backup/snapshot. No `params`. |

`params.reason` of `refresh_session_revoked` (clients treat an unlisted value like `other`):
`signed_out` (this device signed out), `revoked_by_viewer` (removed or "sign out other devices" on another device),
`session_limit` (the least recently used device was signed out by a new sign-in beyond the per-viewer limit, default 20),
`admin` (an admin revoked the session, reset the password or the second factor, or deleted the account),
`password_changed` (password changed on another device or reset by e-mail code), `account_disabled`,
`token_reused` (the session had been ended by refresh-token reuse), `other`.

```json
// 401
{ "error": { "code": "refresh_session_revoked", "message": "The viewer session was ended. Sign in again.",
             "params": { "reason": "session_limit" } } }
```

Revoked sessions stay in the session table for a day, expired ones until the next cleanup; when they are deleted every refresh-token hash they knew (current, previous, the last 8 retired) is kept as a
tombstone with the session id, viewer id, reason and time for 30 days after the session ended, so an old token still
maps to its reason. A cleanup job runs hourly (and on every sign-in) and drops older tombstones. Lookups go by the
SHA-256 hash of the presented token only; a caller without a token that was once valid learns nothing about any
account. Every refusal is logged at Information as `Viewer refresh refused: <case> (<detail>), reason …, session …,
viewer …` (ids only when a session or tombstone matched; never the token or its hash). Unknown-token refusals are
logged one by one for the first 5 per minute; the rest of that minute is counted and reported in one line with the next
refusal, so an anonymous flood cannot fill the log feed. Account deletion writes its tombstones under the same lock as
refresh, so a refresh racing the deletion answers `refresh_session_revoked` (`admin`), never `unknown`; a previous-token
replay of a disabled account answers `refresh_session_revoked` (`account_disabled`).

**Refresh rate limit.** `POST …/refresh` counts one-minute windows per client IP
(`Streamarr:ViewerRefreshPerIpPerMinute`, default 60) and per presented refresh token
(`Streamarr:ViewerRefreshPerTokenPerMinute`, default 10). Over either limit it answers `429 rate_limited` with
`Retry-After` (seconds until the window ends) before looking at the token. An app refreshes about once per access-token
lifetime (default 60 minutes) plus a retry or two, so a household behind one address stays far below it. Limiter lines
are logged at most 5 per minute (the rest counted), and the request log writes these 429s at Debug.

**E-mail code cooldown.** A new code for the same purpose is sent at most every 30 seconds and at most
5 times per hour. Inside that window `POST …/auth/email-code` and `POST …/me/email` send **no** mail and answer

```json
// 429, Retry-After: 27
{ "error": { "code": "email_code_cooldown", "message": "A code was sent moments ago; request a new one in 27 seconds.",
             "params": { "retryAfterSeconds": "27" }, "retryAfterSeconds": 27 } }
```

The app shows "wait N seconds" and keeps the code already sent valid. For the sign-in code the `429` comes only
from a cooldown kept per typed login (trimmed, case-insensitive) *before* the account lookup, so known and unknown
logins answer alike (`202`, then `429` on a repeat). The per-account mail limit (one code per 30 seconds, 5 per hour)
still holds across aliases, but silently: when the username was just used, the account's e-mail address (or the
other way round) answers `202` like a first send and no mail goes out, so the answers never reveal that two logins
belong to one account. The code already sent stays valid and works with either login. `POST …/password/forgot` stays generic: always `202`, a repeat inside the
cooldown sends no mail.

**Language of viewer e-mails.** Sign-in code, password reset and address verification mails are written in the
request's viewer language, resolved exactly like the metadata language (`Accept-Language`
within `Tmdb:ViewerLanguages`, else the server language `Tmdb:Language`). Templates exist in German and English;
every other language gets English. The admin test mail uses the server language.

### The signed-in viewer — `/api/v1/viewer/me`

`GET` / `PATCH` (profile), `POST …/password`, `POST …/email` +
`POST …/email/verify`, `POST …/two-factor/setup` · `…/enable` · `…/disable` ·
`…/recovery-codes`, `GET …/sessions`, `DELETE …/sessions/{id}`, `POST …/sessions/sign-out-others`. While an
admin-assigned password must be changed, other viewer endpoints answer `403 password_change_required`
(the session endpoints stay available).

**Profile (`PATCH /api/v1/viewer/me`).** A partial update; an omitted field stays unchanged. Answers the
`ViewerProfileResponse`.

| Field | Rule |
| --- | --- |
| `displayName` | Trimmed, 1–64 printable characters (no control characters), otherwise `400 invalid_display_name` — a name of only spaces too. `null` or `""` resets it to the username. Display names are **not unique** (the username is the unique handle). |
| `avatarKey` | One of `cyan`, `blue`, `teal`, `green`, `amber`, `coral`, `rose`, `slate` (case-insensitive; stored lower case), otherwise `400 invalid_avatar`. `null` = no choice, the client derives a default. The keys map in order to the client's avatar colour slots 1–8. |

```json
PATCH /api/v1/viewer/me   { "displayName": "Anna B.", "avatarKey": "coral" }
→ 200 { "accountType": "viewer", "id": "…", "username": "anna", "displayName": "Anna B.", "avatarKey": "coral", … }
```

`GET /api/v1/viewer/me` (and the `viewer` object of the sign-in answer) carries `avatarKey` (`null` when unset).

**Sign out all other devices (`POST /api/v1/viewer/me/sessions/sign-out-others`).** No body. Ends every other
active session of the signed-in viewer in one database statement (their access tokens answer `401` at once,
their refresh tokens are refused) and keeps the calling session signed in. Answers `200 { "signedOut": 2 }`, the
number of sessions ended (`0` when there were none). Replaces looping over `DELETE …/sessions/{id}`.

### Watch state — `/api/v1/viewer/watch`

| Endpoint | Purpose |
|---|---|
| `POST …/progress` | `{ event: start\|progress\|stop, workId, positionTicks, durationTicks, playbackId, releaseId?, streamToken?, title? }` → the updated `WatchStateResponse`. A `playbackId` from `/viewer/playback` (same device, same work) fills `releaseId` and `streamToken`, counts as that playback's heartbeat and `stop` ends it (§ 13); any other id is just the client's play id. With a `playbackId` the answer adds `playbackAlive` (`false`: no such live server playback) and, for a live one, `deliveryIssues` (§ 13). |
| `GET …/resume` · `DELETE …/resume/{workId}` | Continue watching, and hiding an entry from it. Items carry `title` in the viewer's language (the movie title, the series title for episodes; the last reported `title` when TMDB has none, else `null`), plus `tint`, `tint2`, `highlight`, `spec` and `available`. A series appears with its current episode only (see *Current episode* below): a resume point older than the latest completion in its series is left out. |
| `GET …/next-up?seriesWorkId=` | `{ items, incomplete }` — the current episode per recently watched series (see below); items carry `available`. |
| `GET …/history?limit&offset` | `{ items, total }`, most recent first. |
| `POST …/state` | `{ workIds }` → one state per id (unknown ids come back unplayed). |
| `GET …/series/{seriesWorkId}` | Every recorded episode state of one series. |
| `POST …/played` · `POST …/unplayed` | `{ workIds }`; season and series ids expand to their aired episodes. |
| `GET /api/v1/viewer/access/{workId}` | Age gate: `{ allowed, reason, rating, minimumAge, viewerMaxAge }`. |

**Current episode of a series** (one rule for next up, continue watching and the series' `nextEpisode`,
so every surface — continue row, next-up row, hero, series page — names the same episode): the most
recently played episode with a resume point wins when its `lastPlayedAt` is newer than the latest
completion (`playedAt`) of any episode of that series — e.g. a replay of a watched episode (`reason:
resume`, `positionTicks` set, `lastWatchedWorkId` = that episode). Otherwise it is next up: the first
aired episode after the furthest played one that is not played without a resume point, in catalog
order. Episodes are never skipped for missing versions: **`available`** (next-up and continue items,
`nextEpisode`) is `false` when the last version lookup of that episode found no version that is not
known dead — show "not available yet" — and `true` when one exists or no lookup ran yet (the spec
warm-up then queues one, so a later fetch is truthful; opening the season with `availability=true`
records it immediately). `available` is `null` on other watch-state responses (history, state, series).

### Admin management — `/api/v1/config/viewers` (admin only)

| Endpoint | Purpose |
|---|---|
| `GET/PUT …/settings` | Module switch, session/security policy, self-service switches, watch thresholds, email delivery (`PUT` is partial; `email.smtpPassword` is write-only). |
| `POST …/settings/test-email` | Synchronous test message; `502 email_delivery_failed` carries the transport error. |
| `GET/DELETE …/outbox` | Messages captured in test-outbox mode. |
| `GET` · `POST` · `GET/PATCH/DELETE …/{id}` | List, create (an omitted password is generated and returned once), read, update (a `permissions` object replaces all permissions), delete. |
| `POST …/{id}/password` | Assign or generate a password; ends all sessions. |
| `POST …/{id}/two-factor/reset` | Remove a lost authenticator. |
| `GET/DELETE …/{id}/sessions` · `DELETE …/{id}/sessions/{sessionId}` | Devices and revocation. |
| `GET/DELETE …/{id}/watch-state` | Read or clear a viewer's watch state. |

---

## 13. Viewer catalog and playback

`/api/v1/viewer/catalog/*` is what a viewer app browses: TMDB search and home rows, title
details with the viewer's watch state, and the ranked **versions** of a movie or episode.
`/api/v1/viewer/playback` starts one of those versions on a device (see *Playback* below). Both
belong to the viewer module (§ 12) and behave like the other viewer endpoints:

- **Auth:** only viewer sessions (bearer `sva_…` or the viewer cookie). Admin JWTs, admin cookies,
  machine API keys and anonymous calls get `401 unauthorized`.
- **Module gate:** while the module is off, every catalog endpoint answers `404 module_disabled`.
- **Password change:** while an admin-assigned password must be changed, `403 password_change_required`.
- **Age policy:** lists (search, discover, browse) silently leave out titles the viewer may not watch.
  Details, seasons and versions of such a title answer `403 age_restricted` with `params`
  (`reason`: `above_age_limit`, `unrated_blocked` or `rating_unavailable`; plus `rating`,
  `minimumAge`, `viewerMaxAge` when known). For a restricted viewer, every list item needs its TMDB
  certification, so each item costs one cached TMDB detail lookup; unrestricted viewers cost none.
- **Errors:** the standard envelope (§ 2). `429 capacity_reached` and `503 …` carry `Retry-After: 1`.
  Malformed query values (e.g. `limit=abc`) answer `400 invalid_request` on every viewer endpoint.
- **Language:** every viewer endpoint honours `Accept-Language` (the highest-weighted primary tag the server
  allows, `Tmdb:ViewerLanguages`, e.g. `de` or `en`; a missing or unknown tag means the server default
  `Tmdb:Language`). Titles, overviews, taglines, season and episode names and genre names come from TMDB in
  that language; when TMDB has no translation of an overview or episode name, the English text is used. A
  `tagline` is only ever in the viewer's language: when TMDB has none in it, `tagline` is null (no English fallback).
  Artwork follows the same language: the `posterUrl` is the best rated poster in the viewer's language, else a
  textless one, else English; the `backdropUrl` prefers a textless backdrop (text sits over it), then the viewer's
  language, then English; the `logoUrl` is the viewer's language, then English, then textless. TMDB's default image
  is kept when it already belongs to the best available group. The Dev World shows a German poster for Big Buck
  Bunny (its textless poster, TMDB has no German one) and Sherlock (the German TMDB poster).
  TMDB caches are kept per language, and viewer responses carry `Vary: Accept-Language`. Indexer searches
  (versions) always use the server default language, so release matching does not depend on the viewer.
- **Artwork sizes:** next to every artwork URL of a list item or detail sits an additive size-class object
  `{ small, medium, large }` (never null when its URL is set): `posterSizes`, `backdropSizes` (cards, movie/series
  details), `posterSizes` on seasons, `stillSizes` (episodes, `watch.nextEpisode`, next up) and `seriesPosterSizes`
  (next up). Pick the smallest class whose width covers the rendered width in device pixels:

  | class | posters | backdrops, episode stills | typical use |
  |---|---|---|---|
  | `small` | `w185` (185 px) | `w300` (300 px) | cards and thumbnails at 1× |
  | `medium` | `w342` (342 px) | `w780` (780 px) | cards on 2×/3× screens, TV rows |
  | `large` | `w780` | `w1280` | detail and hero; same size as the plain URL field (default `Tmdb:PosterSize` / `BackdropSize`) |

  TMDB URLs (`…/t/p/{size}/{file}`) map to these TMDB size buckets; any other URL (e.g. a non-TMDB image) is the same
  URL in every class. The plain `posterUrl`/`backdropUrl`/`stillUrl` fields are unchanged. Measured on the Dev World
  Home rows (12 TMDB cards): poster 160 KB (`posterUrl`, w780) → 17 KB `small` / 43 KB `medium`; backdrop 145 KB
  (w1280) → 15 KB `small` / 67 KB `medium`.
- **Spec warm-up:** a card's `spec` may be null on the first fetch; discover, browse, continue watching and next up
  queue a background version lookup for such titles (bounded, see `Streamarr:SpecWarmup` in configuration.md), so a
  later fetch carries it. List requests never wait for an indexer search.
- **TMDB outages** are never shown as "not found" or "nothing there": when TMDB cannot be reached
  (and nothing is cached), search, browse, genres, details, seasons and versions answer `503 catalog_unavailable`.
  `discover` leaves out a row whose list failed and answers `503 catalog_unavailable` only when no
  row is left; for a restricted viewer, a list whose certification lookups failed and left nothing
  to show answers the same. The age gate of a restricted viewer (playback start and switch,
  `GET /viewer/access/{workId}`) also answers `503 catalog_unavailable` while the certification
  cannot be read; `rating_unavailable` then only means that TMDB does not know the title.

| Endpoint | Returns | External cost on a cache miss |
|---|---|---|
| `GET …/search?q&type=movie\|tv\|any&limit` | `{ items: CatalogItem[] }`, TMDB relevance order, `limit` 1–20 (default 20) | One TMDB search; **no indexer call** |
| `GET …/discover` | `{ rows: [{ id, kind, mediaType, items }] }` | TMDB trending/popular lists (cached `Tmdb:DiscoverCacheTtlHours`, default 6 h); **no indexer call** |
| `GET …/browse?type=movie\|series&genre&sort&page` | `{ mediaType, genre, sort, page, totalPages, hasMore, items: CatalogItem[] }` | One TMDB discover page (cached per type, genre, sort and page for `Tmdb:DiscoverCacheTtlHours`); **no indexer call** |
| `GET …/genres?type=movie\|series` | `{ mediaType, genres: [{ id, name }] }` | One TMDB genre list (cached `Tmdb:CacheTtlHours`, default 24 h); **no indexer call** |
| `GET …/movies/{tmdbId}` | Movie details + `watch` + `access` | One TMDB detail call (cached); **no indexer call** |
| `GET …/series/{tmdbId}` | Series details, season summaries, `watch` summary + `access` | TMDB series detail (+ up to a few season lists for the next episode); **no indexer call** |
| `GET …/series/{tmdbId}/seasons/{n}` | TMDB episodes with per-episode `watch` | One TMDB season call; **no indexer call** |
| `GET …/series/{tmdbId}/seasons/{n}?availability=true` | The same plus `versionCount` per episode and `availability` | One season-wide indexer fan-out, shared with the episode versions cache |
| `GET …/works/{workId}/versions` | `{ workId, mediaType, versions: VersionDto[], checkedAt, fromCache, incomplete }` | One indexer fan-out (movie) or one season fan-out (episode) |

**Items and rows.** A `CatalogItem` is a card: `workId` (`tmdb-movie-603` or `tmdb-tv-1396`),
`mediaType` (`movie` or `series`), `tmdbId`, `title`, `originalTitle`, `year`, `overview`,
`posterUrl`, `backdropUrl` (+ `posterSizes`, `backdropSizes`), `voteAverage`, `tint`, `tint2` and `spec`. `search` accepts `type=movie`, `tv` (alias `series`)
or `any`. `discover` rows are `trending-movies`, `trending-series`, `popular-movies`,
`popular-series` (in that order; a row without any title the viewer may watch is left out).
Rows are TMDB data only: a title in a row may have no versions.

**Browse (Movies and Series pages).** `browse` pages TMDB discover (`discover/movie`, `discover/tv`)
for one `type` (`movie` or `series`, alias `tv`; required), optionally one TMDB `genre` id (from
`genres`), `sort` `popular` (default), `top_rated` (vote average, with a vote floor) or `newest`
(release / first air date up to today), and a 1-based `page` (1–500, TMDB's limit). Items are
`CatalogItem`s in TMDB order, including `tint`, `tint2` and `spec`. `totalPages` is TMDB's count and
`hasMore` says whether a later page exists; the age policy may leave a page with fewer items or
none, so page on `hasMore`, not on the item count. `genres` lists TMDB's genres for one `type`
(names in the server's TMDB language). Invalid values answer `400 invalid_query` (missing or
unknown `type`, `genre` ≤ 0, unknown `sort`, `page` outside 1–500); non-numeric `genre`/`page`
answer `400 invalid_request`.

**Palette (`tint`, `tint2`).** Two `#RRGGBB` colours extracted from the title artwork (backdrop,
poster when the backdrop has none): `tint` is the vivid accent, adjusted to at least 3:1 contrast
against `#0A0C12`; `tint2` is a deep shade on which white text reaches 4.5:1. They are computed in
the background the first time a title is listed (only for images on the TMDB image host), cached
per image URL in the database, and `null` until then — a later request carries them. They appear
on catalog items, movie and series details, season responses (the series palette; episodes
inherit it), and on the continue-watching (`/viewer/watch/resume`) and next-up items.

**Art highlight (`highlight`).** Next to `tint`/`tint2` on every response that carries them: the
`#RRGGBB` colour of the bright parts of the same artwork (backdrop, poster when there is none),
measured as the 95th luminance percentile of a 64 px wide thumbnail — robust against a few white
pixels, conservative because it covers the whole image (not a region). `null` when unknown (not yet
computed, no artwork, a non-TMDB image host, or a palette from before this field that is being
recomputed — its `tint`/`tint2` stay served meanwhile). Use it to size a glass surface per title:
treat `highlight` as the brightest art behind the glass, composite the glass colour at alpha `a`
over it and pick the smallest `a` for which body text keeps **4.5:1** and large text (≥ 24 px
regular or ≥ 18.66 px bold at the 1920 design scale) keeps **3:1** against that composite. With
`highlight` `null`, fall back to the per-style rule over white (the brightest possible art).

**Spec summary (`spec`).** On list items (catalog items, season episodes, continue watching, next
up): `{ resolution, hdr, videoCodec, audio }` display labels of the best version by quality
(`qualityRank` 1, dead releases skipped) — e.g. `{ "resolution": "4K", "hdr": "DV", "videoCodec":
"HEVC", "audio": "Atmos" }`. `resolution` is `8K`/`4K`/`1080p`/`720p`/…/`SD`; `hdr` `DV`, `HDR10+`,
`HDR10`, `HLG` or `null`; `videoCodec` `AV1`, `HEVC`, `H.264`, …; `audio` `Atmos`, the channel
layout (`7.1`, `5.1`, `2.0`) or else the codec. It is device-independent and comes from the last
version lookup of that work (a versions request, a season `availability=true` or a playback) —
lists never search the indexers, so `spec` is `null` for titles nobody has looked up yet. A series
item shows the best of its seasons.

**Details.** `movies/{id}`: `title`, `originalTitle`, `year`, `overview`, `tagline`, `genres`,
`runtimeMinutes`, `certification` (the value the age gate uses), `voteAverage`, `posterUrl`,
`backdropUrl`, `logoUrl` (transparent title logo when TMDB has one), `trailerUrl`, `people`, the
viewer's `watch` state (a `WatchStateResponse`, empty when never played) and `access`
(`{ allowed, reason, rating, minimumAge, viewerMaxAge }`). `series/{id}` adds `seasonCount`,
`episodeCount` (regular seasons), `seasons[]` (`workId`, `seasonNumber` — 0 = specials —, `title`,
`airDate`, `posterUrl`, `episodeCount`, `playedCount`, `inProgressCount`) and `watch`:

```json
{ "playedEpisodes": 1, "inProgressEpisodes": 1, "totalEpisodes": 5, "incomplete": false,
  "nextEpisode": { "workId": "tmdb-tv-600-s01e02", "seasonNumber": 1, "episodeNumber": 2,
                   "title": "Episode 2", "runtimeMinutes": 46, "positionTicks": 9000000000,
                   "durationTicks": 27600000000, "reason": "resume", "available": true } }
```

`nextEpisode` follows the *current episode* rule of the watch API: `reason` is `resume` (an
active resume point — newer than the latest completion in the series — or the next-up episode has
a resume position), `next` (the first aired, unplayed episode after the furthest played one — the
same episode as `/viewer/watch/next-up`) or `start` (nothing watched yet: the first aired episode
of the first regular season). It is `null` once everything aired is played. `available` is `false`
when the last version lookup found no playable version for it (see above).
Season episodes carry `workId`, `episodeNumber`, `title`, `overview`, `airDate`, `aired`,
`runtimeMinutes`, `stillUrl`, `voteAverage`, `watch` and `versionCount` (only with
`availability=true`). `availability` is `{ checkedAt, fromCache, incomplete, error }`; when the
season search cannot run (`capacity_reached`, `search_temporarily_unavailable`) the episodes still
come back, `versionCount` stays `null` and `error` names the reason.

**Versions.** `workId` must be a TMDB movie or episode id (`400 invalid_work_id` otherwise; unknown
episodes are `404 episode_not_found`). Versions are the releases the server would play, best
first: rejected releases and releases the health cache currently knows as dead are left out. The
ranking is the normal search ranking (default quality profile); episodes include season packs.

```json
{ "releaseId": "…", "name": "Movie.2021.2160p.UHD.BluRay.TrueHD.Atmos.7.1.DV.HDR10.x265-GRP",
  "rank": 1, "qualityRank": 1, "recommended": true, "resolution": "2160p", "source": "BluRay",
  "videoCodec": "hevc", "bitDepth": 10, "hdr": "dolbyvision", "hdrFormats": ["dolbyvision", "hdr10"],
  "audioCodec": "truehd", "audioChannels": "7.1", "atmos": true, "languages": [], "multiLanguage": false,
  "subtitleHints": [], "subtitleLanguages": [], "edition": null, "releaseGroup": "GRP",
  "proper": false, "repack": false, "seasonPack": false, "sizeBytes": 40000000000,
  "estimatedBitrateKbps": 44444, "ageDays": 3, "health": "unknown", "local": null,
  "predictedMethod": null, "predictionReasons": null }
```

- Every attribute comes from the parsed release name. Codes are lower-case and stable:
  `videoCodec` `h264|hevc|av1|vc1|mpeg2|xvid|divx`; `hdr`/`hdrFormats`
  `dolbyvision|hdr10plus|hdr10|hlg` (`null` = SDR or not stated); `audioCodec`
  `truehd|dts-hd-ma|dts-hd|dts-x|dts-es|dts|eac3|ac3|flac|opus|aac|mp3|pcm`. `bitDepth` is the
  stated depth (`10bit`, `Hi10P`, `Main10` …) or 10 when the name names an HDR format.
  `subtitleHints` (`subbed`, `multi`, `hardcoded`) and `subtitleLanguages` only reflect what the
  name says; empty means unknown.
- `rank` 1 is `recommended`: the version the server picks when the client does not choose. Without a device
  profile `rank` is the quality order. With one (`videoCodecs=…`, optional `vlcAvailable=true`) the list is
  ordered for the device: versions that play without a server transcode first (highest resolution first,
  then direct > remux > VLC, then quality), then transcodes, versions the device cannot play last and never
  `recommended`. `qualityRank` is always the device-independent quality order (1 = best).
- `estimatedBitrateKbps` = size ÷ TMDB runtime (per episode for season packs; `null` without a runtime).
- `health`: `unknown` until a resolve checked it, then `ready` or `degraded` (current health cache).
- `local`: `ready` or `downloading` when a pre-download of this version exists for this viewer
  (sessions resolved with client `streamarr-viewer` and the viewer id as requester).
- Never included: NZB URLs, indexer names or ids, API keys, scores, grabs.
- **Caching:** lists are cached per movie and per season for `Streamarr:ViewerVersionsCacheSeconds`
  (default 600); concurrent requests share one search; `fromCache` says whether this request
  reused it and `checkedAt` when it was searched. `?refresh=true` searches again, unless a search
  for the list is running or the cached list is younger than 60 seconds: then that list is returned
  (`fromCache: true`), so a looping client cannot fan out to the indexers (the indexer's own
  60-second response cache still applies). Lists with a failed indexer are marked `incomplete` and
  not cached; when every indexer fails the endpoint answers `503 search_temporarily_unavailable`,
  and `429 capacity_reached` when the server-wide search capacity is in use.

**Predicted method (optional).** Sending a compact device profile adds a prediction per version:
`videoCodecs` (required to enable it), `audioCodecs`, `containers`, `hdrFormats` (comma-separated,
the codec/container names of `/transcoding` `client`), `supports10Bit`, `maxAudioChannels`,
`maxHeight`, `maxBitrateKbps`, `vlcAvailable` (the app bundles VLC: versions only VLC plays directly are
predicted as `vlc` and count as playing without a transcode). Missing lists use the transcoding defaults
(`aac,mp3`, `mp4`, 2 channels). The profile also orders the list for the device (see `rank` above).
A profile with `hdrFormats` implies `supports10Bit=true` (HDR is always 10-bit) unless
`supports10Bit=false` is sent.

```
GET …/works/tmdb-movie-603/versions?videoCodecs=h264,hevc&audioCodecs=aac,ac3,eac3&containers=mp4&hdrFormats=hdr10&supports10Bit=true&maxAudioChannels=6
```

**VLC engine caps (optional, with `vlcAvailable=true`).** Without them the server assumes libVLC's defaults
(every common codec, any resolution, 10-bit, HDR10/HLG tone-mapped). A client whose VLC is limited narrows it:

| Parameter | Meaning |
| --- | --- |
| `vlcVideoCodecs` | Comma-separated codecs VLC decodes; an entry may carry its own height limit, `codec:maxHeight` (e.g. `h264,hevc:1080`). Codecs not listed are not played by VLC. Names libVLC does not know (after aliases such as `avc`, `h265`, `av01`) answer `400 invalid_device_profile`. Known: `h264`, `hevc`, `av1`, `vp9`, `vp8`, `mpeg2video`, `mpeg4`, `vc1`. |
| `vlcMaxHeight` | Height limit (144–4320) for listed codecs without their own limit. |
| `vlcHdrFormats` | HDR formats VLC shows natively (`hdr10`, `hlg`, `dv` or `dolbyvision`); default `hdr10,hlg` for HEVC/AV1/VP9 when the parameter is absent. `none` or an explicitly empty value (`vlcHdrFormats=`) means VLC renders no HDR format: with `vlcHdrToneMapping=false` an HDR file (e.g. HEVC HDR10 at 1080p) is then predicted `transcode`, not `vlc`, matching the playback decision. `none` combined with formats answers `400 invalid_device_profile`. |
| `vlcSupports10Bit` | `false` = 8-bit decoding only (no HDR either). |
| `vlcHdrToneMapping` | `false` = VLC does not tone-map HDR10/HLG to SDR (default `true`). |

The caps change the `vlc` prediction and the device order, so `recommended` stays on a version that really plays.
Out-of-range values answer `400 invalid_device_profile`.

```
GET …/works/tmdb-movie-603/versions?videoCodecs=h264&audioCodecs=aac&containers=mp4&vlcAvailable=true&vlcVideoCodecs=h264,hevc:1080&vlcSupports10Bit=true
```

`predictedMethod` is `direct`, `remux`, `vlc`, `transcode`, `unknown` or `unplayable` (best first; `vlc` = the
device's VLC engine plays the original file because no native path works, only when the query declares VLC). It is
**only a prediction**: the
server runs the transcoding planner (§ 11) on a source made up from the release name, because
nothing has been downloaded yet. `predictionReasons` lists the planner's reason codes (with
`params`) plus every assumption: `container_assumed` (names rarely say MKV or MP4; MKV is assumed
unless the name says MP4; once the server has opened the release — a playback probe or a live
stream session — its real container is used and the note disappears), `audio_codec_unknown`, `resolution_assumed`, `bit_depth_assumed`,
`dolby_vision_profile_unknown` (a Dolby Vision name without an HDR10/HLG base layer),
`video_codec_unknown` (→ `unknown`), and `transcoding_not_allowed` / `transcoding_disabled` when the
viewer or server could not do what the prediction needs. The real decision (with the probed file)
happens when playback starts (see *Playback* below). A `vlc` prediction lists the VLC candidate's own reasons —
`vlc_fallback`, `image_subtitle_vlc`, `hdr_tone_mapped` (`params.engine` = `vlc`) or `direct_play` — not the
conversions the native engine would have needed.

### Playback — `/api/v1/viewer/playback`

Starting playback is asynchronous. The server resolves the version (Usenet health check, automatic
fallback to the next healthy version, PAR2 repair when nothing else is left), probes the file,
decides how *this device* plays it, starts a remux or transcode when one is needed, and reports
`ready` with a URL. The client polls the state and shows every step. The same auth, module,
password-change and age rules as the catalog apply.

| Endpoint | Returns |
|---|---|
| `POST …/playback` | `PlaybackStartRequest` → `202 PlaybackResponse` (`Location: …/playback/{playbackId}`) |
| `GET …/playback/{playbackId}?waitMs=` | The current `PlaybackResponse`; poll again after `pollAfterMs` (0 once `ready`/`failed`). With `waitMs` (1–10000) the request is a **long-poll**: it answers as soon as the state changes (or right away when it is already `ready`/`failed`), at the latest after `waitMs` |
| `POST …/playback/{playbackId}/switch` | `PlaybackSwitchRequest` → `202 PlaybackResponse` with `revision` + 1 |
| `POST …/playback/{playbackId}/stop` | `204`; ends the playback's remux/transcode sessions and frees its stream slot |

State responses carry `Cache-Control: private, no-store`.

```json
// PlaybackStartRequest
{ "workId": "tmdb-movie-10378",
  "releaseId": "…",                 // optional: a version from …/versions; omitted = the version recommended for this device
  "startPositionTicks": 0,           // optional; the answer's resumePositionTicks is the saved position
  "audioStreamIndex": 1,             // optional source stream index; omitted = from preferences.audioLanguage
  "subtitleStreamIndex": -1,         // optional; -1 = none; omitted = from subtitleMode + subtitleLanguage
  "device": {
    "platform": "androidtv",         // ios | ipados | tvos | android | androidtv | web
    "vlcAvailable": true,
    "maxBitrateKbps": null,          // optional bandwidth cap of the connection
    "engines": [                     // 1–4, the device's own order; native/web first, vlc when bundled
      { "engine": "native", "hls": true, "maxAudioChannels": 6,
        "containers": ["mp4", "mkv", "webm"],
        "videoCodecs": [ { "codec": "h264", "maxHeight": 2160 },
                         { "codec": "hevc", "maxBitDepth": 10, "hdrFormats": ["hdr10", "hlg"] } ],
        "audioCodecs": [ { "codec": "aac", "maxChannels": 6 }, { "codec": "eac3", "passthrough": true },
                         { "codec": "dts", "passthrough": true } ],
        "subtitleFormats": ["srt", "ass", "webvtt", "pgs"],
        "hdrToneMapping": false } ] },  // true: the engine tone-maps HDR10/HLG to SDR itself
  "preferences": { "engine": "auto",  // auto | native (never VLC) | vlc
                   "maxHeight": null, "maxBitrateKbps": null,
                   "audioLanguage": "de", "subtitleLanguage": "en",
                   "subtitleMode": "forced" } }   // off | forced (default) | always
```

Device profile rules: codec and container names are ffprobe's (`h264`, `hevc`, `av1`, `vp9`,
`mpeg2video`, `aac`, `ac3`, `eac3`, `truehd`, `dts`, `opus`, `flac`; `mkv`, `mp4`, `webm`, `ts`,
`mpeg`), common aliases are accepted (`avc`, `h265`, `hvc1`, `ec-3`, `dca`, `matroska`, `mov`,
`subrip`, `pgssub`, `dvdsub` …). `maxBitDepth` defaults to 8 for H.264 and 10 for HEVC/AV1/VP9;
`hdrFormats` (`hdr10`, `hlg`, `dolbyvision`) are per codec. `maxChannels` of an audio codec only
limits direct play (decoders downmix; a remux converts within `maxAudioChannels`); `passthrough`
codecs have no channel limit. `subtitleFormats` omitted means "not declared": direct play assumes
the engine renders a selected text subtitle, while image subtitles count as not renderable.
`hls: true` is needed for a remux or transcode. With `vlcAvailable` and no
`vlc` engine entry, libVLC's usual codecs (with `hdrToneMapping`) are assumed. `hdrToneMapping: true`
declares that the engine tone-maps HDR10 and HLG to the display itself (VLC, browsers): a 10-bit
HDR10/HLG source then plays direct or remuxed on it (`hdr_tone_mapped`) instead of being transcoded
to SDR. The order of `engines` does not matter: the server always ranks the native/web engine before
VLC (PLAN § 2) and uses only the first `native` or `web` entry.

**States.** `queued → resolving → (fallback) → (repairing) → planning → starting → ready | failed`.

| State | Meaning |
|---|---|
| `queued` | Waiting for a resolve slot (`Streamarr:MaxConcurrentResolves`); retried for up to 60 s, then `failed` `capacity_reached`. |
| `resolving` | Health check of the requested version (`attempts[0]` is `resolving`). |
| `fallback` | The requested version is dead; the next healthy version is being checked. `fallbackFrom` names the requested one, `attempts[]` lists every hop with `resolving`, `ready`, `degraded` or `dead`. |
| `repairing` | No healthy version is left and a PAR2 repair job is running: `repair` has `state`, `phase`, `progressPercent`, `etaSeconds`; `pollAfterMs` follows the job's `retryAfterSeconds`. When the job is ready the repaired copy plays. |
| `planning` | Probing the file and deciding method and engine; `version` (a `VersionDto`, `rank: 0` when not in the cached ranking) is known. |
| `starting` | Starting the remux or transcode; bounded at 60 s per revision, then `failed` with `start_timeout`. A switch or stop cancels the old revision's start: it never registers a session or takes a remux/transcode slot (a start that already registered is closed at once). |
| `ready` | Play `url` with `engine`. |
| `failed` | `error` + `suggestedActions`; `decision.skipped` explains a decision failure. |

**Ready.**

```json
{ "playbackId": "…", "revision": 0, "state": "ready", "workId": "tmdb-movie-10378",
  "attempts": [ { "releaseId": "…", "name": "…", "status": "ready" } ], "fallbackFrom": null,
  "version": { /* VersionDto */ }, "startPositionTicks": 0, "resumePositionTicks": 1200000000,
  "method": "remux", "engine": "native",
  "url": "/api/v1/transcode/3f…/master.m3u8", "streamToken": "…",
  "mediaInfo": {
    "container": "mkv", "durationTicks": 3000000000, "bitrateKbps": 4200,
    "video": { "index": 0, "codec": "hevc", "profile": "Main 10", "bitDepth": 10, "width": 1920,
               "height": 1080, "fps": 24.0, "hdr": "hdr10", "videoRange": "PQ",
               "deliveredCodec": "hevc", "deliveredHeight": 1080 },
    "audioTracks": [ { "index": 1, "codec": "truehd", "channels": 8, "language": "en", "title": null,
                       "default": true, "selected": true, "deliveredAs": "converted",
                       "deliveredCodec": "ac3", "deliveredChannels": 6 } ],
    "subtitleTracks": [ { "index": 2, "codec": "subrip", "language": "de", "forced": false,
                          "default": false, "textBased": true, "selected": false, "deliveredAs": "webvtt" } ] },
  "decision": { "method": "remux", "engine": "native",
                "reasons": [ { "code": "container_unsupported", "message": "…", "params": { "container": "mkv" } } ],
                "skipped": [ { "method": "direct", "engine": "native", "reasons": [ … ] } ] } }
```

- **`url` is a capability path relative to the server origin**: `/api/v1/stream/{token}` (the
  original file, byte ranges) for `direct`, `/api/v1/transcode/{capability}/master.m3u8` (fMP4 HLS,
  § 11) for `remux` and `transcode`. Players need no auth header or cookie; the path itself is
  the credential, so treat it like a token (do not log or share it). `streamToken` is the stream
  capability of the resolved version.
- `audioTracks[].deliveredAs`: `original` (direct play: the engine switches tracks itself), `copy`,
  `converted` (`deliveredCodec`/`deliveredChannels`) or `none` (not in this rendition: switch).
  `audioTracks[].renditionId` names the HLS audio rendition carrying the track (null when it is not in the master).
- **Audio renditions (in-session audio switch).** For `remux` and `transcode` the server offers up to 4 audio
  tracks as HLS audio renditions of one group when the version has two or more audio tracks: the selected track
  (`DEFAULT=YES`), then the viewer's `audioLanguage`, the file's default track and the other languages in stream
  order, one track per language (a second track of a language the list already has, e.g. a commentary, is only
  offered when it is the selected one). Each rendition is copied when the engine decodes it (within
  `maxAudioChannels`), otherwise converted (remux: E-AC-3 → AC-3 → AAC stereo; transcode: AAC), exactly like the
  single track before. The response then carries

  ```json
  "inSessionAudioSwitch": true,
  "audioRenditions": [
    { "id": "1", "streamIndex": 1, "language": "de", "label": "Deutsch · AC3 5.1", "channels": 6, "codec": "ac3", "default": false },
    { "id": "2", "streamIndex": 2, "language": "en", "label": "English · AC3 2.0", "channels": 2, "codec": "ac3", "default": true } ]
  ```

  in master order; `label` is the rendition `NAME` (the language in its own name plus what is delivered after conversion, e.g.
  `Deutsch · AAC 2.0`; the client may build its own localised label from `language`/`codec`/`channels`),
  `language` its `LANGUAGE`, `channels`/`codec` what the player
  receives, `streamIndex` matches `mediaInfo.audioTracks[].index`. **Client rule:** when `inSessionAudioSwitch` is
  true and the wanted track has a `renditionId`, switch the audio track in the player (hls.js `audioTrack`,
  AVPlayer `AVMediaSelectionGroup` for audible media, ExoPlayer track selection) — same URL, no `/switch`, no
  restart; seek, heartbeats and stop are unaffected. Use `POST …/switch { audioStreamIndex }` (new revision and URL)
  when `inSessionAudioSwitch` is false (one muxed track, e.g. a single-audio version), when the track has no
  `renditionId` (beyond the 4 offered), or for direct play (`deliveredAs: original` switches in the engine itself).
  After a `/switch` the new revision offers renditions again, with the requested track as the default.
  `audioRenditions` is `[]` for direct play and muxed audio and absent until `ready`.
  `subtitleTracks[].deliveredAs`: `embedded` (direct play, the engine renders it), `webvtt` (HLS
  rendition of a remux or transcode), `burnedIn` (in the transcoded picture) or `none`. `selected`
  marks the tracks the server delivered as chosen at this `revision`; after a switch inside the
  engine (`original`, `embedded`, `webvtt`) the client tracks the current selection itself.
- `decision.reasons` are stable codes with `params` for localized texts: the planner's codes (§ 11:
  `direct_play`, `container_unsupported`, `video_codec_unsupported`, `audio_codec_unsupported`,
  `audio_copied`, `audio_converted`, `resolution_exceeds_limit`, `bitrate_exceeds_limit`,
  `hdr_unsupported`, `bit_depth_unsupported`, `dolby_vision_profile_unsupported`,
  `subtitle_format_unsupported`, `subtitle_burned_in`, `subtitle_not_deliverable` …) plus
  playback codes: `fallback_used`, `repaired_copy`, `repair_progressive`, `release_degraded`,
  `vlc_fallback`, `image_subtitle_vlc`, `vlc_unavailable`, `native_unavailable`, `bandwidth_limit`,
  `hdr_tone_mapped` (`params.hdr`, `engine`), `transcode_height_default` (`params.height`, `max`),
  `transcode_native_engine`, `probe_failed`, `audio_track_requested`, `audio_language`, `audio_language_unavailable`,
  `subtitle_track_requested`, `subtitle_forced`, `subtitle_default`, `subtitle_language`,
  `subtitle_language_unavailable`. `decision.skipped` lists every higher-ranked method that was not
  possible, with its reasons (additionally `step_down`, `hls_unsupported`, `transcoding_not_allowed`,
  `transcoding_disabled`, `ffmpeg_unavailable`, `video_size_unsupported`,
  `audio_channels_unsupported`, or the start error of a remux/transcode that could not start).

**Decision.** Candidates are tried in PLAN order, the first that works wins:

1. **Native direct play** of the original file (container, codecs, per-codec size/bit depth/HDR,
   audio channels, the selected subtitle, `maxHeight`/`maxBitrateKbps`).
2. **Native via server remux** (video copied into fMP4 HLS, audio copied or converted, text
   subtitles as WebVTT).
3. **VLC direct play**, only when `vlcAvailable` (and `engine` is not `native`).
4. **Full transcode** for the native engine, only when the viewer's `allowTranscoding` is on.

`preferences.engine: vlc` plays VLC direct; when that is not possible, a transcode plays in the
native engine (`transcode_native_engine`: plain H.264/AAC HLS, which the native player handles
best), and VLC only without a native engine. `native` never uses VLC.
`maxHeight`/`maxBitrateKbps` (and the device's bandwidth cap) below the source lead to a transcode.
A full transcode is scaled to at most **1080p** unless `preferences.maxHeight` asks for more
(`transcode_height_default`: a 4K encode rarely keeps up in real time). A lossless TrueHD/DTS-HD
track the device cannot pass through is converted (E-AC-3/AC-3/AAC) in a remux, because the remux
ranks before VLC; a viewer who wants it lossless picks `engine: vlc`.
An **image subtitle** (PGS, VobSub, DVB) the native engine cannot render is played with VLC when
available, else **burned into a transcode** (CPU overlay, `subtitle_burned_in`) when transcoding is
allowed, else the playback goes on without it and says so (`subtitle_not_deliverable`,
`params.mode`). Without `audioStreamIndex`, the first track in `audioLanguage` (preferring the
file's default) plays, else the default track (`audio_language_unavailable`). Without
`subtitleStreamIndex`: `off` → none; `forced` → a forced track in the audio language (or without a
language); `always` → a non-forced track in `subtitleLanguage` (`subtitle_language_unavailable` if
none), or the file's default. A remux or transcode that fails to start falls through to the next
candidate. When the server cannot read the file (`probe_failed`) and VLC is available, VLC plays it
directly.

**Failed.** `error: { code, message, params }` and `suggestedActions` (`retry`, `otherVersion`,
`lowerQuality`, `useVlc`):

| `error.code` | When |
|---|---|
| `release_dead` | The version (and every automatic fallback) is missing data and no repair helped; `params.releaseId`, `attempts`, `suggestedReleaseId` when another version exists. |
| `repair_failed` | The PAR2 repair failed (`params.state`, `params.reason`). |
| `no_versions` · `release_not_found` | No version exists / the `releaseId` is not a version of this work. |
| `transcoding_not_allowed` | Only a full transcode could play it and the profile may not transcode. |
| `transcoding_unavailable` | Only a remux or transcode could play it and the server cannot run ffmpeg (`params.reason`: `transcoding_disabled`, `ffmpeg_unavailable`). |
| `no_playable_method` · `no_more_methods` | No method of the device fits / every method was stepped down. |
| `unknown_audio_stream` · `unknown_subtitle_stream` | The requested index is not in this version. |
| `capacity_reached` · `transcode_capacity` · `remux_capacity` | Server busy; `retry`. A remux/transcode start that hit the session limit or a full disk says so in `params.reason` (`too_many_sessions`, `insufficient_disk`). |
| `start_timeout` | The remux/transcode start of this revision (all attempts together) took longer than 60 s, e.g. a stalled source or a starved server (`retry`, `lowerQuality`); a revision never stays in `starting` longer. |
| `transcode_failed` · `segment_timeout` | ffmpeg failed or did not produce the first segment in time (`lowerQuality`); `params.reason` carries the start code when it was more specific (`init_unavailable`, `segment_unavailable`, `end_of_stream`). |
| `probe_failed`, `stream_expired`, `no_playable_file`, `invalid_release`, `nzb_fetch_failed`, `nzb_host_not_allowed`, `usenet_unreachable` | As named. |
| `playback_failed` | Anything else; `params.reason` names the internal start code when there is one. |

A catalog problem while picking the version keeps its catalog code: `title_not_found`,
`season_not_found`, `episode_not_found` and `age_restricted` suggest nothing (no other version can
help), `catalog_unavailable`, `capacity_reached` and `search_temporarily_unavailable` suggest `retry`.
`useVlc` is only suggested while VLC has not already failed for this playback.

Apart from those, only the codes in this table reach `error.code`; a remux or transcode start error is mapped onto them
(`transcoding_disabled`, `ffmpeg_unavailable`, `no_local_listener` → `transcoding_unavailable`).

HTTP errors (standard envelope): `400 invalid_work_id` (movie and episode ids only),
`400 invalid_device_profile`, `400 invalid_playback_request` (also `waitMs` outside 0–10000),
`400 invalid_request`, `400 unknown_audio_stream` / `unknown_subtitle_stream` (switch),
`403 age_restricted` (with `params`, on start and on switch), `403 password_change_required`,
`404 playback_not_found`, `404 module_disabled`, `409 too_many_streams`, `429 too_many_playbacks`,
`503 catalog_unavailable` (restricted viewer while TMDB cannot be reached, start and switch).

**Switch.** `{ positionTicks?, releaseId?, audioStreamIndex?, subtitleStreamIndex? (-1 = off),
preferences?, stepDown?, audioFallback? }` re-plans the same `playbackId` at `positionTicks` (default: the last
reported position). Set preference fields replace the current ones. Another `releaseId` resolves
again (with fallback); otherwise the live stream is re-planned without a new health check.
`stepDown: true` excludes the method + engine the device is playing (the last `ready` one, even
when a later switch failed) and continues with the next one; `no_more_methods` when none is left.
`audioFallback: true` is for a device that plays the picture but cannot output the audio (codec error, no sound):
from then on every rendition converts the selected audio track to AAC stereo (direct play is skipped with
`audio_fallback`, a remux converts instead of copying, no audio group, so `inSessionAudioSwitch` is false; the
decision lists `audio_fallback`). It stays on for the playback (also across track and version switches) until a
switch sends `audioFallback: false`; the playback answer carries `audioFallback`.
A track index the playing version does not have is rejected right away with
`400 unknown_audio_stream` / `unknown_subtitle_stream`; the playback keeps its state and tracks.
The state restarts at `resolving` or `planning`; the previous URL keeps working until 30 s after
the new one is `ready`.

**Enforcement.**

- `allowTranscoding: false` blocks **full video transcodes only** (including burn-in and quality
  reductions). A remux, which copies the video and may convert the audio, stays allowed.
- `maxConcurrentStreams`: a playback counts while it is being prepared, and when `ready` while its
  last activity (ready, heartbeat, switch, or the player fetching its HLS playlists/segments) is
  younger than `Streamarr:ViewerPlaybackHeartbeatSeconds` (default 60). A playback whose switch
  failed keeps counting while the device still plays its previous rendition. At the limit a new playback on the **same device** replaces that device's older one;
  another device gets `409 too_many_streams` with `params` `limit`, `device` (the other device's
  name), `workId` and `releaseName` (when known). Failed and stopped playbacks do not count.
- Age gate: `403 age_restricted` before any work starts, and again on every switch.

**Lifetime and heartbeat.** A playback belongs to the viewer session (device) that created it:
other viewers and the same viewer's other devices get `404 playback_not_found`. Report progress
with `POST /viewer/watch/progress` and the `playbackId` (every ~10 s while playing): it fills
`releaseId`/`streamToken` of the watch event (pre-download and the shared event stream), keeps the
playback and its HLS session alive, and `event: stop` ends the playback like `…/stop`. The answer's `playbackAlive` (only when a `playbackId` was
sent) is `true` while that id is a live playback of this device for this work and `false` once it is gone (idle
expiry, stop, server restart, another work): the report is still saved, but the player should start a new playback
at its position instead of waiting for its HLS requests to fail. A `stop` event with a live id answers `true`: the
value describes the playback as the report found it, and that same call then ends it.

**Delivery issues.** Some players never say which request failed (AVPlayer reports a broken audio rendition as a
bare network error, segment errors without a URI). The server knows: every error answer of the playback's current
HLS session (`/api/v1/transcode/{capability}/…`) is recorded on the playback — main playlist, init and video
segments as `segment`, `audio/{id}/…` as `audioRendition` with `renditionId`, `subtitles/{index}/…` as
`subtitleRendition` with `subtitleStreamIndex` — with the error `code`, the HTTP `status` (500 when an answer broke
off after it started, e.g. `rendition_split_failed`) and `at`. Equal issues (kind, rendition, code, status) collapse
to the latest; at most 16 per playback, each kept 60 s, dropped with the playback and cleared by every switch.
The progress answer for a live `playbackId` carries `deliveryIssues`: the issues recorded since the previous
progress answer of that playback, at most 30 s old, oldest first (`[]` when none; `null` without a live
`playbackId`), so each issue is told once. `GET …/playback/{id}` always lists the last 30 s (not consumed), e.g.
`{ "kind": "audioRendition", "renditionId": "1", "code": "rendition_split_failed", "status": 500, "at": "…" }` →
offer the audio fallback (`/switch { audioFallback: true }`) or another audio track. Only the owning device sees
them; no token material is stored.

A playback without polls, heartbeats, switches or HLS fetches for `Streamarr:ViewerPlaybackIdleSeconds`
(default 600) is stopped. Playbacks live in memory and end with a server restart. Stop closes the
remux/transcode sessions, so their HLS URLs stop working; a `direct` URL (`/api/v1/stream/{token}`)
is the stream capability itself and keeps working until its normal TTL, so playing the same version
again soon skips the health check.

---

## See also

- [`architecture.md`](./architecture.md) — how these endpoints compose into the
  search → resolve → stream lifecycle and the M7 hardening layer.
- [`ranker-tuning.md`](./ranker-tuning.md) — the `parsed` fields, `scoreBreakdown`
  rules, and rejection `code` values that `/debug/search` exposes.
- [`setup.md`](./setup.md) — how to configure indexers/providers/profiles that these
  endpoints read.
- [`viewers.md`](./viewers.md) — viewer accounts, sign-in security, watch-state rules, the catalog and playback.
