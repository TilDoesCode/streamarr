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
browsable at `/swagger`.

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
  "audioStreamIndex": 1, "subtitleStreamIndex": 3, "startPositionSeconds": 0, "clientName": "my-tv-app",
  "client": { "videoCodecs": ["h264", "hevc"], "audioCodecs": ["aac", "ac3", "eac3"], "containers": ["mp4"],
              "maxAudioChannels": 6, "supportsHdr": true, "supports10Bit": true,
              "hdrFormats": ["hdr10", "hlg"], "subtitleFormats": ["srt", "webvtt"] } }
```

`mode` picks the delivery: `auto` (remux when the video can be copied for this client, else
transcode), `remux` (fail with `422 remux_not_possible` otherwise) or `transcode`. Sessions default to
`transcode` so existing callers are unchanged; `POST /transcoding/plan` defaults to `auto` and may also
answer `direct`. `hdrFormats` (`hdr10`, `hlg`, `dolbyvision`) overrides `supportsHdr`;
`subtitleFormats` declares what the player renders from the original file (direct-play check for
`subtitleStreamIndex`). Remuxes are described in [transcoding.md](./transcoding.md#remux-direct-stream).
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
`subtitle_not_deliverable` (`params`: `index`, `codec`, `mode`; an image stream in a remux, or any
selected stream in a transcode, which carries no subtitle renditions), `subtitle_burned_in` (only viewer
playback, § 13, burns an image subtitle into a transcode; these sessions do not). `deliveredAs` is `webvtt`
(remux rendition), `embedded` (direct play), `burnedIn` or `none`. `target` describes what the player receives: the
original streams for `direct` (`videoCopy`/`audioCopy` true, `encoder: none`), the copied video for a
remux (`encoder: copy`), the encoder output for a transcode.

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
| `master.m3u8` | One variant with `BANDWIDTH`, `AVERAGE-BANDWIDTH`, `CODECS`, `RESOLUTION`, `FRAME-RATE`, `VIDEO-RANGE` (`SDR` for transcodes; `PQ`/`HLG`/`SDR` for remuxes). Remuxes add one `#EXT-X-MEDIA:TYPE=SUBTITLES` per delivered text stream and `CLOSED-CAPTIONS=NONE`. |
| `main.m3u8` | Complete VOD playlist (fMP4, `#EXT-X-MAP`, `#EXT-X-ENDLIST`): a fixed grid for transcodes, keyframe-aligned real durations for remuxes. |
| `subtitles/{streamIndex}/main.m3u8` · `…/{n}.vtt` | Remux only: WebVTT rendition aligned with the video segments (`text/vtt`, `X-TIMESTAMP-MAP=MPEGTS:0,LOCAL:00:00:00.000`, cue times on the media timeline); a segment no live run covers starts the copy there and waits for its cues, like a video segment; `404` for streams that are not delivered. |
| `init.mp4` | Initialization segment; identical across ffmpeg restarts. |
| `{n}.m4s` | Segment `n`; waits while ffmpeg produces it, restarts ffmpeg for a far seek. `503`/`504` carry `Retry-After: 1`. |
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
| `POST …/refresh` | `{ refreshToken }` or the refresh cookie → rotated tokens. `401 refresh_token_reused` ends a replayed session. |
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
`password_reset_unavailable`, `429 rate_limited`.

### The signed-in viewer — `/api/v1/viewer/me`

`GET` / `PATCH` (display name), `POST …/password`, `POST …/email` +
`POST …/email/verify`, `POST …/two-factor/setup` · `…/enable` · `…/disable` ·
`…/recovery-codes`, `GET …/sessions`, `DELETE …/sessions/{id}`. While an admin-assigned
password must be changed, other viewer endpoints answer `403 password_change_required`.

### Watch state — `/api/v1/viewer/watch`

