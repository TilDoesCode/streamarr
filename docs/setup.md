# Setup guide

This is the advanced source-development and option reference. For a normal release
installation, start with [`installation.md`](./installation.md),
[`configuration.md`](./configuration.md), and [`operations.md`](./operations.md).
The sections below cover the development stack, exhaustive settings, and implementation
details. Pair them with [`architecture.md`](./architecture.md) and [`api.md`](./api.md).

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

The image stores SQLite at `/app/data/streamarr.db`, the persistent NZB cache under
`/app/data/nzb`, and the repair workspace/artifact cache under `/app/data/repair`.
Data Protection keys persist at `/app/keys`, and the image runs as the unprivileged
`app` user. Back up the database and `/app/keys` together so protected data remains
decryptable. The NZB and repair directories are reconstructible caches and can be
excluded from space-conscious backups.

The application port is intentionally HTTP-only inside the container. Access outside
the Docker host or a trusted private LAN **must** terminate HTTPS at a trusted reverse
proxy/VPN ingress and proxy to this loopback/private port. Do not change the example to
`-p 8080:8080` on an internet-facing host. Configure the proxy to redact capability-
or admission-bearing paths (`/api/v1/stream/*`, `/api/v1/sessions/*`,
`/api/v1/playback-sessions/*`, and
`/api/v1/ephemeral-files/*`) and all query strings from access logs. Limit request/body
sizes at the edge as a second layer of defense.

For example, a Caddy instance on the same host can terminate TLS automatically:

```caddyfile
streamarr.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8080
}
```

Keep proxy access logging disabled for capability and admission paths unless its
configuration can reliably redact their tokens and identifiers.

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
   `INDEXER_PROXY` is an explicit alias for `Streamarr:IndexerProxy` and takes
   precedence over the nested setting.
4. **The Management UI / config API** — the SQLite-backed **source of truth** for
   indexers, providers, profiles, general/pre-download config, and API keys. On startup the
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

### Operator logs and optional Jellyfin logs

The **Logs** navigation item shows the Core's bounded, sanitized in-process log feed;
each stream detail page applies the same feed with that attempt's release/work/token
correlation. The Core retains the newest 2,000 events since process start and returns at
most 500 per request. Health checks, successful log-feed polling, ordinary fast 2xx, and
routine 4xx requests are suppressed from normal output; server failures, timeouts/rate
limits, slow non-streaming requests, provider/indexer failures, resolve failures, and
stream-read exceptions remain visible.

Jellyfin can optionally be merged into the same views. In Jellyfin, create an API key
under **Dashboard → Advanced → API Keys**, then configure both values and restart the
Core:

```dotenv
# Compose network example; use the URL reachable from the Core in other deployments.
JELLYFIN_LOG_BASE_URL=http://jellyfin:8096
JELLYFIN_LOG_API_KEY=replace-with-the-jellyfin-api-key
```

Outside Compose, the equivalent variables are
`Streamarr__Jellyfin__BaseUrl` and `Streamarr__Jellyfin__ApiKey`. The key is sent only in
Jellyfin's `Authorization: MediaBrowser … Token="…"` header, never in a URL. Jellyfin
protects server-log access with administrator elevation, so treat this API key as an
administrator secret.

Jellyfin exposes only a file list plus complete-file download, not a server-side tail or
level filter. Streamarr therefore checks metadata every 15 seconds, downloads at most
4 MiB when the newest primary server log changes, ignores ffmpeg/transcode files, and
keeps only warning/error/fatal entries plus lines mentioning Streamarr. Retrieval is
optional and failure-isolated: an unavailable or unconfigured Jellyfin is shown as source
status and never affects Core startup, health, streaming, or Core-only logs.

### Route indexer traffic through Gluetun

Set `INDEXER_PROXY` to the origin of an HTTP proxy reachable from the Streamarr
container. For Gluetun's built-in proxy on the same Compose network:

```dotenv
INDEXER_PROXY=http://gluetun:8888
```

Enable `HTTPPROXY=on` on the Gluetun service. Streamarr then explicitly sends Newznab
searches, capability tests, and NZB-file retrieval through that proxy. TMDB requests
and NNTP article/media connections remain direct. There is no direct fallback when a
configured proxy is unavailable, and generic `HTTP_PROXY` / `HTTPS_PROXY` variables do
not change this routing policy. The proxy value must be an `http://` origin without
credentials, a path, query, or fragment.

