# Milestone 5 — acceptance checklist

M5 delivers the Jellyfin **playback thin-slice** (BRIEF Milestone 5 / §8). The plugin
materializes **one** ephemeral item pointing at the Core Server and makes it playable
through `IMediaSourceProvider`; resolve/open/close and playback events are wired. There
is **no search interception yet** (that is M6).

## Automated / headless verification (done in this repo)

- ✅ Plugin builds against `Jellyfin.Controller` 10.11.11 on `net9.0`
  (`dotnet build -c Release`).
- ✅ `dotnet test plugin/Streamarr.Plugin.sln` — mapper, offer-store, persistence,
  transport-security, playback-dispatch, search, and cleanup tests pass (translation
  is the plugin's only logic; its trust boundaries are pinned by tests).
- ✅ Jellyfin 10.11.11 (docker) **loads the plugin with zero errors**; the service
  registrator runs and the playback-event bridge attaches to `ISessionManager`
  (see `docs/jellyfin-compatibility.md` for the exact log lines). The real-host review
  smoke also covered correct/wrong-key connection tests, materialization + restart
  persistence, allowed/denied PlaybackInfo, opaque open/close, rejection of forged,
  cross-user and replayed offers, and root/Latest isolation.
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
   - Click **Test connection** → expect "Connected. Server version …". This succeeds
     only after anonymous shallow health and authenticated capabilities both pass, so
     repeat once with a deliberately wrong key and confirm it fails.
   - Set a **Pinned-work query** that your indexers can satisfy (a movie).
   - Click **Materialize pinned work** → expect "Materialized …" with a release count.

### Checklist

- [ ] The private Streamarr implementation folder and its item do **not** appear in
      normal library browsing, "Latest", or recommendations. The item is tagged
      `usenet-ephemeral` and is reachable only through an eligible intercepted search
      (or direct API access to the returned item id during this bootstrap test).
- [ ] Opening the eligible item shows a **version picker** listing multiple releases
      (one `MediaSourceInfo` per ranked release, named e.g. `1080p WEB-DL x265 · DDP5.1 · GER`).
- [ ] Each unopened source carries an opaque, bounded, replay-safe `OpenToken`; it is
      not a release id, can be replayed only within its active/idle lease, and cannot be
      used by a different Jellyfin user.
- [ ] Selecting a version and pressing play **opens** the source: the Core Server logs a
      `/resolve` and a new session appears in admin-authenticated
      `GET /api/v1/sessions`.
- [ ] **Direct Play** works on a client/codec that supports the container.
- [ ] **Forced transcode** works: pick a lower bitrate / incompatible client so Jellyfin
      transcodes via ffmpeg from the `/stream` URL. Seeking works. The opened source
      contains no reusable credential in `RequiredHttpHeaders`; the short-lived path
      capability alone authorizes that stream.
- [ ] Pre-probed media info is used: playback starts without a long ffmpeg analyze pause
      (resolve populated `MediaStreams` + `RunTimeTicks`, `AnalyzeDurationMs` is low).
- [ ] Stopping playback tears down the session: `CloseLiveStream` →
      `POST /api/v1/sessions/{token}/close`; it disappears from admin-authenticated
      `GET /api/v1/sessions`.
- [ ] Playback events land server-side: `start` / `progress` / `stop` rows appear via the
      Core Server watch-event store (source = `jellyfin`) — confirm in the DB / logs.
- [ ] (If a dead release is available) Core auto-fallback remains inside the same
      offered work and is attributed in the resolve response; if Core returns a dead
      response with `suggestedFallbackReleaseId`, the plugin follows it at most once.

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

- ✅ Plugin builds against `Jellyfin.Controller` 10.11.11 on `net9.0` with the filter + cleanup task
  registered (`dotnet build -c Release`, 0 warnings/errors under `TreatWarningsAsErrors`).
- ✅ `dotnet test plugin/Streamarr.Plugin.sln` — the merge/dedup + hint-shaping
  (`SearchInjectionTests`) and TTL-expiry (`EphemeralCleanupTests`) logic, plus the M5
  mapper/offer/store/tracker and security tests. Stable-GUID de-duplication, bounded
  state, replay-safe offers, and TTL decisions are pinned by these.
- ✅ Jellyfin 10.11.11 (docker) **loads the plugin with zero errors** with the search action
  filter registered into `MvcOptions` — no exceptions from `Streamarr.Plugin.Search` at startup.
- ✅ **Real-host fall-through** (BRIEF §11): the hardened Jellyfin smoke verifies that
  interception **off** leaves `/Search/Hints` and `/Items?searchTerm=` native, and that
  interception **on** with Core unreachable returns native `200` responses from both
  endpoints without synthetic items. Re-run this pinned smoke on every host upgrade. See
  [`jellyfin-compatibility.md`](./jellyfin-compatibility.md#required-search-fall-through-check).

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
- [ ] The injected item lives under the private, hidden Streamarr implementation folder;
      neither the folder nor the item appears in normal browsing, "Latest Media", or
      recommendations. The item is tagged `usenet-ephemeral` and eligible only when the
      user can see a compatible ordinary Jellyfin library.
- [ ] Selecting the injected result and pressing play resolves + plays it (the M5 playback path:
      version picker, `/resolve`, session appears in admin-authenticated
      `GET /api/v1/sessions`).
- [ ] **Repeat the same search** — the work updates in place; **no duplicate** item appears
      (stable GUID derived from `workId`).
- [ ] **Kill the Core Server** (or toggle interception off) and search again — native library
      search is **fully intact**; no errors surface in the client. CI exercises the HTTP
      fall-through contract; this client check still confirms the end-user presentation.
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
