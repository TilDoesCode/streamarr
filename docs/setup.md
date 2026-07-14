# Setup guide

How to run Streamarr, configure it, verify it end-to-end **before** touching Jellyfin,
and then bolt Jellyfin on. Pairs with [`architecture.md`](./architecture.md) (what the
pieces are) and [`api.md`](./api.md) (what they expose).

> **Prerequisite reality check (DECISIONS.md open items):** Streamarr needs real Usenet
> provider credentials and at least one Newznab indexer API key to resolve and stream
> live content. Until you supply them, the test suite and the latency harness run
> against an in-repo **mock NNTP server + canned indexer/TMDB fixtures** — enough to
> prove the plumbing, not to stream real media. Put real credentials in
> `appsettings.Local.json` (git-ignored) or the Management UI. See
> [`m1-latency.md`](./m1-latency.md).

---

## 1. Quick start — the dev stack

[`docker-compose.dev.yml`](../docker-compose.dev.yml) brings up Jellyfin + the Core
Server, with an optional Vite web profile.

```bash
# 1. Configure unique credentials. Compose fails while either value is empty.
cp .env.example .env
${EDITOR:-vi} .env

# 2. Build the Jellyfin plugin (its DLL is bind-mounted into Jellyfin)
(cd plugin && dotnet build Streamarr.Plugin/Streamarr.Plugin.csproj -c Release)

# 3. Bring up Jellyfin + Core Server
docker compose -f docker-compose.dev.yml up --build

# 4. (optional) also run the Management UI on Vite
docker compose -f docker-compose.dev.yml --profile web up --build
```

- **Core Server** → `http://localhost:8080` (`/api/v1`, `/openapi/v1.json`, and the
  built SPA at `/`).
- **Jellyfin** → `http://localhost:8096` (waits on the Core's
  `GET /api/v1/health?deep=false` healthcheck before starting).
- **Vite web** (profile `web`) → `http://localhost:5173`, proxying `/api` + `/openapi`
  to the Core.

The compose file reads the bootstrap username, password and machine key from `.env`,
fails fast when either secret is empty, and binds every published port to loopback.
Set `JELLYFIN_UID` / `JELLYFIN_GID` to the owner of the plugin build output and the
Jellyfin volumes (the example defaults to `1000:1000`). Both application containers
run without Linux capabilities, with a read-only root filesystem and
`no-new-privileges`; only their declared volumes and bounded tmpfs mounts are writable.
The Jellyfin container mounts the plugin's build output read-write into
`/config/plugins/Streamarr` (Jellyfin rewrites `meta.json` on load; a read-only mount
fails).

---

## 2. Production — the single container

For production the Core Server serves the Management UI itself from `wwwroot/` as
static files — **single container, single origin** (BRIEF §4). The multi-stage
[`server/Dockerfile`](../server/Dockerfile) does all of it:

1. builds the React SPA (`node`),
2. publishes the ASP.NET Core app (`dotnet sdk`), copying `web/dist/*` into
   `wwwroot/`,
3. ships a slim `aspnet` runtime with **ffmpeg** (supplies `ffprobe` for `/resolve`)
   and **curl** (backs the healthcheck).

```bash
# build context is the repo root
docker build -f server/Dockerfile -t streamarr .
docker run --init --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m \
  -p 127.0.0.1:8080:8080 \
  -e STREAMARR_ADMIN_PASSWORD='choose-a-strong-one' \
  -e Streamarr__ApiKey='replace-with-at-least-32-random-characters' \
  -v streamarr-data:/app/data -v streamarr-keys:/app/keys \
  streamarr
```

The image stores SQLite at `/app/data/streamarr.db`, persists Data Protection keys at
`/app/keys`, and runs as the unprivileged `app` user. Back up both volumes together.

