# API contract — `/api/v1`

The Core Server's HTTP API is **the** cross-interface contract (BRIEF §3.1): the
Jellyfin plugin, the Management UI, and any future client all speak it, and all
generate their types from the frozen spec at
[`server/openapi/v1.json`](../server/openapi/v1.json). This document is the
human-readable companion to that spec — it does not add or remove endpoints, it
explains them. **If an endpoint is not in `v1.json`, it does not exist.**

The spec is served live at `/openapi/v1.json` (all environments) and, in Development,
browsable at `/swagger`.

> Shapes are domain-shaped around *works*, *releases*, *streams*, *sessions*, and
> *profiles* — never around Jellyfin. `/resolve` returns a neutral `mediaStreams`
> shape, not Jellyfin's `MediaStream`; the plugin maps it. See
> [`architecture.md`](./architecture.md).

---

## 1. Authentication

Administrative and machine API endpoints use one authentication scheme with three
credential transports, resolved by
([`StreamarrAuthenticationHandler`](../server/src/Streamarr.Server/Auth/StreamarrAuthenticationHandler.cs)):

| Mode | Token | Scope |
|---|---|---|
| **Machine / API key** | The static bootstrap key (`Streamarr:ApiKey`) or a key minted via `POST /config/apikeys`. | `search`, `resolve`, `events`, `caps`, and shallow `health`. **Not** `/config`, `/debug`, session listing, or metrics. |
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
  "expiresInSeconds": 3600,
  "expiresAt": "2026-07-13T12:00:00Z",
  "username": "admin",
  "role": "admin"
}
```
`401` on bad credentials. Lifetime is `Streamarr:AdminSessionTtlSeconds` (default
3600). The response also sets the browser cookie; the returned bearer token is for
non-browser clients. Related: `GET /auth/me` (identity behind the current credential),
`POST /auth/logout` (`204`), and `POST /auth/password` (admin self-service change;
`204`).

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

---

## 3. Search

### `GET /api/v1/search`

Query params: `q` (required unless `imdbId`/`tmdbId` given), `type`
(`movie`|`tv`|`any`), `season`, `episode`, `imdbId`, `tmdbId`, `profileId` (optional
ranking-profile override). Returns works, each with its **ranked** releases. The NZB
URL and indexer API keys are never present (BRIEF §6.2).

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
{ "releaseId": "sha256-of-guid", "client": "web", "autoFallback": true }
```

| Field | Meaning |
|---|---|
| `releaseId` | The release to resolve (required). |
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
  "sessionTtlSeconds": 3600,
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
  "sessionTtlSeconds": 3600,
  "suggestedFallbackReleaseId": "sha256-of-next-best",
  "fallbackFromReleaseId": null,
  "attempts": [ { "releaseId": "sha256-of-guid", "status": "dead" } ]
}
```

Errors: `404 release_not_found`; `422 no_playable_file` / `invalid_release` (the NZB
has no playable media file, or is malformed); `502 usenet_unreachable` /
`nzb_fetch_failed` (the provider or the indexer NZB host could not be reached). A dead
classification is **not** an error — it is a `200` with `status: "dead"`.

Whatever the outcome, a dead release is recorded in the health cache
(`Streamarr:HealthCacheTtlSeconds`) so it is demoted/rejected on later searches and
skipped as a future fallback (see [`architecture.md`](./architecture.md) §5.3).

---

## 5. Stream

### `GET /api/v1/stream/{token}`

A plain, capability-authorized, **Range-capable** HTTP byte stream (BRIEF §3.3). Player-
agnostic by contract — ffmpeg, mpv, VLC, `<video>`, ExoPlayer, AVPlayer. **No
Jellyfin-specific behavior may ever be added here.**

- Honors `Range: bytes=…` → `206 Partial Content` with a correct `Content-Range` and
  `Accept-Ranges: bytes`. No `Range` header → `200` with the full body.
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
    "createdAt": "2026-07-13T11:20:00Z",
    "lastAccessedAt": "2026-07-13T11:24:10Z",
    "expiresAt": "2026-07-13T12:20:00Z"
  }
]
```

### `POST /api/v1/sessions/{token}/close`

Tears a session down (`204`; `404` if unknown). Sessions are also closed on their TTL
(`Streamarr:SessionTtlSeconds`, swept every `SessionSweepIntervalSeconds`) and by the
plugin on Jellyfin's `CloseLiveStream`.

---

## 7. Events

### `POST /api/v1/events`

Ingests a playback event from any front-end into SQLite (BRIEF §6.1 module 7). This is
how watch state escapes a front-end's own DB. `202 Accepted`.

```json
{
  "releaseId": "…", "workId": "tmdb-movie-12345",
  "event": "progress", "positionTicks": 42000000000, "source": "jellyfin"
}
```
`event` is `"start"` | `"progress"` | `"stop"`; `source` is the originating front-end.

---

## 8. Health, caps, metrics

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

`GET` · `POST` · `GET/PUT/DELETE /{id}` · `POST /{id}/test`. Multiple priority-ordered
providers are supported (DECISIONS.md #6): primary + block-account backup.

```json
// ProviderWrite (POST/PUT)
{ "name": "primary", "host": "news.example.com", "port": 563, "useSsl": true,
  "username": "user", "password": "secret", "maxConnections": 20,
  "priority": 0, "enabled": true, "isBackupOnly": false }
```
Reads return `ProviderResponse` with `password` masked and `hasPassword: true`. `POST
/{id}/test` connects + `AUTHINFO` and reports `success`, `achievableConnections`
(≤ `maxConnections`), and `requestedConnections`.

### General — `/api/v1/config/general`

`GET` / `PUT`. TMDB key (write-only: masked on read as `hasTmdbApiKey`, omit-to-keep on
write), plus `sessionTtlSeconds`, `searchCacheTtlSeconds`, `segmentCacheSizeMb`,
`connectionBudget`. Scalar changes take effect on restart.

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

## See also

- [`architecture.md`](./architecture.md) — how these endpoints compose into the
  search → resolve → stream lifecycle and the M7 hardening layer.
- [`ranker-tuning.md`](./ranker-tuning.md) — the `parsed` fields, `scoreBreakdown`
  rules, and rejection `code` values that `/debug/search` exposes.
- [`setup.md`](./setup.md) — how to configure indexers/providers/profiles that these
  endpoints read.