| Endpoint | Purpose |
|---|---|
| `POST …/progress` | `{ event: start\|progress\|stop, workId, positionTicks, durationTicks, playbackId, releaseId?, streamToken?, title? }` → the updated `WatchStateResponse`. A `playbackId` from `/viewer/playback` (same device, same work) fills `releaseId` and `streamToken`, counts as that playback's heartbeat and `stop` ends it (§ 13); any other id is just the client's play id. |
| `GET …/resume` · `DELETE …/resume/{workId}` | Continue watching, and hiding an entry from it. |
| `GET …/next-up?seriesWorkId=` | `{ items, incomplete }` — the next aired, unplayed episode per recently watched series. |
| `GET …/history?limit&offset` | `{ items, total }`, most recent first. |
| `POST …/state` | `{ workIds }` → one state per id (unknown ids come back unplayed). |
| `GET …/series/{seriesWorkId}` | Every recorded episode state of one series. |
| `POST …/played` · `POST …/unplayed` | `{ workIds }`; season and series ids expand to their aired episodes. |
| `GET /api/v1/viewer/access/{workId}` | Age gate: `{ allowed, reason, rating, minimumAge, viewerMaxAge }`. |

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
- **Age policy:** lists (search, discover) silently leave out titles the viewer may not watch.
  Details, seasons and versions of such a title answer `403 age_restricted` with `params`
  (`reason`: `above_age_limit`, `unrated_blocked` or `rating_unavailable`; plus `rating`,
  `minimumAge`, `viewerMaxAge` when known). For a restricted viewer, every list item needs its TMDB
  certification, so each item costs one cached TMDB detail lookup; unrestricted viewers cost none.
- **Errors:** the standard envelope (§ 2). `429 capacity_reached` and `503 …` carry `Retry-After: 1`.

| Endpoint | Returns | External cost on a cache miss |
|---|---|---|
| `GET …/search?q&type=movie\|tv\|any&limit` | `{ items: CatalogItem[] }`, TMDB relevance order, `limit` 1–20 (default 20) | One TMDB search; **no indexer call** |
| `GET …/discover` | `{ rows: [{ id, kind, mediaType, items }] }` | TMDB trending/popular lists (cached `Tmdb:DiscoverCacheTtlHours`, default 6 h); **no indexer call** |
| `GET …/movies/{tmdbId}` | Movie details + `watch` + `access` | One TMDB detail call (cached); **no indexer call** |
| `GET …/series/{tmdbId}` | Series details, season summaries, `watch` summary + `access` | TMDB series detail (+ up to a few season lists for the next episode); **no indexer call** |
| `GET …/series/{tmdbId}/seasons/{n}` | TMDB episodes with per-episode `watch` | One TMDB season call; **no indexer call** |
| `GET …/series/{tmdbId}/seasons/{n}?availability=true` | The same plus `versionCount` per episode and `availability` | One season-wide indexer fan-out, shared with the episode versions cache |
| `GET …/works/{workId}/versions` | `{ workId, mediaType, versions: VersionDto[], checkedAt, fromCache, incomplete }` | One indexer fan-out (movie) or one season fan-out (episode) |

**Items and rows.** A `CatalogItem` is a card: `workId` (`tmdb-movie-603` or `tmdb-tv-1396`),
`mediaType` (`movie` or `series`), `tmdbId`, `title`, `originalTitle`, `year`, `overview`,
`posterUrl`, `backdropUrl`, `voteAverage`. `search` accepts `type=movie`, `tv` (alias `series`)
or `any`. `discover` rows are `trending-movies`, `trending-series`, `popular-movies`,
`popular-series` (in that order; a row without any title the viewer may watch is left out).
Rows are TMDB data only: a title in a row may have no versions.

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
                   "durationTicks": 27600000000, "reason": "resume" } }
