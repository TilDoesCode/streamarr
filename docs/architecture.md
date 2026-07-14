# Architecture

> Streamarr searches Usenet, picks the best release, verifies it is still there, and
> streams it as a seekable HTTP byte range — no download, no watch, no delete. This
> document explains how the pieces fit and, more importantly, **why the boundaries
> between them are where they are.**

Read this alongside the canonical spec ([`BRIEF.md`](./BRIEF.md), especially §3, §5,
§6, §7, §11) and the settled [`DECISIONS.md`](./DECISIONS.md). Where they disagree,
`DECISIONS.md` wins.

---

## 1. The interface-agnostic mandate (read this first)

Everything else in this document is downstream of one rule (BRIEF §3, §11):

> **All domain logic lives in the Core Server. The Jellyfin plugin contains zero
> business logic. Jellyfin types never appear in the Core.**

This is not architectural purity for its own sake. **Jellyfin is step 1, not the
destination.** Streamarr must be able to grow a custom web app, a React Native/Expo
mobile client, or a TV app on top of the *same* API later, without rewriting the
Core. That is only possible if the Core owes Jellyfin nothing.

Concretely, the mandate is enforced as five hard constraints:

1. **The Core Server API is the contract.** Versioned (`/api/v1`), documented via a
   frozen OpenAPI spec ([`server/openapi/v1.json`](../server/openapi/v1.json)), and
   shaped around *our* domain — works, releases, streams, sessions, profiles — never
   around Jellyfin's `BaseItem`/`MediaSourceInfo`. See [`api.md`](./api.md).
2. **No Jellyfin types in the Core.** The `Streamarr.Server`, `Streamarr.Core`, and
   `Streamarr.Usenet` projects reference no Jellyfin assemblies. `/resolve` returns a
   neutral `MediaStreamInfo` shape (BRIEF §6.2) — deliberately **not** Jellyfin's
   `MediaStream` — and the plugin maps it.
3. **No domain logic in the plugin.** Searching, parsing, ranking, rejecting, TMDB
   matching, health-checking, session management, fallback selection, and watch state
   are all Core concerns. The plugin may cache and translate. It may not decide
   anything.
4. **The Management UI is the continuous proof.** It talks only to the public API and
   can search, resolve, and **play a stream preview in the browser with Jellyfin not
   running at all** (the "Playback preview" view — the *architectural canary*). If
   that ever breaks, the abstraction has leaked: it is a build failure, not a UI bug.
5. **Generated clients from OpenAPI.** The React app's API client is generated from
   the spec (CI fails on drift). A future RN/Expo or TV client generates from the same
   spec.

### The one hard constraint *inside* Jellyfin

Jellyfin's data model assumes anything playable is a real `BaseItem` in its database
with a resolvable `MediaSourceInfo`. Injecting bare search-result DTOs makes them
appear in search but **fail on playback**. So the plugin must materialize each result
as a real (ephemeral, isolated, TTL-cleaned) item whose media sources resolve lazily.
This is a *Jellyfin adapter* problem, and it is confined to the plugin — it never
shapes the Core API. (BRIEF §1.2, §8.)

---

## 2. The three components

```
                    ┌──────────────────────────────────────────────┐
                    │        STREAMARR CORE  (the product)         │
                    │                                              │
  ┌─ Jellyfin ────┐ │  /api/v1                                     │
  │ (UI + trans-  │ │   search   indexer fan-out, parse, reject,   │
  │  coding, v1)  │◀┼──▶         rank, TMDB match, aggregate       │
  │               │ │   resolve  fetch NZB, health-check, open     │
  │ Plugin =      │ │            session, ffprobe media info       │
  │ THIN ADAPTER  │ │   stream   HTTP + Range byte stream          │
  │  • ActionFilter│ │            (embedded nzbdav core: NNTP pool,│
  │  • ephemeral   │ │             yEnc, RAR/7z random access,     │
  │    items       │ │             bounded read-ahead)             │
  │  • IMediaSource│ │   config   indexers, providers, profiles    │
  │    Provider    │ │   sessions live sessions, close, metrics    │
  │  • TTL cleanup │ │   events   playback start/progress/stop     │
  │  • playback ───┼─▶  health   liveness + reachability           │
  │    events      │ │   metrics  sessions/conns/cache/latency     │
  └───────────────┘ │                                              │
                    │  OpenAPI spec ──── generated clients ───────┐│
  ┌─ Management ──┐ │                                             ││
  │ Web UI (React)│◀┼─────────────────────────────────────────────┘│
  └───────────────┘ │  SQLite: config, profiles, cache, watch state│
                    └──────────────────────────────────────────────┘
  FUTURE: custom web / RN-Expo / TV client — same OpenAPI contract;
  would need a transcode layer in front of /stream (see §8).
```

