# Streamarr

**Search and stream Usenet content on demand — no download, no watch, no delete.**

Streamarr is a self-hosted service that searches Usenet indexers, picks the best
release, verifies it is actually still available, and streams it directly from your
Usenet provider as a seekable HTTP byte stream. Nothing is written to disk.

The name is a nod, not a dependency: Streamarr **replaces** the parts of the `*arr`
stack that matter for streaming — Prowlarr's indexer search and Radarr's release
selection — and throws away everything that exists only to manage files. No Sonarr,
no Radarr, no Prowlarr, no rclone, no WebDAV mount.

Jellyfin is supported as the first front-end — it gives us clients on every platform
and solves transcoding — but **Jellyfin is a consumer of this system, not the centre
of it.** See [Architecture](#architecture).

---

## Status

Pre-alpha. Nothing here is stable yet.

| Milestone | Scope | Status |
|---|---|---|
| M1 | Streaming core (NNTP → yEnc → RAR random access → HTTP+Range) | ☑ |
| M2 | Indexer search, release parsing, ranking, rejection, TMDB matching | ☑ |
| M3 | Frozen `/api/v1`, OpenAPI spec, config API, auth | ☑ |
| M4 | Management Web UI (React 19) | ☑ |
| M5 | Jellyfin plugin — playback thin-slice | ☑ |
| M6 | Jellyfin plugin — search interception + TTL cleanup | ☐ |
| M7 | Hardening — dead-release fallback, connection budget, metrics | ☐ |

---

## Architecture

Three components. The important part is the relationship between them.

```
                    ┌──────────────────────────────────────────────┐
                    │        STREAMARR CORE  (the product)         │
                    │                                              │
  ┌─ Jellyfin ────┐ │  /api/v1                                     │
  │ (UI + trans-  │ │   search   indexer fan-out, parse, reject,   │
  │  coding, v1)  │◀┼──▶         rank, TMDB match, aggregate       │
  │               │ │   resolve  fetch NZB, health-check, open     │
  │ Plugin =      │ │            session, probe media info         │
  │ THIN ADAPTER  │ │   stream   HTTP + Range byte stream          │
  │               │ │   config   indexers, providers, profiles     │
  │               │ │   sessions live sessions, metrics            │
  │               │ │   events   playback start/progress/stop      │
  └───────────────┘ │                                              │
                    │  OpenAPI spec ──── generated clients ───────┐│
  ┌─ Management ──┐ │                                             ││
  │ Web UI        │◀┼─────────────────────────────────────────────┘│
  │ React 19      │ │  SQLite: config, profiles, cache, watch state│
  └───────────────┘ └──────────────────────────────────────────────┘
                                        ▲
  ┌─ FUTURE: custom web / React Native / TV client ─┘
    (same OpenAPI contract)
```

### The rule that governs everything

> **All domain logic lives in Streamarr Core. The Jellyfin plugin contains zero
> business logic. Jellyfin types never appear in the Core.**

Searching, parsing, ranking, rejecting, TMDB matching, health checking, session
management and watch state are **Core** concerns. The plugin only translates between
our interface-agnostic API and Jellyfin's data model (`BaseItem`, `MediaSourceInfo`,
action filters).

This is not architectural purity for its own sake — **Jellyfin is step 1, not the
destination.** A custom web app, a React Native client, or a TV app must be able to
sit on top of the same API later without rewriting the Core.

**The Management UI is the continuous test of this.** It talks only to the public API
and can search, resolve, and *play a stream preview in the browser* **with Jellyfin
not running at all.** If that ever breaks, the abstraction has leaked — treat it as a
build failure, not a UI bug.

### What Jellyfin gives us for free today

Named explicitly, so we don't accidentally build hard dependencies on them:

| Capability | Owner in v1 | Plan |
|---|---|---|
| Transcoding, device profiles | Jellyfin | `/stream` stays a generic HTTP+Range source so an ffmpeg transcode layer can be inserted in front of it later. |
| Clients (TV, mobile, cast) | Jellyfin | Generated API clients are the on-ramp for our own. |
| Watch state, resume positions | Jellyfin | **Mitigated:** the plugin reports playback events to `/api/v1/events` from day one, so watch state is not trapped in Jellyfin's DB. |
| Metadata & artwork | **Streamarr Core (TMDB)** | Already ours. We do *not* rely on Jellyfin's metadata fetcher for our items. |
| User management | Jellyfin (playback) / Core (admin) | The Core's user model is designed to grow into full multi-user. |

---

## Repository layout