```

`nextEpisode.reason` is `next` (the first aired, unplayed episode after the furthest played one —
the same rule as `/viewer/watch/next-up`), `resume` (that episode or, failing that, the most
recently played episode has a resume position) or `start` (nothing watched yet: the first aired
episode of the first regular season). It is `null` once everything aired is played.
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
  "rank": 1, "recommended": true, "resolution": "2160p", "source": "BluRay",
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
- `rank` 1 is `recommended`: the version the server picks when the client does not choose.
- `estimatedBitrateKbps` = size ÷ TMDB runtime (per episode for season packs; `null` without a runtime).
- `health`: `unknown` until a resolve checked it, then `ready` or `degraded` (current health cache).
- `local`: `ready` or `downloading` when a pre-download of this version exists for this viewer
  (sessions resolved with client `streamarr-viewer` and the viewer id as requester).
- Never included: NZB URLs, indexer names or ids, API keys, scores, grabs.
- **Caching:** lists are cached per movie and per season for `Streamarr:ViewerVersionsCacheSeconds`
  (default 600); concurrent requests share one search; `fromCache` says whether this request
  reused it and `checkedAt` when it was searched. `?refresh=true` searches again (the indexer's own
  60-second response cache still applies). Lists with a failed indexer are marked `incomplete` and
  not cached; when every indexer fails the endpoint answers `503 search_temporarily_unavailable`,
  and `429 capacity_reached` when the server-wide search capacity is in use.

**Predicted method (optional).** Sending a compact device profile adds a prediction per version:
`videoCodecs` (required to enable it), `audioCodecs`, `containers`, `hdrFormats` (comma-separated,
the codec/container names of `/transcoding` `client`), `supports10Bit`, `maxAudioChannels`,
`maxHeight`, `maxBitrateKbps`. Missing lists use the transcoding defaults (`aac,mp3`, `mp4`, 2 channels).

```
GET …/works/tmdb-movie-603/versions?videoCodecs=h264,hevc&audioCodecs=aac,ac3,eac3&containers=mp4&hdrFormats=hdr10&supports10Bit=true&maxAudioChannels=6
```

`predictedMethod` is `direct`, `remux`, `transcode` or `unknown`. It is **only a prediction**: the
server runs the transcoding planner (§ 11) on a source made up from the release name, because
nothing has been downloaded yet. `predictionReasons` lists the planner's reason codes (with
`params`) plus every assumption: `container_assumed` (names rarely say MKV or MP4; MKV is assumed
unless the name says MP4), `audio_codec_unknown`, `resolution_assumed`, `bit_depth_assumed`,
`dolby_vision_profile_unknown` (a Dolby Vision name without an HDR10/HLG base layer),
`video_codec_unknown` (→ `unknown`), and `transcoding_not_allowed` / `transcoding_disabled` when the
viewer or server could not do what the prediction needs. The real decision (with the probed file)
happens when playback starts (see *Playback* below).

### Playback — `/api/v1/viewer/playback`

Starting playback is asynchronous. The server resolves the version (Usenet health check, automatic
fallback to the next healthy version, PAR2 repair when nothing else is left), probes the file,
decides how *this device* plays it, starts a remux or transcode when one is needed, and reports
`ready` with a URL. The client polls the state and shows every step. The same auth, module,
password-change and age rules as the catalog apply.

| Endpoint | Returns |
|---|---|
| `POST …/playback` | `PlaybackStartRequest` → `202 PlaybackResponse` (`Location: …/playback/{playbackId}`) |
| `GET …/playback/{playbackId}` | The current `PlaybackResponse`; poll again after `pollAfterMs` (0 once `ready`/`failed`) |
| `POST …/playback/{playbackId}/switch` | `PlaybackSwitchRequest` → `202 PlaybackResponse` with `revision` + 1 |
| `POST …/playback/{playbackId}/stop` | `204`; ends the playback's remux/transcode sessions and frees its stream slot |

State responses carry `Cache-Control: private, no-store`.

```json
// PlaybackStartRequest
{ "workId": "tmdb-movie-10378",
  "releaseId": "…",                 // optional: a version from …/versions; omitted = rank 1 (recommended)
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
        "subtitleFormats": ["srt", "ass", "webvtt", "pgs"] } ] },
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
`vlc` engine entry, libVLC's usual codecs are assumed.

**States.** `queued → resolving → (fallback) → (repairing) → planning → starting → ready | failed`.

| State | Meaning |
|---|---|
| `queued` | Waiting for a resolve slot (`Streamarr:MaxConcurrentResolves`); retried for up to 60 s, then `failed` `capacity_reached`. |
| `resolving` | Health check of the requested version (`attempts[0]` is `resolving`). |
| `fallback` | The requested version is dead; the next healthy version is being checked. `fallbackFrom` names the requested one, `attempts[]` lists every hop with `resolving`, `ready`, `degraded` or `dead`. |
| `repairing` | No healthy version is left and a PAR2 repair job is running: `repair` has `state`, `phase`, `progressPercent`, `etaSeconds`; `pollAfterMs` follows the job's `retryAfterSeconds`. When the job is ready the repaired copy plays. |
| `planning` | Probing the file and deciding method and engine; `version` (a `VersionDto`, `rank: 0` when not in the cached ranking) is known. |
| `starting` | Starting the remux or transcode. |
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
  `subtitleTracks[].deliveredAs`: `embedded` (direct play, the engine renders it), `webvtt` (remux
  rendition), `burnedIn` (in the transcoded picture) or `none`. `selected` marks the chosen tracks.