| Component | Path | Role | Stack |
|---|---|---|---|
| **Core Server** | [`server/`](../server) | The product. Owns search, ranking, resolve, streaming, config, sessions, watch state. | C# / .NET 8, ASP.NET Core controllers, Kestrel + Range, SQLite via EF Core |
| **Jellyfin plugin** | [`plugin/`](../plugin) | Thin adapter. Surfaces Core results inside Jellyfin's native search and makes them playable through Jellyfin's transcoding. **Zero domain logic.** | `net9.0`, Jellyfin 10.11.11 ABI |
| **Management Web UI** | [`web/`](../web) | Configure, operate, tune, debug the Core. The continuous proof of interface-agnosticism. | React 19, TanStack Query/Router, Vite, Tailwind + shadcn/ui |

The boundary that matters is the vertical line down the middle of the diagram: the
plugin and the web UI are *both* just clients of `/api/v1`. Neither is privileged. The
plugin's extra job — translating to Jellyfin's data model — lives entirely on the
plugin's side of that line.

---

## 3. Core Server module map

The Core is three projects:

- **`Streamarr.Core`** — pure domain logic, no ASP.NET, no Jellyfin: parser, ranker,
  rejection rules, quality profiles, TMDB matcher, health classification, the health
  cache.
- **`Streamarr.Usenet`** — the embedded nzbdav streaming core (attributed, MIT):
  NNTP connection pool, yEnc decoding, NZB parsing, RAR/7z random access, the
  connection-budget gate, provider failover, circuit breaker.
- **`Streamarr.Server`** — ASP.NET Core host: controllers, auth, config store,
  session manager, resolve pipeline, metrics, DI wiring
  ([`StreamarrServerBootstrap.cs`](../server/src/Streamarr.Server/StreamarrServerBootstrap.cs)),
  and the static SPA host.

The modules (BRIEF §6.1):

| Module | Where | What it does |
|---|---|---|
| **Indexer client** (the Prowlarr role) | `Core/Indexers` | Fans out to configured Newznab indexers (`t=caps`/`t=search`/`t=movie`/`t=tvsearch`), parses RSS/XML, dedupes, honors per-indexer rate limits, caches ~60 s by normalized query. |
| **Release parser** | `Core/Parser` | Parses resolution/source/codec/HDR/audio/group/edition/proper-repack/languages, and for TV: S/E, season packs, dailies, absolute numbering (BRIEF §7.1). |
| **Ranker + rejection** (the "hidden Radarr") | `Core/Ranking`, `Core/Profiles` | `WeightedSumRanker` scores each release; `RejectionRules` drop samples/fakes/password/non-media/incomplete/dead. See [`ranker-tuning.md`](./ranker-tuning.md). |
| **TMDB matcher** | `Core/Tmdb` | Resolves `tmdbId`/`imdbId`, poster, backdrop, overview, runtime; caches aggressively; groups releases under the resolved work. No key → lookups no-op to null so search still works. |
| **NZB streaming core** (embedded nzbdav) | `Usenet/Nntp`, `Usenet/Nzb`, `Usenet/Rar` | NNTP pool, yEnc, NZB parse, RAR/7z random access, seeking, bounded read-ahead. The SABnzbd API / queue / WebDAV parts of nzbdav are dropped — we expose HTTP+Range directly. |
| **Health checker** | `Core/Media` (`HealthChecker`) | STAT-samples the *media file's* segments (223 present / 430 missing), classifies `ready`/`degraded`/`dead` per `HealthCheck.*` config. |
| **Session manager** | `Server/Services` (`SessionManager`) | A resolve opens a session (segment index, TTL); a stream token maps to a session; close tears it down. Sweeps expired sessions. |
| **Health cache** (new in M7) | `Core/Media` (`ReleaseHealthCache`) | Remembers dead classifications for `HealthCacheTtlSeconds` so they demote/reject the release on later searches and are skipped in fallback. |
| **Config store** | `Server/Config` | SQLite-backed CRUD of indexers, providers, profiles, general config, API keys. Secrets encrypted at rest via ASP.NET Data Protection. |
| **Watch-event store** | `Server/Config` (`WatchEventService`) | Ingests playback events from any front-end into SQLite. Not user-facing in v1; future-proofing. |