---

## 4. First-run order (matches the README)

Open the Management UI and configure, **in this order**:

1. **Usenet provider** — host, port, SSL, credentials, max connections. Hit **Test**
   → it connects + `AUTHINFO` and reports achievable connections. Add a second,
   lower-priority provider (a block/backup account) if you have one — failover is
   automatic (see [`architecture.md`](./architecture.md) §5.2).
2. **Indexers** — Newznab base URL + API key per indexer. Hit **Test** → a `t=caps`
   roundtrip showing caps + latency. Enable/disable and order by priority.
3. **TMDB credential** — enter either the short v3 API key or the API Read Access Token
   (JWT) under **Settings** → General. The source-development Compose stack also maps
   `TMDB_API_KEY` from its `.env`; the release Compose flow uses the UI by default.
   It is required for public semantic discovery, canonical metadata, artwork, and Jellyfin
   injection. Without it, raw/rejected indexer hits remain available only in the
   **Release diagnostics** tab and `/debug/search`.
4. **Quality profile** — start from the built-in **Standard** default and tune it later
   under **Search → Release diagnostics**. See [`ranker-tuning.md`](./ranker-tuning.md).

---

## 5. Verify end-to-end BEFORE Jellyfin (the architectural canary)

This is the step that proves the Core is sound and the abstraction has not leaked
(BRIEF §3.1 rule 4, §11):

1. Open **Search**, use **Semantic discovery** to verify available works, then open
   **Release diagnostics** to inspect parsed fields, per-rule score breakdown, and any
   rejection reasons.
2. **Resolve** a release: see the health-check outcome and the pre-probed media info.
3. Hit **Playback preview**: the resolved stream plays in a plain HTML5 `<video>`
   element — **with Jellyfin not running at all** — instrumented for time-to-first-frame
   and seek latency.

If preview-play works, the Core is doing the whole job (search → rank → resolve →
health-check → stream) with no Jellyfin in the loop. If it breaks, treat it as a build
failure rather than a UI bug only after ruling out an MKV/container or codec the browser
cannot decode; this preview path does not transcode, while Jellyfin can.

---

## 6. Add the Jellyfin plugin

1. **Build:** `(cd plugin && dotnet build -c Release)`. The compose file bind-mounts the
   output DLL into Jellyfin's plugin dir; otherwise drop
   `Streamarr.Plugin.dll` (+ `meta.json`) into `/config/plugins/Streamarr` (read-write).
2. In Jellyfin → **Dashboard → Plugins**, confirm **Streamarr** is listed and Active.
3. Open its (deliberately minimal) config page. Set **Core Server URL** to the private
   control URL Jellyfin can reach (`http://streamarr:8080` in compose), set **Public
   stream URL** to an HTTPS reverse-proxy or private-LAN base URL reachable by every
   playback device, and enter the **machine API key**. The public URL is required when
   the control URL uses a container-only hostname; leave it blank only when the control
   URL itself is client-reachable. Hit **Test connection**. This calls anonymous shallow
   `GET /api/v1/health?deep=false` and then authenticated `GET /api/v1/caps`; both must
   succeed, so the test validates the control URL and key rather than liveness alone.
4. Turn on **Enable search interception**.