- `decision.reasons` are stable codes with `params` for localized texts: the planner's codes (§ 11:
  `direct_play`, `container_unsupported`, `video_codec_unsupported`, `audio_codec_unsupported`,
  `audio_copied`, `audio_converted`, `resolution_exceeds_limit`, `bitrate_exceeds_limit`,
  `hdr_unsupported`, `bit_depth_unsupported`, `dolby_vision_profile_unsupported`,
  `subtitle_format_unsupported`, `subtitle_burned_in`, `subtitle_not_deliverable` …) plus
  playback codes: `fallback_used`, `repaired_copy`, `repair_progressive`, `release_degraded`,
  `vlc_fallback`, `image_subtitle_vlc`, `vlc_unavailable`, `native_unavailable`, `bandwidth_limit`,
  `probe_failed`, `audio_track_requested`, `audio_language`, `audio_language_unavailable`,
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

`preferences.engine: vlc` plays VLC direct, then a transcode for VLC; `native` never uses VLC.
`maxHeight`/`maxBitrateKbps` (and the device's bandwidth cap) below the source lead to a transcode.
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
| `capacity_reached` · `transcode_capacity` · `remux_capacity` | Server busy; `retry`. |
| `probe_failed`, `stream_expired`, `no_playable_file`, `invalid_release`, `nzb_fetch_failed`, `nzb_host_not_allowed`, `usenet_unreachable`, `playback_failed`, a transcode start code (`segment_timeout`, `transcode_failed` …) | As named. |

HTTP errors (standard envelope): `400 invalid_work_id` (movie and episode ids only),
`400 invalid_device_profile`, `400 invalid_playback_request`, `400 invalid_request`,
`403 age_restricted` (with `params`, on start and on switch), `403 password_change_required`,
`404 playback_not_found`, `404 module_disabled`, `409 too_many_streams`, `429 too_many_playbacks`.

**Switch.** `{ positionTicks?, releaseId?, audioStreamIndex?, subtitleStreamIndex? (-1 = off),
preferences?, stepDown? }` re-plans the same `playbackId` at `positionTicks` (default: the last
reported position). Set preference fields replace the current ones. Another `releaseId` resolves
again (with fallback); otherwise the live stream is re-planned without a new health check.
`stepDown: true` excludes the current method + engine (it failed on the device) and continues with
the next one; `no_more_methods` when none is left. The state restarts at `resolving` or `planning`;
the previous URL keeps working until 30 s after the new one is `ready`.

**Enforcement.**

- `allowTranscoding: false` blocks **full video transcodes only** (including burn-in and quality
  reductions). A remux, which copies the video and may convert the audio, stays allowed.
- `maxConcurrentStreams`: a playback counts while it is being prepared, and when `ready` while its
  last activity (ready, heartbeat, switch) is younger than `Streamarr:ViewerPlaybackHeartbeatSeconds`
  (default 60). At the limit a new playback on the **same device** replaces that device's older one;
  another device gets `409 too_many_streams` with `params` `limit`, `device` (the other device's
  name), `workId` and `releaseName` (when known). Failed and stopped playbacks do not count.
- Age gate: `403 age_restricted` before any work starts, and again on every switch.

**Lifetime and heartbeat.** A playback belongs to the viewer session (device) that created it:
other viewers and the same viewer's other devices get `404 playback_not_found`. Report progress
with `POST /viewer/watch/progress` and the `playbackId` (every ~10 s while playing): it fills
`releaseId`/`streamToken` of the watch event (pre-download and the shared event stream), keeps the
playback and its HLS session alive, and `event: stop` ends the playback like `…/stop`. A playback
without polls, heartbeats or switches for `Streamarr:ViewerPlaybackIdleSeconds` (default 600) is
stopped. Playbacks live in memory and end with a server restart. Stop closes the remux/transcode
sessions; the stream capability itself expires with its normal TTL, so playing the same version
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