---

## 4. The request lifecycle: search → resolve → stream

Two paths run over the identical API. The only difference is who the client is.

### 4.1 Headless path (Management UI, or any future client)

1. **Search.** `GET /api/v1/search?q=…` → the Core fans out to indexers, parses and
   ranks releases, rejects the bad ones, aggregates to **works** (one movie/episode
   with N alternative releases), enriches via TMDB. Returns works with ranked
   releases. `nzbUrl` and indexer keys never cross the wire.
2. **Resolve.** `POST /api/v1/resolve { releaseId }` → the Core fetches the NZB,
   identifies the primary media file (unwrapping RAR), STAT-samples its segments,
   opens a session, and **ffprobes the stream server-side** so the client gets
   pre-probed `mediaStreams` + `runTimeTicks` and never has to probe a slow remote
   source (BRIEF §11). Returns `status` (`ready`/`degraded`/`dead`), a `streamUrl`,
   and the media info.
3. **Stream.** `GET /api/v1/stream/{token}` → a plain, capability-authorized,
   Range-capable byte stream. Resolve creates a short-lived random session capability,
   so the UI's `<video>` element needs no reusable bearer credential in its URL or
   headers. The endpoint does not accept `access_token` query auth, an admin JWT, or a
   machine key.
4. **Events / close.** The client reports `start`/`progress`/`stop` to
   `POST /api/v1/events`; `POST /api/v1/sessions/{token}/close` tears the session down.

### 4.2 Jellyfin path (BRIEF §5)

The same three calls, wrapped by the plugin's translation to Jellyfin's data model:

1. User types a query in any Jellyfin client.
2. The plugin's `IAsyncActionFilter` intercepts the `/Items?searchTerm=` /
   `/Search/Hints` request (under a short deadline) and calls `GET /api/v1/search`.
3. It materializes **one isolated ephemeral item per work** (private, hidden
   implementation folder; stable GUID from `workId`;
   `Tmdb`/`Imdb`/`UsenetWorkId` provider ids; TMDB metadata passed through; tagged
   `usenet-ephemeral`), caches the ranked release list, and merges eligible items into
   the outgoing response. The requesting user's compatible-library visibility policy
   still applies. **Any error/timeout falls through to native search** (BRIEF §11).
4. Play → Jellyfin requests `PlaybackInfo`. The plugin's `IMediaSourceProvider`
   returns one `MediaSourceInfo` per release (`RequiresOpening = true`,
   opaque, bounded, short-lived, one-use `OpenToken` tied to that authenticated user,
   item, work, and offered release). **No Usenet contact yet.**
5. `OpenMediaSource(openToken)` consumes and validates the offer, then calls
   `POST /api/v1/resolve`. It accepts only a server-attributed release from the same
   offered work. On `ready` it returns
   `MediaSourceInfo { Path = streamUrl, Protocol = Http, IsRemote = true,
   RequiresClosing = true, MediaStreams = <pre-probed>, RunTimeTicks,
   low AnalyzeDurationMs }` with no reusable `RequiredHttpHeaders` credential.
6. Jellyfin streams via ffmpeg (Direct Play or transcode). The plugin reports playback
   events to `POST /api/v1/events`.
7. `ILiveStream.Close` → `POST /api/v1/sessions/{token}/close`. An `IScheduledTask`
   deletes ephemeral items past their TTL.

