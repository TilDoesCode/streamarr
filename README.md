# Streamarr

**Search and stream Usenet content on demand — no download, no watch, no delete.**

## Install at home (release build)

> **Already running [Komodo](https://komo.do) with a Jellyfin server?** Skip the manual
> steps below and follow the copy‑paste guide in
> **[docs/install-komodo.md](docs/install-komodo.md)** — one stack to paste, then install
> the plugin into Jellyfin from a URL. No compiling, no file copying.

The supported home deployment is Docker Compose on a 64-bit Intel/AMD or ARM Linux
host. A release contains everything specific to Streamarr; Docker downloads the base
images. You need Docker Engine with the Compose plugin, `curl`, `tar`, and `openssl`.
Real playback also requires a Usenet provider, a Newznab-compatible indexer, and
optionally a TMDB v3 API key or API Read Access Token.

Each GitHub release publishes these matching artifacts:

| Artifact | What it contains |
|---|---|
| `ghcr.io/tildoescode/streamarr:<version>` | Multi-architecture Core Server image with the production Management UI and `ffprobe` included (`linux/amd64`, `linux/arm64`) |
| `streamarr-home-<version>.tar.gz` | Ready-to-run production Compose file, pinned image version, environment template, and matching Jellyfin plugin |
| `streamarr-jellyfin-<version>.zip` | Standalone plugin for an existing Jellyfin 10.11.11 server (also installable from the plugin catalog — see below) |
| `SHA256SUMS` | Checksums for both downloadable archives |

### 1. Download and verify a release

Choose a release version from [GitHub Releases](https://github.com/TilDoesCode/streamarr/releases),
then run the following on the home server (the example shows the initial release):

```bash
VERSION=0.3.0
mkdir -p "$HOME/streamarr" && cd "$HOME/streamarr"
curl -fLO "https://github.com/TilDoesCode/streamarr/releases/download/v${VERSION}/streamarr-home-${VERSION}.tar.gz"
curl -fLO "https://github.com/TilDoesCode/streamarr/releases/download/v${VERSION}/SHA256SUMS"

# Linux:
grep "streamarr-home-${VERSION}.tar.gz" SHA256SUMS | sha256sum --check -
# macOS instead: grep "streamarr-home-${VERSION}.tar.gz" SHA256SUMS | shasum -a 256 --check -

tar -xzf "streamarr-home-${VERSION}.tar.gz"
```

When the repository is public, the release workflow also signs build-provenance
attestations. If you use GitHub CLI, you can then additionally verify the archive with
`gh attestation verify streamarr-home-${VERSION}.tar.gz --repo TilDoesCode/streamarr`.

### 2. Create the private configuration

```bash
cp .env.example .env
openssl rand -hex 32   # generate the admin password
openssl rand -hex 32   # generate a different machine API key
${EDITOR:-vi} .env
chmod 600 .env
```

Paste the two generated values into `STREAMARR_ADMIN_PASSWORD` and
`STREAMARR_API_KEY`. Keep the values different. The admin password is used only for
the Management UI; the machine key is used by Jellyfin. Compose refuses to start if
either is empty.

The default bind address is `127.0.0.1`, which is appropriate when a reverse proxy runs
on the same server. For direct access only from a trusted home LAN, set
`STREAMARR_BIND_ADDRESS` to the server's private LAN address (for example
`192.168.1.20`) and allow port 8080 only from the LAN in the host firewall. Do not
publish Streamarr directly to the internet.

### 3. Start Streamarr Core

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 streamarr
```

Wait until `docker compose ps` reports `healthy`, then open
`http://<configured-address>:8080`. The Core container includes the API and Management
UI, runs as a non-root user with no Linux capabilities and a read-only root filesystem,
and persists only its SQLite database and Data Protection key ring in named volumes.

For a reverse proxy on the same host, proxy HTTPS to `127.0.0.1:8080`. If the proxy is
in another container or on another machine, set `STREAMARR_TRUSTED_PROXY` to its exact
source IP, set `STREAMARR_TRUSTED_ORIGIN` to the browser-visible origin (such as
`https://streamarr.home.example`), and uncomment the `COMPOSE_FILE` line in `.env` to
enable the supplied proxy overlay. Never configure a whole subnet as a trusted proxy.

To route only indexer-originated traffic through Gluetun, enable Gluetun's HTTP proxy
and set `INDEXER_PROXY=http://gluetun:8888` in `.env` (both services must share a Docker
network). Newznab searches, capability tests, and NZB retrieval use it explicitly;
TMDB metadata and NNTP media traffic stay direct. A configured proxy fails closed—
Streamarr does not silently retry those requests outside the VPN.

### 4. Add Jellyfin

You can start a clean, matching Jellyfin 10.11.11 container from the same bundle:

```bash
# On Linux, first set JELLYFIN_UID/GID in .env to the output of id -u / id -g.
docker compose --profile jellyfin up -d
```

It listens on the configured Jellyfin address/port (loopback port 8096 by default) and
already mounts the bundled plugin. Complete Jellyfin's setup wizard, then open
**Dashboard → Plugins → Streamarr**.

For an existing Jellyfin 10.11.11 installation, the easiest option is Jellyfin's own
plugin catalog: in **Dashboard → Plugins → Repositories** add
`https://raw.githubusercontent.com/TilDoesCode/streamarr/main/manifest.json`, then
install **Streamarr** from **Catalog** and restart Jellyfin. It auto-updates from there.
(Komodo users: the full walkthrough is in [docs/install-komodo.md](docs/install-komodo.md).)
To install by hand instead, stop Jellyfin, copy every file from the bundle's `plugin/`
directory into its writable `<jellyfin-config>/plugins/Streamarr/` directory, and start
Jellyfin again. Do not mix plugin and Core versions. The plugin is ABI-pinned to
Jellyfin 10.11.11; upgrade Jellyfin only after the compatibility document names the new
version.

In the plugin settings, use:

- Core URL `http://streamarr:8080` for the bundled Jellyfin container.
- Core URL `http://127.0.0.1:8080` for a native Jellyfin process on the same host.
- The home server's private URL for Jellyfin on another host/container network.
- **Public stream URL:** the HTTPS reverse-proxy or private-LAN base URL that phones,
  TVs, and browsers can reach (for example `https://streamarr.home.example`). This is
  required when the Core URL is a container-only hostname such as `streamarr`; leave it
  blank only when the Core URL itself is reachable from every playback device.
- The exact `STREAMARR_API_KEY` from `.env`, then **Test connection** and enable search
  interception.

### 5. Configure and prove real playback

In the Streamarr Management UI, configure a Usenet provider, an indexer, a TMDB credential,
and a quality profile—in that order. Use each connection's **Test** action. Before
involving Jellyfin, use **Search → Release diagnostics → Resolve → Preview** and confirm
the video plays and seeks in the browser. This proves indexer search, NZB retrieval,
NNTP, RAR/yEnc handling, and HTTP Range streaming end to end.

### Operate, upgrade, back up, and remove

```bash
# Status and logs
docker compose ps
docker compose logs -f --tail=200 streamarr

# Upgrade after extracting a newer home bundle; keep your existing .env
docker compose pull
docker compose up -d

# Stop without deleting persistent data
docker compose down

# Permanently remove containers AND all Streamarr/Jellyfin named volumes
docker compose --profile jellyfin down -v
```

Back up the `streamarr_streamarr-data` and `streamarr_streamarr-keys` Docker volumes
together while Streamarr is stopped; the database contains encrypted provider/indexer
secrets and the key volume is required to decrypt them. Keep the matching release
bundle and `.env` with the backup. To roll back, restore both volumes, restore the
matching plugin directory, set `STREAMARR_IMAGE` to the earlier version, and run
`docker compose up -d`.

One simple stopped-volume backup is:

```bash
docker compose down
mkdir -p backup
docker run --rm -v streamarr_streamarr-data:/source:ro -v "$PWD/backup:/backup" \
  alpine:3.22 tar -C /source -czf /backup/streamarr-data.tar.gz .
docker run --rm -v streamarr_streamarr-keys:/source:ro -v "$PWD/backup:/backup" \
  alpine:3.22 tar -C /source -czf /backup/streamarr-keys.tar.gz .
cp .env "backup/.env"
docker compose up -d
```

Store that backup somewhere other than the Docker host. Treat it as secret material.

The pipeline behind a release runs server, web, plugin, real Jellyfin host-load, API
drift, browser-to-stream E2E, production-container, archive, checksum, and both Compose
mode checks before it publishes the GitHub release and multi-architecture image.

---

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
| M6 | Jellyfin plugin — search interception + TTL cleanup | ☑ |
| M7 | Hardening — dead-release fallback, connection budget, metrics | ☑ |

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
server/     ASP.NET Core service (.NET 8) — the product
            ├── indexers/    Newznab fan-out
            ├── parsing/     release-name parser + test corpus
            ├── ranking/     quality profiles, scoring, rejection rules
            ├── usenet/      embedded nzbdav core: NNTP pool, yEnc, RAR random access
            ├── sessions/    resolve → session → stream lifecycle
            └── api/         /api/v1 + OpenAPI

plugin/     Jellyfin 10.11.11 plugin (.NET 9) — thin adapter, no business logic

web/        Management UI — React 19, TanStack Query, Vite, Tailwind + shadcn/ui
            API client generated from the OpenAPI spec (CI fails on drift)

docs/       Architecture, API contract, setup, ranker tuning
```

---

## Development quick start (build from source)

```bash
git clone <repo> && cd streamarr
cp .env.example .env      # set strong, unique admin + machine credentials
docker compose -f docker-compose.dev.yml up -d --build
```

Compose deliberately refuses to start while either credential in `.env` is empty.
All development ports bind to `127.0.0.1`; do not expose this stack directly to an
untrusted network.

Open the Management UI at `http://localhost:8080` and configure, in this order:

1. **Usenet provider** — host, port, SSL, credentials, max connections. Hit *Test*.
2. **Indexers** — Newznab base URL + API key per indexer. Hit *Test*.
3. **TMDB credential** — under Settings; either the short v3 API key or API Read Access Token.
4. **Quality profile** — or start from the default and tune it later under
   **Search → Release diagnostics**.

Verify end to end **before touching Jellyfin**: run a search in the Debug playground,
resolve a release, and hit *Preview* to play it in the browser. If that works, the
Core is sound.

### Adding Jellyfin

1. Build the plugin (`dotnet build plugin/ -c Release`) and drop the `.dll` into
   Jellyfin's plugin directory (`docker-compose.dev.yml` mounts it for you).
2. In Jellyfin's dashboard, open the Streamarr plugin config, set the Core URL and
   machine API key, and hit *Test connection*. The check combines the anonymous,
   shallow liveness endpoint with an authenticated capabilities request, so a wrong
   machine key cannot look healthy.
3. Enable search interception.

Usenet results now appear alongside your local library and play through Jellyfin's
normal transcoding pipeline. TV search returns series folders instead of arbitrary
episodes: seasons load when a series opens, and opening one season performs one
season-wide indexer search before displaying its complete episode directory.

### Security boundary

The container serves plain HTTP because TLS normally terminates at a trusted reverse
proxy or VPN ingress. For any non-loopback deployment, put Streamarr behind HTTPS and
forward only the required client/protocol headers. Set `Streamarr__TrustedProxies__0`
to the proxy's exact source IP when it is not on loopback; forwarded headers from other
addresses are ignored. Never publish port 8080 directly to the internet. Stream URLs
contain a short-lived, session-specific capability; they do not carry the admin JWT or
machine API key and should still be excluded from access logs where practical.

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

On first run with an empty users table, an admin account is bootstrapped from
`STREAMARR_ADMIN_PASSWORD` / `Streamarr:Admin:Password`. Outside Development this is
required and must be 12–1024 characters without control characters; only Development
may generate and log a random fallback once. Machine clients authenticate with a
static `Streamarr:ApiKey` or a key minted via `POST /api/v1/config/apikeys`. The static
key is optional, but when enabled it must be 32–4096 characters without whitespace or
control characters.

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

**Shipped in M4a:** login + HttpOnly admin-cookie auth (with bearer compatibility for
non-browser clients), auth guard, app shell (sidebar for every
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
seek latency; the resolved URL contains a short-lived, unguessable session capability,
so no admin JWT or machine key is placed in the media URL — the endpoint stays a
generic, capability-authorized, Range-capable byte source — the **Sessions** view (live list
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
from the official template shape against **Jellyfin 10.11.11** (`Jellyfin.Controller`
pinned; ABI recorded in `docs/jellyfin-compatibility.md`). A deliberately **minimal
config page** (server URL, API key, TTL, interception toggle, profile id, pinned query)
with **Test connection** (anonymous shallow `/api/v1/health` plus authenticated
`/api/v1/caps`) and **Materialize pinned work** buttons; an
`IPluginServiceRegistrator` wiring a typed `HttpClient` over the Core Server API; the M5
**bootstrap path** that materializes **one** isolated ephemeral `Movie` (private,
hidden implementation folder; tag `usenet-ephemeral`; stable GUID from `workId`; TMDB
metadata passed through) via a "sync one pinned work" scheduled task / config button; an
**`IMediaSourceProvider`** exposing one `MediaSourceInfo` **per release** (`RequiresOpening`,
an opaque, bounded, short-lived, one-use `OpenToken` tied to the authenticated Jellyfin
user, item, work, and offered release; no Usenet contact) whose `OpenMediaSource`
consumes that offer and calls `POST /resolve` → capability HTTP `Path` + pre-probed
`MediaStreams`/`RunTimeTicks` + low `AnalyzeDurationMs`, accepting only a server fallback
within the same offered work; no reusable credential or `RequiredHttpHeaders` is added
to the media source. `ILiveStream.Close` → `POST /sessions/{token}/close`; playback
`start`/`progress`/`stop` reported to `POST /api/v1/events`. **Zero domain logic —
translation only** (BRIEF §11), pinned by mapper/store/tracker unit tests. Jellyfin
(docker) **loads the plugin with zero errors**. `docker-compose.dev.yml` (Jellyfin +
Core Server + optional Vite) and `server/Dockerfile` (multi-stage SPA → .NET → ffmpeg
runtime) round out the dev stack. Manual Direct-Play/transcode acceptance is in
`docs/m5-acceptance.md`.

**Shipped in M6 (search interception + TTL cleanup):** an **`IAsyncActionFilter`**
(`plugin/Streamarr.Plugin/Search/StreamarrSearchActionFilter.cs`) registered into the MVC
pipeline via `Configure<MvcOptions>`. It intercepts `/Items` (when a `searchTerm` is
present) and `/Search/Hints`, dispatching on the **response value type**
(`QueryResult<BaseItemDto>` / `SearchHintResult`). Movies call `GET /api/v1/search` under
a **4s deadline**. TV injects at most three `Series` shells from `/tv/search`, then handles
Jellyfin's `/Shows/{id}/Seasons` and `/Shows/{id}/Episodes` navigation lazily: season
listing has no indexer cost; opening one season performs one fan-out and materializes its
complete canonical `Episode` directory. Stable GUIDs prevent duplicates; TMDB/IMDb and
`UsenetWorkId` provider ids, artwork, and ranked release offers are preserved. **Every path is behind the
config toggle and try/catch-guarded** — any error, timeout, or killed/unreachable Core
Server falls through to unmodified native results (BRIEF §8.2, §11), proven headlessly (both
endpoints return `200` with interception off *and* with the Core Server down). An
**`IScheduledTask`** (`EphemeralCleanupTask`, hourly) deletes plugin-owned
`usenet-ephemeral` items past
their TTL via `ILibraryManager`. The version-fragile HTTP-pipeline coupling is isolated to
the one filter file and documented as **known-fragile** in `docs/jellyfin-compatibility.md`
(BRIEF §13); the merge/dedup and TTL-expiry logic are host-free and unit-tested. Full
in-client injection + duplicate-free repeat + cleanup with real credentials is the manual
checklist in `docs/m5-acceptance.md`.

**Shipped in M7 (hardening — M7 complete):** the failure-mode hardening the brief calls
the default reality without an *arr stack. **Auto-fallback** — `POST /resolve` on a dead
release now transparently retries the next-best release of the same work, bounded by
`MaxFallbackHops` (default 3), and surfaces exactly what happened: the response carries an
`attempts` trail (`{releaseId, status}` per hop), `fallbackFromReleaseId`, and — when
auto-fallback is off (`autoFallback:false`) or exhausted — a `suggestedFallbackReleaseId`.
A new **`ReleaseHealthCache`** (TTL `HealthCacheTtlSeconds`, default 1800s) remembers dead
classifications and **feeds them back into ranking** — a release found dead on resolve is
rejected (`dead-on-usenet`) and demoted on later searches, and skipped as a fallback —
proven by unit tests and the `Resolve_DeadRelease_AutoFallsBackToHealthySibling` /
`…ExhaustsFallback…` integration cases. The **global NNTP connection budget**
(`SemaphoreNntpGate`, priority gate: BODY/ARTICLE outrank STAT/HEAD) is asserted across
**two concurrent mock-NNTP streams** — the cap is never exceeded and both streams make
progress. **Provider failover** — `MultiProviderNntpClient` over priority-ordered providers
+ `ProviderCircuitBreaker` — is integration-tested with two mock providers where the primary
starts 430-ing mid-stream and the block-account backup takes over per segment. **Observability:**
Serilog structured logging + one-line-per-request request logging, and an authenticated
**`GET /api/v1/metrics`** JSON snapshot (sessions, connections vs budget + per-provider,
bytes served, resolves/fallbacks, search-cache hit rate, per-indexer latency). **Packaging:**
the multi-stage `server/Dockerfile` (SPA → .NET → ffmpeg+curl runtime) is wired into
`docker-compose.dev.yml` (Jellyfin + Core + optional Vite) with a liveness healthcheck. A
**segment-streaming load test** (64 concurrent range reads, all byte-exact under the budget)
records its findings in `docs/m7-cache-loadtest.md`. Final docs land in `docs/`:
[`architecture.md`](docs/architecture.md), [`api.md`](docs/api.md),
[`setup.md`](docs/setup.md), [`ranker-tuning.md`](docs/ranker-tuning.md), and the
[`jellyfin-compatibility.md`](docs/jellyfin-compatibility.md) final pass.

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

The **Release diagnostics** tab under Search exists precisely for this: it shows every
release *including the rejected ones*, with parsed fields, the score breakdown per rule,
and the rejection reason. Tune the ranker there, not in the dark.

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
- **Ephemeral items** live under a private, hidden, TTL-cleaned implementation folder,
  so the folder and its children do not enter normal library browsing, *Latest*, or
  recommendations. Eligible items are returned only through intercepted search and
  remain subject to the requesting user's compatible-library visibility policy.
- **No torrents.** Usenet/NZB only.
- **No subtitle search** yet; Jellyfin's own subtitle plugins still work for its
  items.

---

## Security

- Administrative and machine operations require their scoped credentials. The browser
  Management UI uses an HttpOnly, SameSite cookie; non-browser clients may use bearer
  credentials.
- `GET /api/v1/stream/{token}` and the matching close operation are authorized by the
  short-lived, unguessable capability in the path. Possession of that capability grants
  access only to that session. They do not accept `access_token` query auth, an admin
  JWT, or a machine API key, and plugin media sources expose no reusable auth header.
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