The application port is intentionally HTTP-only inside the container. A production
installation **must** terminate HTTPS at a trusted reverse proxy/VPN ingress and proxy
to this loopback/private port. Do not change the example to `-p 8080:8080` on an
internet-facing host. Configure the proxy to redact `/api/v1/stream/*` paths and all
query strings from access logs, and limit request/body sizes at the edge as a second
layer of defense.

For example, a Caddy instance on the same host can terminate TLS automatically:

```caddyfile
streamarr.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Keep proxy access logging disabled for stream paths unless its configuration can
reliably redact the capability token.

Loopback reverse proxies are trusted automatically. If the proxy reaches Kestrel from
another container or host, add only its exact source address through
`Streamarr__TrustedProxies__0` (and increment the final index for additional proxies).
Do not configure an entire client network: only listed proxy addresses may supply
`X-Forwarded-For` and `X-Forwarded-Proto`, and Streamarr accepts one forwarding hop.

When `wwwroot/index.html` exists the server enables static-file serving + an SPA
fallback (client routes like `/settings` resolve to `index.html`), while `/api` and
`/openapi` keep their own behavior. In development you instead run Vite (`npm run dev`)
proxying to Kestrel — both paths are supported.

Cookie-authenticated state changes require a same-origin request. When the Management UI
is reached through a TLS-terminating tunnel or a forwarded per-app URL (e.g. Codecraft dev
actions), the browser's `Origin` can never match the origin Kestrel reconstructs locally,
so those `POST`/`PUT`/`DELETE`s fail with `403 csrf_rejected`. List each browser-visible
origin (`scheme://host[:port]`, no path) through `Streamarr__TrustedOrigins__0` (increment
the index for more). Leave it empty for a plain single-origin deployment. The dev stack and
native `server` action already wire this from the `CODECRAFT_URL_*` public URLs.

---

## 3. Configuration — where it lives

Config resolves from four overlapping places (later wins for a given key):

1. **`appsettings.json`** — checked-in defaults, under the `Streamarr` section.
2. **`appsettings.Local.json`** — **git-ignored**; put real provider credentials, real
   indexer keys, and your TMDB key here for local runs.