The version-fragile coupling (steps 2–4) is isolated to single files and pinned to
Jellyfin 10.11.11 — see [`jellyfin-compatibility.md`](./jellyfin-compatibility.md).

---

## 5. The hardening layer (M7)

Dead releases are the default failure mode when you have no `*arr` stack curating a
library. M7 makes the streaming path survive them, and survive contention.

### 5.1 Global NNTP connection budget

Every NNTP command in the process passes through **one** shared gate: a
`PrioritizedSemaphore` inside `SemaphoreNntpGate`, sized to
`Streamarr:ConnectionBudget` (default 20). It is wired once in the bootstrap as a
`GatedNntpClient` wrapping the provider pool, so it caps concurrent NNTP commands
**across all sessions**, not per session (BRIEF §6.1 module 6, §11).

Priority matters: `BODY`/`ARTICLE` (playback) acquire at **High**, while
`STAT`/`HEAD`/`DATE` (health checks) acquire at **Low**, so a burst of health checks
can never starve active playback. The gate is held for a command's *true* connection
occupancy — for `BODY`/`ARTICLE` that includes the background body download, released
via the inner client's `onConnectionReadyAgain` callback, not when the method returns.

This is integration-tested:
`GlobalBudget_IsNeverExceeded_UnderTwoConcurrentStreams_AndBothProgress` asserts the
mock NNTP server never sees more concurrent connections than the budget while both
streams make progress. See [`m7-cache-loadtest.md`](./m7-cache-loadtest.md).

### 5.2 Provider failover (block-account backfill)

`MultiProviderNntpClient` fans each command over a **priority-ordered** provider list
(DECISIONS.md #6: the pool was written against a provider list from M1, so failover is
additive). For any segment, a `430 no-article-with-that-message-id` or a provider
error transparently fails over to the next-priority provider — this is how a block /
backup account backfills the primary per-segment.

`ProviderCircuitBreaker` protects the pool from a sick provider: **3 consecutive
failures trip it**, opening a cooldown (60 s initial, doubling to a **5-minute cap**).
While tripped the provider is skipped; when the cooldown expires a **single probe** is
allowed — success resets the breaker, failure re-trips with the doubled cooldown. The
ordering always returns at least one provider so a probe can fire even when all are
tripped. `/api/v1/metrics` exposes per-provider `tripped` state.

### 5.3 Auto-fallback + the health-cache feedback loop

This is the closed loop that makes "every third click fails" not happen.

```
   POST /resolve (releaseId, autoFallback=true default)
        │
        ▼
   ResolveSingle ─── health = dead? ──no──▶ return ready/degraded + session
        │ yes                                (record healthy in health cache too)
        ▼
   healthCache.Record(releaseId, Dead)        ← deadness is now remembered
        │
        ▼
   releaseStore.FindFallback(workId, current) ← next-best ranked release,
        │                                         skipping cached-dead ones
        ├── none / hops ≥ MaxFallbackHops ──▶ return dead + suggestedFallbackReleaseId
        ▼
   retry next release  (hop++, bounded by Streamarr:MaxFallbackHops, default 3)
```

- **Auto-fallback** (`ResolveService`): a release that resolves `dead` transparently
  retries the next-best release of the same work, bounded by
  `Streamarr:MaxFallbackHops` (default 3) and cycle-guarded. The response carries the
  full `attempts` trail (`{releaseId, status}` each), `fallbackFromReleaseId` (the
  originally-requested id when the returned release came via fallback), and — when
  auto-fallback is disabled or exhausted — `suggestedFallbackReleaseId` for a manual
  retry. The request's `autoFallback` bool (default `true`) opts out.
- **Health cache** (`ReleaseHealthCache`, TTL `Streamarr:HealthCacheTtlSeconds`,
  default 1800 s): the dead classification is remembered even across re-searches that
  re-register the release fresh from the indexer. It **demotes/rejects** the release in
  ranking (the `dead-on-usenet` rejection) and is **skipped** in fallback selection.
  This is precisely "feed deadness back into ranking" (BRIEF §6.1 module 5, §7.2).
  Healthy classifications are cached too, so search can prefer proven-good releases.

