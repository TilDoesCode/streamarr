# Milestone 5 — acceptance checklist

M5 delivers the Jellyfin **playback thin-slice** (BRIEF Milestone 5 / §8). The plugin
materializes **one** ephemeral item pointing at the Core Server and makes it playable
through `IMediaSourceProvider`; resolve/open/close and playback events are wired. There
is **no search interception yet** (that is M6).

## Automated / headless verification (done in this repo)

- ✅ Plugin builds against `Jellyfin.Controller` 10.10.7 (`dotnet build -c Release`).
- ✅ `dotnet test plugin/Streamarr.Plugin.sln` — mapper + store + tracker unit tests pass
  (translation is the plugin's only logic; it is pinned by tests).
- ✅ Jellyfin 10.10.7 (docker) **loads the plugin with zero errors**; the service
  registrator runs and the playback-event bridge attaches to `ISessionManager`
  (see `docs/jellyfin-compatibility.md` for the exact log lines).
- ✅ `docker compose -f docker-compose.dev.yml config` validates the dev stack.

## Manual acceptance (owner — requires a real client + real credentials)

Headless CI cannot exercise ffmpeg Direct Play / transcode against a live Usenet
provider. The owner must run this once on a real Jellyfin client (web, mobile, or TV).

### Prerequisites

1. Real Usenet provider credentials + a Newznab indexer configured in the Streamarr
   Management UI (until then, `/resolve` has no live article to open).
2. A Core Server machine API key; put the same value in the plugin config.

### Setup

1. Build the plugin:
   `(cd plugin && ~/.dotnet/dotnet build Streamarr.Plugin/Streamarr.Plugin.csproj -c Release)`
2. `docker compose -f docker-compose.dev.yml up --build`
3. Jellyfin → **Dashboard → Plugins** → confirm **Streamarr** is listed and **Active**.
4. Open the Streamarr plugin settings:
   - Core Server URL = `http://streamarr:8080`, API key = the machine key.
   - Click **Test connection** → expect "Connected. Server version …".
   - Set a **Pinned-work query** that your indexers can satisfy (a movie).
   - Click **Materialize pinned work** → expect "Materialized …" with a release count.

### Checklist

- [ ] The ephemeral item appears under the isolated **"Streamarr (Usenet)"** folder and
      is tagged `usenet-ephemeral` (not mixed into the real library).
- [ ] Opening the item shows a **version picker** listing multiple releases
      (one `MediaSourceInfo` per ranked release, named e.g. `1080p WEB-DL x265 · DDP5.1 · GER`).
- [ ] Selecting a version and pressing play **opens** the source: the Core Server logs a
      `/resolve` and a new session appears in `GET /api/v1/sessions`.
- [ ] **Direct Play** works on a client/codec that supports the container.
- [ ] **Forced transcode** works: pick a lower bitrate / incompatible client so Jellyfin
      transcodes via ffmpeg from the `/stream` URL. Seeking works.
- [ ] Pre-probed media info is used: playback starts without a long ffmpeg analyze pause
      (resolve populated `MediaStreams` + `RunTimeTicks`, `AnalyzeDurationMs` is low).
- [ ] Stopping playback tears down the session: `CloseLiveStream` →
      `POST /api/v1/sessions/{token}/close`; the session disappears from `GET /sessions`.
- [ ] Playback events land server-side: `start` / `progress` / `stop` rows appear via the
      Core Server watch-event store (source = `jellyfin`) — confirm in the DB / logs.
- [ ] (If a dead release is available) opening it follows the server's
      `suggestedFallbackReleaseId` **once** before surfacing an error.

### Notes

- TTL cleanup of ephemeral items and native-search interception are **M6**, not M5.
- The plugin contains zero domain logic: ranking, health, and fallback selection are all
  the Core Server's (BRIEF §11). The plugin only translates.

---

# Milestone 6 — search interception + TTL cleanup

M6 adds the `IAsyncActionFilter` that injects Usenet works into Jellyfin's **native** search
(`/Items?searchTerm=` and `/Search/Hints`), plus the `IScheduledTask` that deletes ephemeral
items past their TTL (BRIEF §8.2–8.5, Milestone 6).

## Automated / headless verification (done in this repo)

- ✅ Plugin builds against `Jellyfin.Controller` 10.10.7 with the filter + cleanup task
  registered (`dotnet build -c Release`, 0 warnings/errors under `TreatWarningsAsErrors`).
- ✅ `dotnet test plugin/Streamarr.Plugin.sln` — 24 tests: the merge/dedup + hint-shaping
  (`SearchInjectionTests`) and TTL-expiry (`EphemeralCleanupTests`) logic, plus the M5 mapper/
  store/tracker tests. Stable-GUID de-duplication and TTL decisions are pinned by these.
- ✅ Jellyfin 10.10.7 (docker) **loads the plugin with zero errors** with the search action
  filter registered into `MvcOptions` — no exceptions from `Streamarr.Plugin.Search` at startup.
- ✅ **Non-negotiable fall-through proven headlessly** (BRIEF §11). With the startup wizard
  completed via API and an authenticated token:
  - Interception **off** (default): `/Search/Hints` and `/Items?searchTerm=` → `200` (native).
  - Interception **on** with the Core Server **unreachable**: both endpoints still → `200`,
    returning native results with a fast fall-through — killing the Core Server never breaks
    native Jellyfin search.
  (See `docs/jellyfin-compatibility.md` → "Headless fall-through verification (M6)".)

## Manual acceptance (owner — requires a live Core Server + real credentials + a client)

Headless CI cannot exercise real Usenet works flowing into a client's search UI (needs indexer/
provider credentials and a real client). Run this once end to end.

### Setup

1. Configure real indexers + a Usenet provider + TMDB key in the Streamarr Management UI so
   `GET /api/v1/search` returns works with releases.
2. `docker compose -f docker-compose.dev.yml up --build`.
3. Jellyfin → **Dashboard → Plugins → Streamarr**: set Core Server URL + API key, **Test
   connection**, then turn **Enable search interception** **on**.

### Checklist

- [ ] Searching a movie title in a native Jellyfin client (web/mobile/TV) surfaces the Usenet
      work **alongside** local library results.
- [ ] The injected item lives under the isolated **"Streamarr (Usenet)"** folder and **never
      appears in "Latest Media" / recommendations** (it is a plain non-library folder, tagged
      `usenet-ephemeral`).
- [ ] Selecting the injected result and pressing play resolves + plays it (the M5 playback path:
      version picker, `/resolve`, session appears in `GET /api/v1/sessions`).
- [ ] **Repeat the same search** — the work updates in place; **no duplicate** item appears
      (stable GUID derived from `workId`).
- [ ] **Kill the Core Server** (or toggle interception off) and search again — native library
      search is **fully intact**; no errors surface in the client. (Proven headlessly above; the
      manual step confirms the client UX.)
- [ ] **TTL cleanup:** set a short `EphemeralTtlMinutes`, run **Dashboard → Scheduled Tasks →
      "Streamarr: clean up ephemeral items"**, and confirm stale ephemeral items are removed via
      `ILibraryManager` while native items are untouched.

### Notes

- Session teardown is authoritative on the Core Server (it owns session TTL, BRIEF §6.1); the
  plugin also closes each session on Jellyfin's `CloseLiveStream` (`StreamarrLiveStream.Close`).
- TV works materialize as a bare `Episode` (season/episode index set); movies as `Movie`. Both
  share the identical lazy-resolve/playback path.
- The plugin still contains zero domain logic — the Core Server does all searching/ranking/
  health/fallback; the filter only materializes what the server returned and merges it in.