```
core/       ASP.NET Core service (.NET 8) — the product
            ├── indexers/    Newznab fan-out
            ├── parsing/     release-name parser + test corpus
            ├── ranking/     quality profiles, scoring, rejection rules
            ├── usenet/      embedded nzbdav core: NNTP pool, yEnc, RAR random access
            ├── sessions/    resolve → session → stream lifecycle
            └── api/         /api/v1 + OpenAPI

plugin/     Jellyfin plugin (.NET 8) — thin adapter, no business logic

web/        Management UI — React 19, TanStack Query, Vite, Tailwind + shadcn/ui
            API client generated from the OpenAPI spec (CI fails on drift)

docs/       Architecture, API contract, setup, ranker tuning
```

---

## Quick start

```bash
git clone <repo> && cd streamarr
cp .env.example .env      # set admin password + a machine API key
docker compose up -d
```

Open the Management UI at `http://localhost:8080` and configure, in this order:

1. **Usenet provider** — host, port, SSL, credentials, max connections. Hit *Test*.
2. **Indexers** — Newznab base URL + API key per indexer. Hit *Test*.
3. **TMDB API key** — under Settings.
4. **Quality profile** — or start from the default and tune it later in the
   Search/Debug playground.

Verify end to end **before touching Jellyfin**: run a search in the Debug playground,
resolve a release, and hit *Preview* to play it in the browser. If that works, the
Core is sound.

### Adding Jellyfin

1. Build the plugin (`dotnet build plugin/ -c Release`) and drop the `.dll` into
   Jellyfin's plugin directory (`docker-compose.dev.yml` mounts it for you).
2. In Jellyfin's dashboard, open the Streamarr plugin config, set the Core URL and
   machine API key, and hit *Test connection*.
3. Enable search interception.

Usenet results now appear alongside your local library and play through Jellyfin's
normal transcoding pipeline.

---

## Development

### Core
```bash
cd server
dotnet run --project src/Streamarr.Server   # OpenAPI spec at /openapi/v1.json, Swagger UI at /swagger (dev)
dotnet test                                 # parser corpus, ranker ordering, auth, streaming tests

# Re-freeze the OpenAPI contract after an API change (CI fails on drift):
scripts/freeze-openapi.sh
```

On first run with an empty users table, an admin account is bootstrapped: from
`STREAMARR_ADMIN_PASSWORD` / `Streamarr:Admin:Password` if set, otherwise a random
password is generated and logged **once**. Machine clients authenticate with a static
`Streamarr:ApiKey` or a key minted via `POST /api/v1/config/apikeys`.

### Management UI
```bash
cd web
npm install
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts (checked in; CI fails on drift)
npm run dev            # Vite dev server on :5173, proxying /api + /openapi to the Core Server
npm test               # Vitest + Testing Library
npm run build          # type-check + production SPA build → web/dist
```

Dev serves the SPA on Vite (proxy to `http://localhost:5199` by default, override with
`STREAMARR_SERVER_ORIGIN`). **Production is single-origin:** copy `web/dist/*` into the
Core Server's `wwwroot/` and it serves the SPA as static files with an SPA fallback
(`UseStreamarrServer`), while `/api` and `/openapi` keep their own behavior.

`npm run generate:api` is checked in CI — a stale generated client fails the build.
Never hand-write API types. See `web/README.md` for the router + codegen rationale.

**Shipped in M4a:** login + admin JWT auth, auth guard, app shell (sidebar for every
§9.1 view, dark-mode toggle, responsive to tablet), and the Settings view (general
config, machine API keys, password change).

**Shipped in M4b:** the Indexers view (CRUD, per-indexer Test surfacing caps + latency,
enable/disable toggle, priority ordering), the Usenet Providers view (CRUD with
host/port/SSL/credentials/max-connections/priority, Test connection showing the auth
result + achievable connections, write-only secrets), and the Quality Profiles view
(full editor for weights, preferred resolutions/sources/codecs/languages, group
allow/deny, size bands, rejection rules) with a **live preview** that runs a sample
query through `POST /debug/search` using the unsaved draft profile to show how it
reorders results before saving. All views use TanStack Query mutations with
invalidation + optimistic updates and render the typed error envelope as toasts +
inline errors.