Because the Core does all of this server-side, the Jellyfin plugin's own manual
single-hop fallback (BRIEF §8.4) is now a **backstop** — the Core has usually already
walked the release list before the plugin ever sees a dead result.

---

## 6. Observability

Structured logging and metrics are first-class (BRIEF §10-M7):

- **Serilog** replaces the default logger in the bootstrap: structured console output,
  `LogContext` enrichment, and `UseSerilogRequestLogging()` for a **single summary
  line per request** (method, path, status, elapsed).
- **`GET /api/v1/metrics`** (admin-only JSON, like session listing) returns
  a live snapshot:
  - `sessions` — `active`, `openedTotal`, `closedTotal`
  - `connections` — `budget`, `inUse`, and per-provider
    `live/active/idle/available` connections plus `tripped`
  - `bytesServedTotal` — cumulative bytes streamed
  - `resolves` — `total` and `viaFallback`
  - `searchCache` — `entries`, `hits`, `misses`, `hitRate`
  - `indexers[]` — per-indexer `requests`, `failures`, `lastLatencyMs`, `avgLatencyMs`

The Management UI's Dashboard renders these (health cards, connections-vs-budget,
Recharts throughput). Field-by-field breakdown is in [`api.md`](./api.md).

---

## 7. Persistence

SQLite via EF Core (BRIEF §4), one database file (`streamarr.db` by default; override
with `Streamarr:ConnectionString`). It holds config (indexers, providers, general),
quality profiles, API keys, admin users, and watch events. Migrations run and the
persisted config is overlaid onto the running options at startup, before any
config-derived singleton resolves.

**Secrets** (provider passwords, indexer API keys, TMDB key) are encrypted at rest via
ASP.NET Data Protection (key ring under `Streamarr:DataProtectionKeysPath`) and are
**never returned in plaintext** by the config API — reads return a masked value and a
`has…` boolean; writes are omit-to-keep. Sessions and the search/health caches are
in-memory, not persisted (a restart drops live streams, by design).

---

## 8. How a future client fits

The whole point of the mandate (§1) is that this section is short.

A custom web app, an RN/Expo app, or a TV app is **just another `/api/v1` client**. It
authenticates operations with a machine API key (or grows the admin session model into
real multi-user), calls `search`/`resolve`/`events`, then consumes the returned
stream-session capability without carrying the reusable credential into the media
request. It generates its types from the same
[`openapi/v1.json`](../server/openapi/v1.json). Watch state already
accumulates server-side via `/events`, so it is not trapped in any one front-end.

The one capability Jellyfin gives us for free that a future client must replace is
**transcoding**. `/stream` is deliberately a clean, generic, capability-authorized
HTTP+Range byte source with **no Jellyfin-specific behavior** (BRIEF §3.3) — so an ffmpeg-based
transcode/remux service can be inserted **in front of** `/stream` without touching the
Core. Preserving that property is a non-negotiable: never add device-profile or
container-negotiation logic to the stream endpoint.

| Jellyfin gives us for free | Future client's plan |
|---|---|
| Transcoding / remux, device profiles | ffmpeg transcode layer **in front of** `/stream`; the Core stays generic. |
| Client apps (TV, mobile, cast) | Generate from the OpenAPI spec; the generated client is the on-ramp. |
| Watch state, resume, favorites | **Already mitigated:** `/events` accumulates watch state server-side. |
| Metadata & artwork | **Already ours** (TMDB). Never rely on Jellyfin's fetcher. |
| User management & auth | Core admin auth is designed to grow into multi-user. |

---

## See also

- [`api.md`](./api.md) — the `/api/v1` contract, endpoint by endpoint.
- [`ranker-tuning.md`](./ranker-tuning.md) — the parse → reject → rank pipeline and
  quality-profile knobs.
- [`setup.md`](./setup.md) — operator setup, the config reference, and the dev stack.
- [`jellyfin-compatibility.md`](./jellyfin-compatibility.md) — the pinned Jellyfin
  version and the isolated, version-fragile coupling.
- [`m1-latency.md`](./m1-latency.md) · [`m5-acceptance.md`](./m5-acceptance.md) ·
  [`m7-cache-loadtest.md`](./m7-cache-loadtest.md) — milestone measurements and
  acceptance.
