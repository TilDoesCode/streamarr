# Streamarr Build Brief (canonical spec)

> This is the complete build brief for Streamarr. Every implementation session MUST
> read this document and `docs/DECISIONS.md` before writing code. Where the two
> disagree, `DECISIONS.md` wins (it resolves this brief's open questions).

---

## 1. Mission

Build a system that lets a user **search for and stream Usenet content directly**,
with **no download-to-disk, no watch, no delete** cycle, and **without hosting a
full *arr stack** (no Sonarr, Radarr, Prowlarr, rclone, or WebDAV mount).

Three components:

1. **Core Server** (`server/`) — a standalone service that owns Usenet search,
   release selection/ranking, metadata matching, availability checks, on-demand byte
   streaming from Usenet, configuration, and watch state. **This is the product.**
2. **Jellyfin Plugin** (`plugin/`) — a `net9.0` server plugin that is a *thin
   adapter*, surfacing the Core Server's results inside Jellyfin's native search and
   making them playable through Jellyfin's transcoding pipeline.
3. **Management Web UI** (`web/`) — a React 19 SPA for configuring, operating,
   tuning, and debugging the Core Server.

### 1.1 Strategic framing

**Jellyfin is step 1, not the destination.** The system must be architected so that
a different front-end can be placed on top later — a custom web app, a React
Native/Expo mobile app, a TV app — **without rewriting the core.**

> **All domain logic lives in the Core Server. The Jellyfin plugin contains zero
> business logic.** If a future interface would also need a piece of logic, that
> logic may not live in the plugin.

Searching, parsing, ranking, rejecting, TMDB matching, health checking, session
management, and watch state are **server** concerns. The plugin only translates
between the server's interface-agnostic API and Jellyfin's data model (`BaseItem`,
`MediaSourceInfo`, action filters). Jellyfin types must never leak into the Core
Server's API.

### 1.2 The one hard constraint inside Jellyfin

Jellyfin's data model assumes **anything playable is a real `BaseItem` in its
database with a resolvable `MediaSourceInfo`.** Injecting search-result DTOs that do
not correspond to real items makes them appear in search but **fail on playback**
(clients request `/Items/{id}` and `/Items/{id}/PlaybackInfo` for an id the core
knows nothing about). Therefore every result we want playable must become a real
(ephemeral, isolated) item whose media sources are resolved lazily. This is a
*Jellyfin adapter* problem — do not let it shape the Core Server's API.

---

## 2. Licensing (RESOLVED — see DECISIONS.md)

**GPL-3.0 accepted for the whole project.** Radarr/Sonarr parser regexes, quality
definitions, and custom-format logic may be ported directly; shallow clones live in
`refs/` (git-ignored). Attribute every ported file in a header comment (source repo
+ path + commit). nzbdav (MIT) is vendored with attribution — MIT is
GPL-compatible. The Jellyfin plugin links Jellyfin (GPL-2.0) assemblies, which is
normal for Jellyfin plugins.

---

## 3. Interface-agnostic design mandate (cross-cutting; violate nothing here)

### 3.1 Rules

1. **Core Server API is the contract.** Versioned (`/api/v1`), documented via
   **OpenAPI**, shaped around *our* domain (works, releases, streams, profiles) —
   never around Jellyfin's.
2. **No Jellyfin types in the Core Server.** No `BaseItem`, no `MediaSourceInfo`, no
   Jellyfin assemblies referenced by the server project.
3. **No domain logic in the plugin.** The plugin may cache and translate. It may not
   parse release names, rank, reject, health-check, or decide fallbacks.
4. **The Management UI is the proof.** It consumes only the public API and must be
   able to search, resolve, and *play a preview* of a stream **with Jellyfin not
   running at all.** If that breaks, the abstraction has leaked — a build failure,
   not a UI bug.
5. **Generate clients from OpenAPI.** The React app's API client is generated from
   the spec. A future RN/Expo or TV client generates from the same spec.

### 3.2 What Jellyfin gives us for free (a future UI must replace)

| Capability | v1 owner | Future consideration |
|---|---|---|
| Transcoding / remux, device profiles | Jellyfin | Would need an ffmpeg-based transcode/remux service **in front of** `/stream`. Keep `/stream` a clean, generic HTTP+Range source so such a layer can be inserted without touching the core. |
| Client apps (TV, mobile, cast) | Jellyfin | Custom clients later; the generated API client is the on-ramp. |
| Watch state, resume, favorites | Jellyfin | **Mitigated now:** plugin reports playback events to the Core Server, so watch state accumulates server-side. |
| Metadata & artwork | **Core Server** (TMDB) | We own this. Never rely on Jellyfin's metadata fetcher for our items; pass TMDB data through the API. |
| User management & auth | Jellyfin (playback) / Core Server (admin UI) | Design the Core auth so it can grow into full multi-user later. |

### 3.3 Practical consequence for `/stream`

`GET /api/v1/stream/{token}` returns a plain, Range-capable HTTP byte stream — already
player-agnostic (ffmpeg, mpv, VLC, `<video>`, ExoPlayer, AVPlayer). The short-lived,
unguessable path token is the capability for that session; the endpoint accepts no
query credential and requires no admin JWT, machine API key, or media auth header.
**Preserve that property.** Never add Jellyfin-specific behavior to this endpoint.

---

## 4. Tech stack

**Core Server** — C# / .NET 8, ASP.NET Core **controllers** (be consistent).
Long-lived NNTP connection pool; Kestrel with `Range` support. SQLite via EF Core
(config, profiles, release/session cache, watch events). OpenAPI exposed
(Swashbuckle or built-in) — it is the cross-interface contract.

**Jellyfin Plugin** — `net9.0`, from the official template
(https://github.com/jellyfin/jellyfin-plugin-template). Target Jellyfin 10.11.11.

**Management Web UI** — React 19 + TypeScript, Vite. TanStack Query v5 for all
server state (no Redux; local UI state via `useState`/`useReducer`). **TanStack
Router** with typed routes. Tailwind CSS + shadcn/ui; lucide-react icons.
react-hook-form + zod (schemas validated against OpenAPI types). API client
generated from the OpenAPI spec via **openapi-typescript** + a thin typed fetch
wrapper — never hand-maintain API types. Vitest + Testing Library; Playwright smoke
E2E (login → configure indexer → search → preview-play). Recharts for charts.
Serving: Vite dev proxy in development; in production the built SPA is served as
static files by the Core Server (single container, single origin). Provide both.

**Packaging** — Dockerfile for the Core Server (multi-stage: build SPA → build .NET
→ runtime). `docker-compose.dev.yml`: Jellyfin + Core Server, plugin `.dll` mounted
into Jellyfin's plugin dir, Vite dev server optional alongside.

---

## 5. Architecture overview

```
                    ┌──────────────────────────────────────────────┐
                    │           CORE SERVER  (the product)         │
                    │  /api/v1                                     │
  ┌─ Jellyfin ────┐ │   search   Newznab fan-out, parse, reject,   │
  │ (UI + trans-  │◀┼──▶         rank, TMDB match, aggregate       │
  │  coding, v1)  │ │   resolve  fetch NZB, health-check, open     │
  │ Plugin =      │ │            session, ffprobe media info       │
  │ THIN ADAPTER  │ │   stream   HTTP + Range byte stream          │
  │  • ActionFilter│ │            (embedded nzbdav core: NNTP pool,│
  │  • ephemeral   │ │             yEnc, RAR/7z random access,     │
  │    items       │ │             segment cache)                  │
  │  • IMediaSource│ │   config   indexers, providers, profiles    │
  │    Provider    │ │   sessions live sessions, close, metrics    │
  │  • TTL cleanup │ │   events   playback start/progress/stop     │
  │  • playback    │ │   health   liveness, provider reachability  │
  │    events ─────┼─▶                                             │
  └───────────────┘ │  OpenAPI spec ──── generated clients ───────┐│
  ┌─ Management ──┐ │                                             ││
  │ Web UI (React)│◀┼─────────────────────────────────────────────┘│
  └───────────────┘ │  SQLite: config, profiles, cache, watch state│
                    └──────────────────────────────────────────────┘
  FUTURE: custom web / RN-Expo / TV client — same OpenAPI contract;
  would need a transcode layer in front of /stream.
```

### Request lifecycle (Jellyfin path)

1. User types a query in any Jellyfin client.
2. Plugin's action filter intercepts the item/search query, calls `GET /api/v1/search`.
3. Server fans out to indexers, parses + ranks releases, aggregates them to **works**
   (one movie/episode with N alternative releases), enriches via TMDB.
4. Plugin materializes **one isolated ephemeral item per work** under a private,
   hidden implementation folder, sets TMDB/IMDb ProviderIds, tags it ephemeral, stores
   the ranked release list keyed to the item, and merges only eligible results into
   the search response.
5. User hits play → Jellyfin requests `PlaybackInfo`.
6. Plugin's `IMediaSourceProvider.GetMediaSources` returns one `MediaSourceInfo` per
   release (selectable "versions"), each `RequiresOpening = true` with an opaque,
   bounded, replay-safe `OpenToken` tied to that authenticated Jellyfin user, item, work,
   and offered release. Idle offers expire after ten minutes; active playback holds the
   lease and final close starts the replay window. **No Usenet contact yet.**
7. `OpenMediaSource(openToken)` validates that offer, then calls
   `POST /api/v1/resolve` → server health-checks, opens a session, ffprobes, returns a
   stream-capability URL + media streams.
8. Plugin returns `MediaSourceInfo { Path = streamUrl, Protocol = Http,
   IsRemote = true, RequiresClosing = true,
   MediaStreams = <pre-probed>, RunTimeTicks }` with no reusable credential in
   `RequiredHttpHeaders`.
9. Jellyfin streams via ffmpeg (Direct Play or transcode). Plugin reports playback
   events to `POST /api/v1/events`.
10. `CloseLiveStream` → `POST /api/v1/sessions/{token}/close`. `IScheduledTask`
    deletes ephemeral items past TTL.

---

## 6. Core Server specification

### 6.1 Modules

1. **Indexer client (the Prowlarr role):** query configured indexers via the Newznab
   API (`t=caps`, `t=search`, `t=movie&imdbid=`, `t=tvsearch`). Parse the RSS/XML:
   `<item>` with `<enclosure url>` (NZB URL) + newznab attrs (size, category, grabs,
   pubdate, guid). Fan out concurrently, dedupe by normalized title + size. Respect
   per-indexer rate limits; short-lived cache (~60s) keyed by normalized query.
2. **Release parser + ranker** (Section 7) — the "hidden Radarr".
3. **TMDB matcher:** from parsed title+year (movie) or title+season/episode (tv),
   resolve `tmdbId`/`imdbId`, poster, backdrop, overview, runtime. Cache
   aggressively. Group releases under the resolved work.
4. **NZB streaming core (embed nzbdav):** study `refs/nzbdav/backend/`; extract the
   primitives — NNTP connection pool, yEnc decoding, NZB parsing, RAR/7z random
   access, seeking. **Drop** everything that exists only to serve the *arr stack:
   the SABnzbd-compatible API, queue/history emulation, the WebDAV server, and the
   rclone-oriented filesystem presentation. We expose HTTP+Range directly.
5. **Health checker:** verify article availability via NNTP `STAT <message-id>`
   (223 = present, 430 = missing) on a representative sample of the *media file's*
   segments (not just par2). Classify `ready` / `degraded` / `dead`. Feed deadness
   back into ranking.
6. **Session manager:** a resolve creates a session (open NNTP handles, segment
   index) with a TTL; a stream token maps to a session; close tears it down. Enforce
   a **global NNTP connection budget** shared across all sessions.
7. **Watch-event store:** ingest playback events from any front-end into SQLite.
   Not user-facing in v1 — future-proofing.
8. **Config store:** indexers, providers, profiles, secrets — CRUD'd by the
   Management UI.

### 6.2 API contract (`/api/v1`, OpenAPI-documented)

**`GET /search`** — `q` (required), `type` (`movie|tv|any`), `season`, `episode`,
`imdbId`, `tmdbId`, `profileId` (optional override).

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
`nzbUrl` stays server-side; never expose indexer API keys or NZB URLs to clients.

**`POST /resolve`** — `{ "releaseId": "…" }`. Fetches the NZB, parses it, identifies
the primary media file (unwrapping RAR if needed), health-checks sampled segments,
opens a session, and probes with `ffprobe` **against the stream** so the front-end
does not have to probe a slow remote source.

```json
{
  "releaseId": "…",
  "status": "ready",
  "streamUrl": "https://server/api/v1/stream/<opaque-token>",
  "container": "mkv",
  "sizeBytes": 5368709120,
  "runTimeTicks": 78000000000,
  "mediaStreams": [
    { "type": "Video", "codec": "hevc", "width": 1920, "height": 1080 },
    { "type": "Audio", "codec": "eac3", "channels": 6, "language": "deu" },
    { "type": "Subtitle", "codec": "subrip", "language": "eng" }
  ],
  "sessionTtlSeconds": 3600,
  "suggestedFallbackReleaseId": null
}
```
`mediaStreams` uses **our own** neutral shape — the plugin maps it to Jellyfin's
`MediaStream`. Do not adopt Jellyfin's schema here.

If `status == "dead"`, return the classification plus
`suggestedFallbackReleaseId` (next-best ranked release for the same work) so any
front-end can auto-retry.

**`GET /stream/{token}`** — capability-authorized Range-capable byte stream. MUST honor
`Range: bytes=…`, return `206` with correct `Content-Range` and
`Accept-Ranges: bytes`, and support seeking anywhere (including inside RAR).
Possession of the short-lived path capability grants access only to that session; no
`access_token` query value, admin JWT, machine API key, or reusable media auth header
is accepted or required. Player-agnostic by contract.

**`POST /sessions/{token}/close`** — tear down a session.
**`GET /sessions`** — list live sessions (release, bytes served, NNTP conns, client).
**`POST /events`** — playback events: `{ releaseId, workId, event: "start"|"progress"|"stop", positionTicks, source: "jellyfin"|"web"|… }`.
**`GET /caps`** — supported categories/providers.
**`GET /health`** — liveness + per-indexer and per-provider reachability.

**Config API** (admin auth required):
- `GET/POST/PUT/DELETE /config/indexers` (+ `POST /config/indexers/{id}/test`)
- `GET/POST/PUT/DELETE /config/providers` (+ `POST /config/providers/{id}/test`)
- `GET/PUT /config/general` (TMDB key, TTLs, cache sizes, connection budget)
- `GET/POST/PUT/DELETE /config/profiles` (quality preference profiles)
- `POST /debug/search` — like `/search` but returns **every** release including
  rejected ones, with parsed fields, per-rule score breakdown, and rejection
  reasons. Powers the ranker-tuning view; essential for development.

### 6.3 Configuration

- Indexers: `{ name, baseUrl, apiKey, categories, enabled, priority }`.
- Usenet providers: `{ host, port, useSsl, username, password, maxConnections,
  priority }` — support multiple (primary + block-account fallback).
- TMDB API key. Session TTL, search cache TTL, segment cache size, global NNTP
  connection budget.
- Quality preference profiles (Section 7.3).
- Secrets encrypted at rest; never returned in plaintext by the config API (masked
  values; write-only fields).

### 6.4 Auth (two modes)

- **Machine/API-key auth** — `Authorization: Bearer <api-key>` for the Jellyfin
  plugin and any future headless client. Scoped to machine operations such as
  search/resolve/events; it is not carried into the media URL.
- **Admin session auth** — username/password login for the Management UI, issuing a
  short-lived bearer JWT for non-browser clients and an HttpOnly session cookie for
  the browser UI. Scoped to everything including
  `/config` and `/debug`.
- **`/stream/{token}` is capability-authorized** — resolve mints an unguessable,
  short-lived session token that grants access only to that stream. Never put an admin
  JWT or reusable machine key in a media URL.
- Design the user model so it can grow into real multi-user later; do not hardcode a
  single admin.

---

## 7. Release parsing & ranking (the "hidden Radarr" — do not underestimate)

A single search returns dozens of releases: multiple resolutions, codecs, languages,
fakes, samples, password-protected archives, incomplete/DMCA'd uploads. This is the
difference between "feels like streaming" and "every third click fails." GPL-3.0 is
accepted: port from `refs/Radarr/src/NzbDrone.Core/Parser/`,
`refs/Radarr/src/NzbDrone.Core/Qualities/`, and Sonarr's episode parsers, with
attribution headers.

### 7.1 Parse (from the raw release name)

Resolution (`2160p|1080p|720p|480p|SD`), source
(`BluRay|Remux|WEB-DL|WEBRip|HDTV|DVD|CAM|…`), video codec (`x265/HEVC|x264/AVC|AV1`),
HDR flavor (`DV|HDR10+|HDR10|HLG|SDR`), audio (`TrueHD|DTS-HD|DDP|DD|AAC` + channels),
release group, edition (`Extended|Director's Cut|Uncut`), `PROPER`/`REPACK`, and
languages (incl. multi/dual-audio markers). For TV also: `S01E02`, season packs,
daily-date, and absolute-numbered (anime) formats.

Build a **test corpus of real release names** with expected parse output. The parser
must be unit-tested against it; this corpus is a first-class deliverable.

### 7.2 Reject (before ranking)

- **Samples** — `sample` in name, or size implausibly small for runtime.
- **Fakes / size sanity** — bytes-per-minute against TMDB runtime outside a sane band
  for the claimed quality.
- **Password-protected archives** without a known password.
- **Non-media payloads** (executables, etc.) in the NZB.
- **Incomplete uploads** — missing files vs expected count, or too few segments.
- **Dead on Usenet** — from the health check (known at resolve; feed back into rank).

Every rejection carries a machine-readable reason (surfaced in `/debug/search` and
the Management UI).

### 7.3 Rank

A configurable profile: prefer resolution X, source tier, codec, language, audio
tier, group allow/deny lists, PROPER/REPACK bonus, recency bonus, grabs bonus.
Produce an integer `score` per release; sort descending within each work. Keep it a
transparent weighted sum, but structure it so a Radarr-style custom-format model
could replace it later **without changing the API**.

### 7.4 Aggregate to works

Group ranked releases by resolved TMDB work. Front-ends show **one item per work**
with releases as selectable "versions" — in Jellyfin this maps onto its native
version picker for free, and any future UI gets the same structure from the API.

---

## 8. Jellyfin Plugin specification (thin adapter — no domain logic)

Base it on the official template. Target Jellyfin 10.11.11 (exact patch pinned in
`docs/jellyfin-compatibility.md`); the search interception is version-sensitive.

### 8.1 Structure

- `Plugin : BasePlugin<PluginConfiguration>` + `IHasWebPages`.
- `PluginConfiguration`: Core Server base URL, API key, ephemeral item TTL,
  interception on/off toggle, optional profile id.
- `IPluginServiceRegistrator` registering a typed `HttpClient` and plugin services.
- The plugin's config page is deliberately **minimal** — real configuration lives in
  the Management UI. The plugin page only needs: server URL, API key, TTL, toggle,
  and a "test connection" button (anonymous shallow `GET /api/v1/health?deep=false`
  followed by authenticated `GET /api/v1/caps`).

### 8.2 Search interception

An `IAsyncActionFilter` intercepting the item-query / search-hints actions (`/Items`
with a `searchTerm`, and `/Search/Hints`). When a search term is present and
interception is enabled:

1. Call `GET /api/v1/search` (short timeout).
2. Materialize/refresh ephemeral items (8.3).
3. Merge them into the outgoing `QueryResult<BaseItemDto>` / hints response.

Study how the Meilisearch plugin
(https://github.com/arnesacnussem/jellyfin-plugin-meilisearch) injects an
`ActionFilter` and mutates the `/Items` request; mirror the registration mechanism.
**Wrap it in try/catch and a config toggle: any error or timeout must fall through
to native behavior. A broken filter must never break normal library search.**

### 8.3 Ephemeral item materialization (isolation is mandatory)

- Create items under a **private, hidden implementation folder**, excluded from normal
  library browsing, "Latest", and recommendations. Expose eligible items only in the
  intercepted search response, subject to the requesting user's compatible-library
  visibility policy.
- One item per **work**; type `Movie` or `Episode`.
- Set `ProviderIds` (`Tmdb`, `Imdb`), a custom provider id (`UsenetWorkId = workId`),
  and a tag (`usenet-ephemeral`).
- Pass TMDB metadata (poster/overview/runtime) through from the API rather than
  relying on Jellyfin's own fetcher — we own metadata.
- Cache the ranked release list keyed to the item id; record `lastAccessedUtc`.
- **Stable GUIDs derived from `workId`** so repeated searches update, not duplicate.

### 8.4 Lazy media-source resolution — `IMediaSourceProvider`

- `GetMediaSources(item)` → one `MediaSourceInfo` per ranked release:
  `RequiresOpening = true`, an opaque, bounded, replay-safe `OpenToken` tied
  to the authenticated Jellyfin user/item/work/offered release, `IsRemote = true`,
  `Protocol = Http`, `Name = "1080p WEB-DL x265 · DDP5.1 · GER"`. **No Usenet
  contact.**
- `OpenMediaSource(openToken)` → validate the offer →
  `POST /api/v1/resolve` → on `ready`, return
  `MediaSourceInfo { Path = streamUrl, Protocol = Http, RequiresClosing = true,
  LiveStreamId, RunTimeTicks, MediaStreams }` with
  **pre-populated MediaStreams** from resolve, a low `AnalyzeDurationMs`, and no
  reusable credential in `RequiredHttpHeaders`. Accept only server-attributed fallback
  releases within the originally offered work; on `dead`, follow
  `suggestedFallbackReleaseId` once before surfacing an error.
- `CloseLiveStream(id)` → `POST /api/v1/sessions/{token}/close`.
- Report `start` / `progress` / `stop` to `POST /api/v1/events` (hook Jellyfin's
  playback session events) — this is how watch state escapes Jellyfin's DB.

### 8.5 TTL cleanup — `IScheduledTask`

Delete `usenet-ephemeral` items whose `lastAccessedUtc` exceeds the TTL via
`ILibraryManager`; close lingering sessions.

---

## 9. Management Web UI specification

A React 19 SPA that configures, operates, tunes and debugs the Core Server. It talks
**only** to the public API and must work with Jellyfin absent.

### 9.1 Views

1. **Dashboard** — service health, per-indexer and per-provider status, live
   sessions count, NNTP connections in use vs budget, throughput chart (Recharts),
   recent resolves with health outcomes.
2. **Indexers** — CRUD; per-indexer "Test" button showing caps + latency;
   enable/disable; priority ordering.
3. **Usenet Providers** — CRUD; host/port/SSL/credentials/max-connections/priority;
   "Test connection" showing auth result and achievable connections. Secrets are
   write-only (masked on read).
4. **Quality Profiles** — editor for the ranking profile: weights, preferred
   resolutions/sources/codecs/languages, group allow/deny, size bands, rejection
   rules. **Live preview:** run a sample query against `/debug/search` and see how
   the current draft profile reorders results before saving.
5. **Search / Debug playground** — the single most valuable dev tool. Enter a query
   → every release from `/debug/search`, including rejected ones, with: raw name,
   parsed fields, score with **per-rule breakdown**, rejection reasons, indexer,
   size, age, grabs. Filter/sort. Trigger `POST /resolve` on any release to see the
   health-check result and media info.
6. **Playback preview** — play a resolved stream directly in an HTML5 `<video>`
   element (direct play only). **This is the architectural canary:** if it works
   without Jellyfin, the API is truly interface-agnostic. Show seek behavior and
   time-to-first-frame.
7. **Sessions** — live sessions; bytes served, connections held, originating
   front-end; force-close.
8. **Settings** — general config, TTLs, cache sizes, connection budget, API keys for
   machine clients (create/revoke), admin password change.
9. **Login** — admin auth.

### 9.2 Implementation requirements

- **TanStack Query** owns all server state: query keys per resource, mutations with
  invalidation, optimistic updates on config edits, `refetchInterval` for
  dashboard/sessions (SSE optional; polling must be the fallback).
- **Generated API types/client from the OpenAPI spec.** A CI check must fail if the
  generated client is stale relative to the spec. No hand-written API types.
- **Forms:** react-hook-form + zod; validation mirrors server-side validation.
- **Errors:** a typed error envelope rendered consistently (toasts + inline field
  errors). Surface rejection reasons and health failures in plain language.
- **Dark mode**, responsive down to tablet. Accessibility: keyboard-navigable,
  labelled controls.
- **Tests:** Vitest + Testing Library for the profile editor and debug table;
  Playwright smoke: login → add indexer → search → preview-play.

---

## 10. Build order & acceptance criteria

Do **not** start the fragile search interception until the streaming path is proven.

### Milestone 1 — Core Server streaming core, headless (no Jellyfin, no UI)
Embed nzbdav core; implement `/resolve` + `/stream` for a known-good NZB.
**Accept:** `ffprobe` reads the stream URL; `mpv`/`ffplay` plays it; seeking to
arbitrary timestamps works, including RAR-wrapped content; **cold-start latency and
seek latency measured and recorded** against the real provider (mock-NNTP-based
integration tests until real credentials are provided — see DECISIONS.md).

### Milestone 2 — Search, parsing, ranking, TMDB
Newznab fan-out, parser, ranker, rejections, TMDB aggregation → `/search` +
`/debug/search`. **Accept:** sample queries return works with sanely ranked
releases; fakes/samples/password/dead rejected with reasons; TMDB metadata attached;
parser unit-tested against the real-release-name corpus; ranker ordering tested.

### Milestone 3 — OpenAPI, config API, auth
Freeze `/api/v1`, publish the OpenAPI spec, implement config CRUD + both auth
modes. **Accept:** spec is complete and generates a clean TS client; every operation
has an explicit posture (scoped credential, session capability, or deliberately
anonymous shallow liveness); secrets are never returned in plaintext.

### Milestone 4 — Management Web UI
React 19 SPA: login, indexers, providers, profiles, debug playground, **playback
preview**, sessions, dashboard. **Accept:** an operator can configure the system
from scratch, run a search, inspect why releases were rejected, tune a profile with
live preview, and **play a stream in the browser — with Jellyfin not running.**
Generated client is in CI and fails on drift.

### Milestone 5 — Jellyfin playback thin-slice (no search hack yet)
Plugin materializes **one hardcoded** ephemeral item pointing at the Core Server via
`IMediaSourceProvider`; resolve/open/close wired; playback events reported.
**Accept:** the item plays in a Jellyfin client via both Direct Play and forced
transcode; the version picker shows multiple releases; `CloseMediaSource` tears down
the session; events land in `/events`.

### Milestone 6 — Search interception + TTL cleanup
Action filter injects ephemeral works into native search; cleanup task.
**Accept:** a query in a native client surfaces Usenet works alongside local
results; selecting one plays it; **disabling the toggle or killing the Core Server
leaves normal library search fully intact**; cleanup removes stale items; no
duplicates on repeated searches; the isolated folder never appears in Latest.

### Milestone 7 — Hardening
Auto-fallback on dead release; NNTP connection budgeting under concurrent streams;
provider fallback (block account); structured logging + metrics; docker-compose dev
stack; docs. **Accept:** two concurrent streams respect the connection budget; a
dead release transparently falls back; load-test the segment cache.

---

## 11. Non-negotiables (bake these in)

- **No domain logic in the plugin. No Jellyfin types in the Core Server.** The
  Management UI's ability to search, resolve and preview-play without Jellyfin is
  the continuous test. A regression there is a build break.
- **Never block native Jellyfin search.** Action filter degrades to native behavior
  on any error/timeout, behind a config toggle.
- **Injected search results must be playable.** Real ephemeral items with resolvable
  media sources. Never ship unplayable injected DTOs.
- **Pre-probe media info server-side.** Populate media streams + runtime at resolve;
  set a low `AnalyzeDurationMs`.
- **Dead releases are the default failure mode without *arr.** Health check +
  auto-fallback is core, not optional.
- **Reject fakes/samples/password archives** in ranking.
- **NNTP connection budget** enforced globally across concurrent sessions.
- **Sessions closed on stop and on TTL.**
- **Explicit auth posture on every endpoint:** scoped admin/machine credentials for
  operations; an unguessable, short-lived session capability for `/stream/{token}` and
  its close operation; only shallow health is deliberately anonymous. Never accept
  reusable credentials in a media URL or query.
- **DB pollution:** ephemeral items stay isolated and TTL-cleaned.
- **Action-filter version fragility:** pin and integration-test against the target
  Jellyfin version; document it; isolate the coupling in one file.

---

## 12. Non-goals (do not build now)

- No Sonarr/Radarr/Prowlarr, no rclone, no WebDAV mount, no download-to-disk.
- No torrents (Usenet/NZB only).
- No custom playback client and no transcoding of our own — yet. Keep `/stream`
  generic; never let a transcoding assumption leak into the core.
- No request/approval or multi-user quota workflow (keep the user model extensible).
- No subtitle search.

---

## 13. Deliverables

- `server/` — ASP.NET Core Core Server, embedded nzbdav core (attributed), parser +
  ranker with the release-name test corpus, SQLite persistence, OpenAPI spec,
  Dockerfile.
- `plugin/` — Jellyfin `net9.0` thin-adapter plugin, minimal config page, target
  Jellyfin version documented, build/install instructions.
- `web/` — React 19 + TanStack Query management SPA, generated API client, tests.
- `docker-compose.dev.yml` — Jellyfin + Core Server (+ Vite dev server), plugin
  `.dll` mounted.
- `docs/` — architecture overview, API contract, setup guide, ranker-tuning guide,
  and a "known-fragile: search interception" note tied to the Jellyfin version.