**Shipped in M4c (M4 complete):** the **Search / Debug playground** (query form →
`POST /debug/search`, a table of *every* release incl. rejected ones with raw name,
parsed fields, per-rule score breakdown, plain-language rejection reasons, indexer,
size, age, grabs; client-side filter/sort; a per-release **Resolve** button showing
the health-check outcome + pre-probed media info), the **Playback preview** — the
**architectural canary** (BRIEF §3.1 rule 4): it direct-plays a resolved stream in a
plain HTML5 `<video>` with Jellyfin absent, instrumenting time-to-first-frame and
seek latency; because a `<video>` element cannot set an `Authorization` header, the
bearer token rides as an `access_token` query parameter that `/stream` accepts
(scoped to the stream path, the mechanism Jellyfin itself uses) — the endpoint stays a
generic, authenticated, Range-capable byte source — the **Sessions** view (live list
via `refetchInterval`: release, bytes served, NNTP connections, source, force-close),
and the full **Dashboard** (health cards per-indexer/per-provider, live session count,
NNTP connections vs the configured budget, a live Recharts throughput chart, and
recent resolves with health outcomes).

**Shipped in M4d (M4 acceptance):** the web test suite. **Vitest + Testing Library**
component tests cover the two logic-heavy views — the Quality Profiles editor (built-in
read-only guard, live-preview ranked ordering, and edited-draft weights flowing into
the `POST /debug/search` re-rank) and the Search/Debug table (lists rejected releases
with reasons, the *show rejected* filter, name filter, sort re-ordering, breakdown-row
expansion, and resolve → health outcome + media info). A **Playwright smoke E2E**
(`web/e2e/smoke.spec.ts`) drives the real Core Server — booted by the
`Streamarr.E2E.Harness` launcher against an **in-process mock NNTP server + canned
indexer/TMDB fixtures + seeded admin**, serving the built SPA at a single origin — from
**login → add indexer → search → resolve → preview-play**, asserting the `<video>`
reaches `readyState ≥ 2` and `currentTime` advances **with Jellyfin absent** — the
live proof of BRIEF §3.1 rule 4. The mock media is a real WebM (VP8 + Opus) generated
with ffmpeg so the bundled Chromium can decode it. `web` (build + typecheck + Vitest),
`e2e` (Playwright), and `api-drift` (spec/client staleness) all run in
`.github/workflows/ci.yml`.

**Shipped in M5 (Jellyfin playback thin-slice):** the `plugin/` Jellyfin plugin, built
from the official template shape against **Jellyfin 10.10.7** (`Jellyfin.Controller`
pinned; ABI recorded in `docs/jellyfin-compatibility.md`). A deliberately **minimal
config page** (server URL, API key, TTL, interception toggle, profile id, pinned query)
with **Test connection** (`/api/v1/health`) and **Materialize pinned work** buttons; an
`IPluginServiceRegistrator` wiring a typed `HttpClient` over the Core Server API; the M5
**bootstrap path** that materializes **one** isolated ephemeral `Movie` (dedicated
"Streamarr (Usenet)" folder, tag `usenet-ephemeral`, stable GUID from `workId`, TMDB
metadata passed through) via a "sync one pinned work" scheduled task / config button; an
**`IMediaSourceProvider`** exposing one `MediaSourceInfo` **per release** (`RequiresOpening`,
`OpenToken = releaseId`, no Usenet contact) whose `OpenMediaSource` calls `POST /resolve`
→ HTTP `Path` + pre-probed `MediaStreams`/`RunTimeTicks` + bearer `RequiredHttpHeaders` +
low `AnalyzeDurationMs`, following the server's `suggestedFallbackReleaseId` once on a
dead release; `ILiveStream.Close` → `POST /sessions/{token}/close`; and playback
`start`/`progress`/`stop` reported to `POST /api/v1/events`. **Zero domain logic —
translation only** (BRIEF §11), pinned by mapper/store/tracker unit tests. Jellyfin
(docker) **loads the plugin with zero errors**. `docker-compose.dev.yml` (Jellyfin +
Core Server + optional Vite) and `server/Dockerfile` (multi-stage SPA → .NET → ffmpeg
runtime) round out the dev stack. Manual Direct-Play/transcode acceptance is in
`docs/m5-acceptance.md`.

### Jellyfin plugin
```bash
cd plugin
dotnet build -c Release
```

The plugin is **pinned to a specific Jellyfin version** (see
`docs/jellyfin-compatibility.md`). Search interception hooks an ASP.NET
`ActionFilter` onto Jellyfin's item-query endpoint and is inherently
version-sensitive — expect to re-test on every Jellyfin release.

---

## Why no `*arr` stack?

Sonarr/Radarr/Prowlarr exist largely to *manage files*: grab, rename, organise,
populate a library folder. Streamarr deletes that entire step, so most of the stack
becomes dead weight. But three things those tools do quietly still have to happen —
and Streamarr does them itself:

1. **Indexer search** (Prowlarr's job) — straightforward; Newznab is a simple API.
2. **Release selection** (Radarr's real job, and the one people underestimate) — a
   single search returns dozens of releases: wrong resolutions, fakes, samples,
   password-protected archives, incomplete or DMCA'd uploads. Parsing, ranking and
   rejecting them is the difference between *"feels like streaming"* and *"every
   third click fails."*
3. **Availability** — Usenet articles disappear. Every release is health-checked via
   NNTP `STAT` before playback, and a dead release automatically falls back to the
   next-best one.

The Search/Debug playground in the Management UI exists precisely for this: it shows
every release *including the rejected ones*, with parsed fields, the score breakdown
per rule, and the rejection reason. Tune the ranker there, not in the dark.

---

## Licensing

**Decision (2026-07-12, see `docs/DECISIONS.md`):**

- [ ] **Clean-room** — parsing/ranking is original code, informed by studying
      Radarr/Sonarr's *design* but copying none of it.
- [x] **GPL-3.0 accepted** — Radarr/Sonarr code may be reused (with per-file
      attribution); the entire project is licensed **GPL-3.0** (see `LICENSE`).

This matters: **Radarr and Sonarr are GPL-3.0.** Copying their parser regexes,
quality definitions, or custom-format logic makes Streamarr a GPL-3.0 derivative.

| Component | License | Note |
|---|---|---|
| `server/` | **GPL-3.0** | Ports Radarr/Sonarr parsing & ranking code with attribution. |
| `plugin/` | GPL-2.0-compatible | Links Jellyfin assemblies; normal for Jellyfin plugins. Keeping it a thin adapter also keeps this licensing boundary clean. |
| `web/` | **GPL-3.0** | |
| Embedded [nzbdav](https://github.com/nzbdav-dev/nzbdav) core | **MIT** | Vendored with attribution. Source of the NNTP/yEnc/RAR streaming primitives. |

---

## Attribution

- **[nzbdav](https://github.com/nzbdav-dev/nzbdav)** (MIT) — the Usenet streaming
  core. Streamarr embeds it directly and drops the parts that exist only to serve an
  `*arr` stack (SABnzbd-compatible API, queue/history emulation, WebDAV server).
- **[Jellyfin](https://jellyfin.org)** — the media server we ride on for v1.
- **[jellyfin-plugin-meilisearch](https://github.com/arnesacnussem/jellyfin-plugin-meilisearch)**
  — reference for intercepting Jellyfin's search via an `ActionFilter`.
- **Radarr / Sonarr** — studied for the *design* of release parsing and quality
  ranking. See [Licensing](#licensing) regarding code reuse.

---

## Known limitations

- **Search interception is version-fragile.** It couples to Jellyfin's item-query
  endpoint. Pinned and integration-tested against one version; re-test on upgrades.
  It sits behind a config toggle and falls back to native search on any error — a
  broken filter must never break your normal library search.
- **Cold-start and seek latency** depend on your Usenet provider, the release's RAR
  layering, and the segment cache. Measure it (M1 records baselines); it is the
  single biggest UX variable.
- **Ephemeral items** live in an isolated, TTL-cleaned virtual folder, excluded from
  *Latest* and recommendations, so they never pollute your real library. They are not
  permanent — they are search results.
- **No torrents.** Usenet/NZB only.
- **No subtitle search** yet; Jellyfin's own subtitle plugins still work for its
  items.

---

## Security

- Every endpoint requires authentication. `/stream` is **never** public — the token
  is unguessable *and* the request must be authenticated.
- Two auth modes: machine API keys (plugin, future headless clients) and an admin
  session for the Management UI.
- Secrets (provider passwords, indexer keys) are encrypted at rest and never returned
  in plaintext by the config API.
- nzbdav had a patched auth-bypass in versions 0.2.46–0.6.1. Keep the embedded core
  current, and put Streamarr behind a VPN or SSO if it is internet-facing.

Report vulnerabilities privately — see `SECURITY.md`.

---

## Legal

**Streamarr is intended for use with legally obtained content only.** The maintainers
do not condone copyright infringement and will not provide support for it. Whether a
given use is lawful depends on the content and your jurisdiction; that assessment is
yours to make, and worth taking seriously before deploying this.

---

## Contributing

See `CONTRIBUTING.md`. Two rules matter more than the rest:

1. **No domain logic in the plugin. No Jellyfin types in the Core.**
2. **The Management UI must be able to search, resolve and preview-play with Jellyfin
   absent.** If your change breaks that, it is not done.