Usenet results now appear alongside your local library and play through Jellyfin's
transcoding pipeline. Movie results are availability-filtered immediately. TV results
appear as series folders (at most three TMDB matches); seasons load when the series is
opened, and one season-wide indexer search populates all canonical episodes when that
season is opened. Fresh search results stay in plugin-owned staging; playback,
favoriting, or watched state can promote an item into the visible Streamarr library.
The plugin is **pinned to Jellyfin 10.11.11** and the search interception is
version-fragile — see
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
| `NzbCachePath` | `""` | Persistent NZB cache directory. Empty → `cache/nzb` below the Core content root. Container images default to `/app/data/nzb`. |
| `NzbCacheSizeMb` | `1024` | Maximum total size of cached NZB source documents. Least-recently-used entries are pruned first. |
| `NzbCacheMaxEntries` | `2000` | Maximum cached release count. |
| `ConnectionBudget` | `20` | **Global** NNTP connection budget shared across all sessions (BODY/ARTICLE outrank STAT/HEAD). |
| `SessionTtlSeconds` | `86400` | Hard maximum age of an ephemeral file from creation. Access updates LRU order but never extends this deadline. Existing installs on the former `3600` default migrate to 24 hours. |
| `EphemeralCacheSizeMb` | `102400` | Logical decoded-file budget for ephemeral capabilities. A new admission evicts whole files by oldest last access until it fits; one file larger than the budget may stand alone. |
| `SessionSweepIntervalSeconds` | `30` | How often the session manager sweeps for expired sessions. |
| `MaxSessions` | `64` | Safety cap on retained capability sessions; at the limit the least-recently-accessed entry is evicted so a new file is not rejected. |
| `MaxConcurrentStreams` | `128` | Hard cap on concurrently open HTTP stream bodies. |
| `MaxConcurrentResolves` | `4` | Hard cap on full NZB/health/materialization resolve pipelines in flight. |
| `MaxConcurrentSearches` | `4` | Hard cap on concurrent indexer fan-out searches. |
| `IndexerProxy` | `""` | HTTP proxy used only for Newznab searches/caps and NZB retrieval. `INDEXER_PROXY` is the preferred deployment alias and takes precedence. Empty means explicitly direct. |
| `MaxFallbackHops` | `3` | **(M7)** Max automatic fallback hops when a release resolves dead, so a fully-dead work fails fast. |
| `HealthCacheTtlSeconds` | `1800` | **(M7)** How long a dead classification is remembered and fed back into ranking + fallback selection. `0` disables the health cache. |
| `ArticleReadAheadCount` | `3` | Maximum adjacent articles downloaded concurrently and delivered in order. |
| `ArticleDownloadRetryCount` | `2` | Whole-article retries after an interrupted transfer or yEnc validation failure. |
| `SegmentCacheSizeMb` | `512` | Process-wide decoded-article LRU size. `0` disables caching and in-flight request deduplication. |
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
| `PreDownload` | — | Background current-file and next-episode cache policy (below). |
| `Jellyfin` | — | Optional read-only Jellyfin server-log source (below). |
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

### `PreDownload`

The eight policy fields are persisted and can be changed live from the Management UI. `CachePath`
and `MinimumFreeDiskBytes` are deployment-only safeguards and require configuration/restart.

| Key | Default | Meaning |
|---|---|---|
| `PreDownload.Enabled` | `false` | Master switch; disabling prevents new jobs without discarding saved rule values. |
| `PreDownload.DownloadCurrentFile` | `true` | Finish materializing the current movie or episode after the grace period. |
| `PreDownload.CurrentFileThresholdSeconds` | `10` | Watched seconds before current-file completion starts (`0..3600`). |
| `PreDownload.DownloadNextEpisode` | `true` | Prepare the immediate canonical next episode when watch progress crosses the threshold. |
| `PreDownload.NextEpisodeThresholdPercent` | `75` | Client-reported watch percentage that triggers next-episode preparation (`1..100`). |
| `PreDownload.PreferSimilarNextEpisodeRelease` | `false` | Prefer the next-episode release whose title most closely resembles the currently playing release; ranking remains the fallback. |
| `PreDownload.NextEpisodeReleaseSimilarityThresholdPercent` | `75` | Minimum title-similarity score required before continuity overrides normal ranking (`0..100`). |
| `PreDownload.MaxConcurrentDownloads` | `1` | Concurrent low-priority jobs (`1..8`). |
| `PreDownload.CachePath` | `""` | Disk workspace; empty uses `cache/pre-download` below the Core content root. |
| `PreDownload.MinimumFreeDiskBytes` | `1073741824` | Free space the background writer must leave untouched. |

### `Jellyfin` (optional operator log source)