3. **Environment variables** — `Streamarr__ApiKey`, `Streamarr__Admin__Password`,
   `STREAMARR_ADMIN_PASSWORD`, etc. (ASP.NET's `__` maps to config nesting).
4. **The Management UI / config API** — the SQLite-backed **source of truth** for
   indexers, providers, profiles, general config, and API keys. On startup the
   persisted config is overlaid onto the bound options, so once you have configured
   things in the UI, that is what runs. Provider pool changes are applied atomically to
   subsequent NNTP commands; an already-borrowed connection may finish before its retired
   pool is disposed.

**First-run bootstrap:** with an empty users table an admin is seeded from
`STREAMARR_ADMIN_PASSWORD` / `Streamarr:Admin:Password`. Outside Development a
configured 12–1024 character password without control characters is required and a
missing value fails startup. Only Development may generate and log a random fallback
once. Machine clients authenticate with the optional static `Streamarr:ApiKey` or a key
minted via `POST /api/v1/config/apikeys`; when enabled, the static key must be 32–4096
characters without whitespace or control characters. Secrets are encrypted at rest
(ASP.NET Data Protection key ring under
`Streamarr:DataProtectionKeysPath`) and never returned in plaintext by the API.

---

## 4. First-run order (matches the README)

Open the Management UI and configure, **in this order**:

1. **Usenet provider** — host, port, SSL, credentials, max connections. Hit **Test**
   → it connects + `AUTHINFO` and reports achievable connections. Add a second,
   lower-priority provider (a block/backup account) if you have one — failover is
   automatic (see [`architecture.md`](./architecture.md) §5.2).
2. **Indexers** — Newznab base URL + API key per indexer. Hit **Test** → a `t=caps`
   roundtrip showing caps + latency. Enable/disable and order by priority.
3. **TMDB API key** — under **Settings** → General. Without it, search still works but
   works are not enriched with metadata/artwork.
4. **Quality profile** — start from the built-in **Standard** default and tune it later
   in the Search/Debug playground. See [`ranker-tuning.md`](./ranker-tuning.md).

---

## 5. Verify end-to-end BEFORE Jellyfin (the architectural canary)

This is the step that proves the Core is sound and the abstraction has not leaked
(BRIEF §3.1 rule 4, §11):

1. Open the **Search / Debug playground**, run a query, and inspect the releases —
   parsed fields, per-rule score breakdown, and any rejection reasons.
2. **Resolve** a release: see the health-check outcome and the pre-probed media info.
3. Hit **Playback preview**: the resolved stream plays in a plain HTML5 `<video>`
   element — **with Jellyfin not running at all** — instrumented for time-to-first-frame
   and seek latency.

If preview-play works, the Core is doing the whole job (search → rank → resolve →
health-check → stream) with no Jellyfin in the loop. If it breaks, treat it as a build
failure, not a UI bug.

---

## 6. Add the Jellyfin plugin

1. **Build:** `(cd plugin && dotnet build -c Release)`. The compose file bind-mounts the
   output DLL into Jellyfin's plugin dir; otherwise drop
   `Streamarr.Plugin.dll` (+ `meta.json`) into `/config/plugins/Streamarr` (read-write).
2. In Jellyfin → **Dashboard → Plugins**, confirm **Streamarr** is listed and Active.
3. Open its (deliberately minimal) config page: set **Core Server URL**
   (`http://streamarr:8080` in compose) and the **machine API key**, hit **Test
   connection**. This calls anonymous shallow `GET /api/v1/health?deep=false` and then
   authenticated `GET /api/v1/caps`; both must succeed, so the test validates the URL
   and the key rather than liveness alone.
4. Turn on **Enable search interception**.

Usenet results now appear alongside your local library and play through Jellyfin's
transcoding pipeline. Synthetic items live under a private, hidden implementation
folder and are returned only through eligible intercepted searches; they do not appear
in normal library browsing. The plugin is **pinned to Jellyfin 10.11.11** and the search
interception is version-fragile — see
[`jellyfin-compatibility.md`](./jellyfin-compatibility.md) and the manual acceptance
checklist in [`m5-acceptance.md`](./m5-acceptance.md).

---

## 7. Configuration reference (`StreamarrOptions`)

Every key under the `Streamarr` section, from
[`Options/StreamarrOptions.cs`](../server/src/Streamarr.Server/Options/StreamarrOptions.cs).
Bind via `appsettings*.json` (`"Streamarr": { … }`) or env vars (`Streamarr__Key`).

### Top-level

| Key | Default | Meaning |
|---|---|---|
| `ApiKey` | `""` | Static bootstrap machine API key for bearer auth. Empty disables it; when enabled it must be 32–4096 characters without whitespace/control characters. Keys minted via the config API still work. |
| `ConnectionString` | `""` | SQLite connection string. Empty → `streamarr.db` next to the app. |
| `AdminSessionTtlSeconds` | `3600` | Lifetime of the admin session cookie/JWT from `POST /auth/login`. |
| `LoginAttemptsPerMinute` | `5` | Fixed-window login-attempt limit per client IP. |
| `DataProtectionKeysPath` | `""` | Directory the secret-encryption key ring persists to. Empty → a `keys` folder next to the app. |
| `ConnectionBudget` | `20` | **Global** NNTP connection budget shared across all sessions (BODY/ARTICLE outrank STAT/HEAD). |
| `SessionTtlSeconds` | `3600` | Session lifetime; a stream token maps to a session until this elapses (or it is closed). |
| `SessionSweepIntervalSeconds` | `30` | How often the session manager sweeps for expired sessions. |
| `MaxSessions` | `64` | Hard cap on simultaneously live capability sessions. |
| `MaxConcurrentStreams` | `128` | Hard cap on concurrently open HTTP stream bodies. |
| `MaxConcurrentResolves` | `4` | Hard cap on full NZB/health/materialization resolve pipelines in flight. |
| `MaxConcurrentSearches` | `4` | Hard cap on concurrent indexer fan-out searches. |
| `MaxFallbackHops` | `3` | **(M7)** Max automatic fallback hops when a release resolves dead, so a fully-dead work fails fast. |
| `HealthCacheTtlSeconds` | `1800` | **(M7)** How long a dead classification is remembered and fed back into ranking + fallback selection. `0` disables the health cache. |
| `ArticleReadAheadCount` | `3` | Segments read ahead while streaming (nzbdav's article buffer size). |
| `FfprobePath` | `ffprobe` | Path to the `ffprobe` binary used to pre-probe the stream at resolve. |
| `FfprobeTimeoutSeconds` | `60` | Timeout for the server-side `ffprobe` run. |
| `MaxConcurrentFfprobe` | `2` | Hard cap on concurrent `ffprobe` child processes. |
| `MaxNzbBytes` | `67108864` | Maximum compressed NZB response size accepted from an indexer. |
| `MaxNzbFiles` | `10000` | Maximum file entries accepted from one NZB. |
| `MaxNzbSegments` | `1000000` | Maximum total segment entries accepted from one NZB. |
| `MaxMediaBytes` | `17592186044416` | Maximum decoded size of one materialized media file (16 TiB). |
| `AllowLocalNzbFiles` | `false` | Test-only escape hatch for local NZB paths; keep disabled in production. |
| `SearchCacheMaxEntries` | `1000` | Hard bound for the in-memory search cache. |
| `HealthCacheMaxEntries` | `10000` | Hard bound for cached release-health classifications. |
| `ReleaseStoreMaxEntries` | `10000` | Hard bound for the in-memory release lookup store. |
| `TmdbCacheMaxEntries` | `5000` | Hard bound for cached TMDB metadata. |
| `MaxWatchEvents` | `10000` | Maximum retained playback-event rows; oldest rows are pruned on write. |
| `DeepHealthCacheSeconds` | `30` | Shared cache lifetime for admin-only dependency probes. |
| `Admin` | — | First-run admin bootstrap (below). |
| `Providers[]` | `[]` | Priority-ordered Usenet providers (below). |
| `Indexers[]` | `[]` | Newznab indexers seeding the config store (below). |
| `Search` | — | Indexer fan-out tunables (below). |
| `Tmdb` | — | TMDB matcher config (below). |
| `HealthCheck` | — | NNTP STAT health-check knobs (below). |

### `Admin`

| Key | Default | Meaning |
|---|---|---|
| `Admin.Username` | `admin` | Bootstrap admin username (only used when the users table is empty). |
| `Admin.Password` | `""` | Bootstrap password, also settable via `STREAMARR_ADMIN_PASSWORD`. Must be 12–1024 characters without control characters. Required outside Development; only Development generates/logs a random fallback once. |

### `Providers[]` (each entry)

| Key | Default | Meaning |
|---|---|---|
| `Name` | `""` | Display name (surfaced in `/metrics`, `/caps`). |
| `Host` | `""` | NNTP hostname. |
| `Port` | `563` | NNTP port (563 = NNTPS). |
| `UseSsl` | `true` | TLS to the provider. |
| `Username` / `Password` | `""` | Credentials (`AUTHINFO`). Encrypted at rest via the config store. |
| `MaxConnections` | `10` | Per-provider connection cap (subordinate to the global `ConnectionBudget`). |
| `Priority` | `0` | Lower = tried first. A block/backup account gets a higher number. |
| `Type` | `Pooled` | Provider type (`Pooled` / `Disabled`). |

### `Indexers[]` (each entry)

| Key | Default | Meaning |
|---|---|---|
| `Id` | `""` | Stable id; falls back to `Name` when omitted. |
| `Name` | `""` | Display name. |
| `BaseUrl` | `""` | Newznab API base URL. |
| `ApiKey` | `""` | Indexer API key. Never leaves the server. |
| `Categories[]` | `[]` | Newznab category ids to search. |
| `Enabled` | `true` | Include in the fan-out. |
| `Priority` | `0` | Ordering / tie-break among indexers. |

### `Search`

| Key | Default | Meaning |
|---|---|---|
| `SearchCacheTtlSeconds` | `60` | Search-result cache lifetime (keyed by normalized query). |
| `PerIndexerTimeoutSeconds` | `30` | Per-indexer request timeout; a slow indexer is dropped, not awaited. |
| `PerIndexerRateLimitMilliseconds` | `1000` | Minimum gap between consecutive requests to the same indexer. |
| `DefaultLimit` | `100` | Result cap sent to each indexer when the query sets none. |
| `MaxResponseBytes` | `16777216` | Maximum XML response body accepted from one indexer. |
| `MaxIndexersPerSearch` | `32` | Maximum enabled indexers included in one fan-out. |
| `MaxConcurrentIndexerRequests` | `8` | Process-wide maximum in-flight Newznab requests across all searches. |

### `Tmdb`

| Key | Default | Meaning |
|---|---|---|
| `ApiKey` | `""` | TMDB API key. Empty → every TMDB lookup no-ops to null (search still works, unenriched). |
| `BaseUrl` | `https://api.themoviedb.org/3` | TMDB API base. |
| `ImageBaseUrl` | `https://image.tmdb.org/t/p` | Image CDN base. |
| `PosterSize` / `BackdropSize` | `w500` / `w1280` | Requested image sizes. |
| `Language` | `null` | Optional ISO 639-1 response language (e.g. `en-US`). |
| `CacheTtlHours` | `24` | Metadata cache lifetime (cached aggressively). |
| `MaxResponseBytes` | `4194304` | Maximum decompressed JSON response body accepted from TMDB. |
| `RequestTimeoutSeconds` | `20` | Hard lifetime for one shared upstream lookup, including admission wait. |
| `MaxConcurrentRequests` | `4` | Process-wide maximum TMDB requests in flight. |

### `HealthCheck`

| Key | Default | Meaning |
|---|---|---|
| `SampleCount` | `24` | Max segments STAT'ed per release (evenly spread, incl. first/last). |
| `Concurrency` | `8` | Concurrent STAT probes. |
| `DeadMissingRatio` | `0.5` | Missing-sample ratio at/above which a release is `dead` (below → `degraded`). |

---

## 8. Development commands

```bash
# Core
cd server
dotnet run --project src/Streamarr.Server   # /openapi/v1.json, Swagger UI at /swagger (dev)
dotnet test                                 # parser corpus, ranker, auth, streaming, budget, load
scripts/freeze-openapi.sh                   # re-freeze the OpenAPI contract (CI fails on drift)

# Management UI
cd web
npm install
npm run generate:api   # ../server/openapi/v1.json → src/api/schema.d.ts (CI fails on drift)
npm run dev            # Vite on :5173, proxying /api + /openapi (override target: STREAMARR_SERVER_ORIGIN)
npm test               # Vitest + Testing Library
npm run build          # type-check + production SPA build → web/dist

# Latency harness (mock baseline; real once credentials exist — see m1-latency.md)
dotnet run --project server/tools/latency -- --mode mock --iterations 12 --markdown
```

---

## See also

- [`architecture.md`](./architecture.md) — the components and the request lifecycle.
- [`api.md`](./api.md) — the endpoints the config you set here drives.
- [`ranker-tuning.md`](./ranker-tuning.md) — tuning quality profiles in the playground.
- [`jellyfin-compatibility.md`](./jellyfin-compatibility.md) — the pinned Jellyfin
  version and re-test procedure.
- [`m1-latency.md`](./m1-latency.md) — cold-start/seek measurement and the mock-vs-real
  situation.