| Key | Default | Meaning |
|---|---:|---|
| `Jellyfin.BaseUrl` | `""` | Jellyfin HTTP(S) base URL reachable from the Core, including any configured base path. Must not contain credentials, query, or fragment. |
| `Jellyfin.ApiKey` | `""` | Jellyfin administrator API key used only for `GET /System/Logs` and `GET /System/Logs/Log`. Both values empty disable the source; partial/invalid configuration is reported in the Logs UI. |

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
| `ApiKey` | `""` | TMDB v3 API key or API Read Access Token (JWT). Empty → public semantic search returns no works; raw indexer results remain available through `/debug/search`. |
| `BaseUrl` | `https://api.themoviedb.org/3` | TMDB API base. |
| `ImageBaseUrl` | `https://image.tmdb.org/t/p` | Image CDN base. |
| `PosterSize` / `BackdropSize` | `w780` / `w1280` | Requested image sizes. |
| `Language` | `null` | Optional ISO 639-1 response language (e.g. `en-US`). |
| `CacheTtlHours` | `24` | Metadata cache lifetime (cached aggressively). |
| `MaxResponseBytes` | `4194304` | Maximum decompressed JSON response body accepted from TMDB. |
| `RequestTimeoutSeconds` | `20` | Hard lifetime for one shared upstream lookup, including admission wait. |
| `MaxConcurrentRequests` | `4` | Process-wide maximum TMDB requests in flight. |

### `HealthCheck`

| Key | Default | Meaning |
|---|---|---|
| `SampleCount` | `24` | Max segments STAT'ed per release (evenly spread, incl. first/last). |
| `StartupSampleCount` | `64` | Contiguous media segments verified through decoded `BODY` reads and cached from the beginning, in addition to the spread `STAT` sample. |
| `StartupBodyConcurrency` | `4` | Maximum startup `BODY` transfers running ahead; bounded separately so a dead release cannot occupy the whole connection budget while fallback starts. |
| `Concurrency` | `20` | Concurrent STAT probes. |
| `DeadMissingRatio` | `0.5` | Indeterminate spread-`STAT` ratio at/above which a release is `dead`; any missing article or failed startup `BODY` chain is immediately `dead`. |

### `Repair` (PAR2 repair pipeline)

When a needed article is definitively gone (BODY 430 after full provider failover) and no
healthy sibling release exists, the Core repairs the *raw* source/RAR bytes from the
release's PAR2 set and serves a verified local artifact — the open HTTP stream waits at
the hole and continues at the same offset instead of ending in a silent EOF. Healthy
streams never touch this pipeline (no PAR2 index download, no workspace I/O).

| Key | Default | Meaning |
|---|---|---|
| `Enabled` | `true` | Master switch for the repair pipeline. |
| `Policy` | `WhenNoFallback` | `WhenNoFallback`: a healthy sibling release still wins before playback; repair engages only when no healthy way out exists. `PreferRepair`: the originally chosen release is repaired instead of falling back. A client-directed release switch supersedes the prior session cleanly; an active repair remains scoped to the release that triggered it. |
| `ProgressiveEnabled` | `false` | Allows resolve to admit a *progressive* session on an origin-dead release when the damage sits far behind an intact prefix; reads that reach the hole wait on the shared job. |
| `ProgressiveMinIntactPrefixBytes` | `32 MiB` | Conservative eligibility floor for progressive admission. |
| `MaxConcurrentJobs` | `1` | Repair jobs running at once; more jobs queue. |
| `MaxConnections` | `4` | NNTP connections a job may use. Repair traffic flows through the same global `ConnectionBudget`/failover path as playback, at low priority. |
| `WorkspacePath` | *(content root)*`/cache/repair` | Private workspace + artifact cache root (0700, symlink-rejecting, traversal-checked). The official container overrides this to the persistent `/app/data/repair` volume. |
| `CacheBudgetBytes` | `20 GiB` | Artifact-cache byte budget (LRU beyond it; pinned/most-recent artifacts are never evicted). |
| `MaxArtifactBytes` | `8 GiB` | A recovery set larger than this is classified `limitsExceeded`. |
| `MinFreeDiskBytes` | `5 GiB` | Required free disk headroom before a job materializes sources. |
| `JobTimeoutSeconds` | `3600` | Hard wall-clock budget per job. |
| `WaitAtHoleTimeoutSeconds` | `90` | How long an open read waits at a hole before the request fails; the job continues in the background and a client retry serves the finished artifact. |
| `ArtifactTtlSeconds` | `604800` | Idle artifact TTL (sweeper). Eviction never makes the origin look healthy again. |
| `FailureBackoffSeconds` | `900` | Automatic-retry backoff after a failed job (manual admin start bypasses it). |
| `MaxJobEvents` / `MaxFinishedJobs` | `128` / `64` | Bounded per-job event log / finished-job history for the admin UI. |
| `MaxPar2PacketBytes`, `MaxPar2SliceBytes`, `MaxPar2Files`, `MaxPar2IndexBytes` | `256 MiB`, `128 MiB`, `256`, `64 MiB` | Parser safety limits — oversized or malformed PAR2 input fails the job instead of allocating unbounded memory. |

Reconstruction also has fixed fail-closed bounds: at most 256 damaged slices, 512 MiB
estimated working memory, 100 million matrix operations, and 50 billion total word
operations. These are defense-in-depth implementation limits rather than tuning knobs;
exceeding one produces `limitsExceeded` without publishing an artifact.

Operational notes for live debugging:

- **Repairs page** in the Management UI: per-job state, disposition, damaged/recovery
  block counts, source/parity bytes, waiters, ETA and the redacted event log; artifacts
  with size, age and pin count; admin cancel.
- `GET /api/v1/metrics` → `repairs` counters (attempts, success, failure by disposition,
  cache hits, wait-at-hole started/resumed/seconds, artifact bytes, evictions).
- Structured logs use release ids and failure types only — never message-ids, tokens,
  passwords or workspace paths.
- A locally repaired release keeps `originHealth=dead` while its artifact is cached;
  this field records the upstream evidence that triggered repair, while `playability`
  turns `repairedReady`. The health-cache TTL governs fresh upstream ranking checks; it
  does not relabel a cached artifact. After artifact eviction the next resolve
  re-evaluates from scratch — no stale "ready".

Troubleshooting:

| Symptom | Meaning / action |
|---|---|
| Job ends `insufficientParity` | More source blocks are damaged than intact recovery slices exist. The release keeps the classic dead/fallback behavior. Nothing to fix locally. |
| Job ends `unsupported` | No compatible PAR2 set, invalid/unretrievable bounded index candidates, a media file not covered by the set, or the reconstructed media projection failed structural/ffprobe verification. Seek-heavy media inside RAR may fail the bounded pipe probe; the artifact is not published and legacy fallback remains intact. |
| Job ends `limitsExceeded` | Artifact, free-disk, recovery-workspace, time, or bounded PAR2 set-discovery budget hit — check `MaxArtifactBytes`, `MinFreeDiskBytes`, `JobTimeoutSeconds`, free disk, and whether the NZB contains many unrelated PAR2 sets. Ordinary volumes from one filename stem are grouped and do not consume independent discovery attempts. |
| Player stalls ~`WaitAtHoleTimeoutSeconds` then errors | The repair outlasted the client tolerance. The job keeps running; pressing play again serves the finished artifact (`playability=repairedReady`). |
| Repeated attempts blocked | `FailureBackoffSeconds` is active for that fingerprint; a manual `POST /api/v1/repairs` bypasses it. |

---

## Pushover notifications

Open **Settings → Notifications** to connect Streamarr to the
[Pushover Message API](https://pushover.net/api). Create a Pushover application, enter
its application token and a user or delivery-group key, save, then use **Send test**.
Both credentials are encrypted at rest and are never returned by the API.

Notification routing is opt-in and can be tuned independently:

- routine events: server startup, playback start/progress/stop, and successful resolves;
- failures: resolve failures and otherwise-unhandled server errors;
- availability: indexer/provider outages after a configurable number of failed probes,
  reminders while an outage remains active, and a single recovery notification;
- content: user name, playback device, and internal release ID can each be excluded;
- delivery: routine, error, outage, and recovery priorities are independent. Emergency
  priority uses the configured Pushover retry and expiry values.

Playback progress and repeated errors have separate cooldowns. Pushover delivery uses a
bounded background queue, so a slow or unavailable Pushover service does not delay
search, resolve, playback, or event ingestion. Outage monitoring starts only after
notifications are enabled.

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
