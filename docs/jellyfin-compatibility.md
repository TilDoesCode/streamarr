# Jellyfin compatibility

The Streamarr plugin's search interception and media-source APIs are version-sensitive
(BRIEF §8, §11; DECISIONS.md #2). This document pins the exact versions the plugin is
built and tested against. Change the pinned values together and re-run the load check.

> The plugin is a **thin adapter** — it translates between the Core Server's
> interface-agnostic `/api/v1` and Jellyfin's data model, and contains zero domain
> logic (BRIEF §11). See [`architecture.md`](./architecture.md) for the boundary and
> [`api.md`](./api.md) for the contract it consumes. This doc is only about the
> Jellyfin-facing coupling.

## Pinned versions

| What | Value |
|---|---|
| Jellyfin server target | **10.11.11** |
| Docker image | `jellyfin/jellyfin:10.11.11` (`docker-compose.dev.yml`) |
| `Jellyfin.Controller` NuGet | **10.11.11** (`plugin/Streamarr.Plugin/Streamarr.Plugin.csproj`) |
| Plugin `targetAbi` | **10.11.11.0** (`plugin/Streamarr.Plugin/meta.json`) |
| Plugin target framework | `net9.0` |

The `Jellyfin.Controller` package version, the plugin `targetAbi`, and the Jellyfin
docker image tag MUST stay in lockstep. `Jellyfin.Controller` is referenced with
`<Private>false</Private>` + `ExcludeAssets=runtime`, so the host supplies the assemblies
at runtime and the plugin ships only its own DLL.

## Interfaces the plugin binds (10.11.x ABI)

Compiled, tested, and host-loaded against `Jellyfin.Controller` 10.11.11:

- `MediaBrowser.Controller.Library.IMediaSourceProvider`
  - `Task<IEnumerable<MediaSourceInfo>> GetMediaSources(BaseItem, CancellationToken)`
  - `Task<ILiveStream> OpenMediaSource(string openToken, List<ILiveStream> current, CancellationToken)`
  - There is **no** `CloseLiveStream` on the provider — teardown is `ILiveStream.Close()`
    (which the plugin maps to `POST /api/v1/sessions/{token}/close`).
- `MediaBrowser.Controller.Library.ILiveStream` — implemented by `StreamarrLiveStream`
  (note it also requires `IDisposable.Dispose()`).
- `MediaBrowser.Controller.Plugins.IPluginServiceRegistrator.RegisterServices(IServiceCollection, IServerApplicationHost)`.
- `MediaBrowser.Controller.Session.ISessionManager` — `PlaybackStart` / `PlaybackProgress`
  / `PlaybackStopped` events (args `PlaybackProgressEventArgs` / `PlaybackStopEventArgs`).
- `MediaBrowser.Model.Tasks.IScheduledTask` — the "sync pinned work" bootstrap task and the
  M6 "clean up ephemeral items" TTL task (`ScheduledTasks/EphemeralCleanupTask.cs`).

If any of these signatures change in a future Jellyfin release, the coupling is isolated
to `MediaSources/` and `Playback/` and this file must be updated.

## ⚠️ Known-fragile: search interception (BRIEF §8.2, §11, §13)

The search-interception feature (M6) is the **most version-sensitive** part of the plugin.
All of its coupling to Jellyfin's HTTP pipeline is deliberately isolated in a **single file**:
`Search/StreamarrSearchActionFilter.cs`. Everything else in `Search/`
(`SearchInjection.cs`) is host-free, ordinary data-shaping that is unit-tested without a
Jellyfin server.

The filter binds to these 10.11.x contracts (verified against `Jellyfin.Controller` 10.11.11):

- `/Items`, `/Shows/{seriesId}/Seasons`, and `/Shows/{seriesId}/Episodes` return
  `MediaBrowser.Model.Querying.QueryResult<BaseItemDto>`; `/Search/Hints` returns
  `MediaBrowser.Model.Search.SearchHintResult`. Both the concrete route family and response
  value type are checked because unrelated people/artist endpoints reuse these DTOs.
- The `searchTerm` query-string key selects search requests.
- Jellyfin's series page uses `/Shows/{seriesId}/Seasons`; its season page uses
  `/Shows/{seriesId}/Episodes` with either `seasonId` or `season`. `/Items?parentId=` is
  supported as the generic lazy-navigation fallback.
- `MediaBrowser.Controller.Dto.IDtoService.GetBaseItemDto(BaseItem, DtoOptions, User, BaseItem)`
  turns a materialized ephemeral item into a `BaseItemDto`.
- `SearchHint.Id` (rather than the obsolete `SearchHint.ItemId`).
- The filter is injected into the MVC pipeline from `PluginServiceRegistrator` via
  `serviceCollection.Configure<MvcOptions>(o => o.Filters.Add<StreamarrSearchActionFilter>())`.
  This is the plugin-side registration mechanism for a global `IAsyncActionFilter`. (The
  meilisearch reference plugin plugs into search a different way — an `IExternalSearchProvider`
  — but BRIEF §8.2 mandates an action filter so the raw `QueryResult`/hints can be mutated.)

**Fail-safe contract (non-negotiable, BRIEF §11):** every path in the filter is wrapped so any
error, timeout, ABI mismatch, or unreachable/killed Core Server falls through to the
**unmodified native result**. Disabling `InterceptionEnabled` makes the filter inert. The
host-free tests cover merge/dedup and guarded data shaping; the real-host smoke also
executes both HTTP fall-through scenarios below against the pinned Jellyfin image.

If a future Jellyfin release changes any of the above, **only `StreamarrSearchActionFilter.cs`
needs updating** — update it and re-run the headless load + fall-through check.

### Hardened adapter boundary

The plugin remains a pure adapter: it never selects or ranks a fallback. It does,
however, enforce the boundary around its machine-authenticated Core client:

- **Playback offers are capabilities, not release ids.** `GetMediaSources` creates an
  opaque, bounded, replay-safe `OpenToken` tied to the authenticated Jellyfin user, item,
  work, and offered release. Idle offers expire after ten minutes; active playback holds
  the lease and final close starts the replay window. `OpenMediaSource` validates the token before
  any call to Core; arbitrary caller-controlled release ids never reach `/resolve`.
- **Server fallback is constrained and attributed.** `POST /api/v1/resolve` may walk
  next-best releases of the same work (bounded by `Streamarr:MaxFallbackHops`) and
  return an `attempts` trail plus `fallbackFromReleaseId`. The plugin accepts the
  result only when every attempted/resolved release belongs to the original offered
  work and any changed release is attributed to the offered request. A dead response's
  `suggestedFallbackReleaseId` is followed at most once and under the same checks.
- **Media auth is session-scoped.** The opened source carries only Core's short-lived
  stream capability in its `Path`; `RequiredHttpHeaders` contains no machine key or
  admin credential. Direct remote-source clients such as Streamyfin use this `Path`
  verbatim when `IsRemote = true` and `Protocol = Http`, so the plugin rebases the
  capability onto its separately configured client-reachable public stream URL instead
  of leaking a container-only Core control hostname.
- **The connection budget is global.** Concurrent Jellyfin streams share the same
  `Streamarr:ConnectionBudget` gate as every other client; the plugin does no
  connection accounting of its own. Per-provider/​budget state is observable at
  admin-authenticated `GET /api/v1/metrics`.

### Required search fall-through check

With `jellyfin/jellyfin:10.11.11`, the built plugin mounted, and the startup wizard
completed via the API, verify both rows after every Jellyfin upgrade:

| Scenario | Expected `/Search/Hints` | Expected `/Items?searchTerm=` |
|---|---|---|
| Interception **off** (default) | `200` (native) | `200` (native) |
| Interception **on**, Core Server **unreachable** | `200` (native, fast fall-through) | `200` (native) |

Reachable-host acceptance must additionally search for a TV title, assert that the injected
item is a `Series`, open `/Shows/{id}/Seasons`, then open one returned season through
`/Shows/{id}/Episodes`. The latter must return the complete canonical episode directory,
including episodes without media sources; only available episodes expose playback offers.

The current 10.11.11 real-host smoke verifies both rows plus reachable injection through
both endpoints, the exact Jellyfin Web grouped-search request, movie detail and PlaybackInfo,
series → seasons → episodes navigation, available/unavailable episode offers, load,
connection auth, materialization, restart persistence, user-restricted playback offers,
open/close, forged/cross-user/replayed-offer rejection, and the library-integration
contract: the "Streamarr" library view exists for permitted users, ephemeral items join
their recursive root/Latest queries, recorded progress puts an item into
`/UserItems/Resume` (Continue Watching), a favorite toggle keeps it in `IsFavorite`
queries, and a user with no media-folder access continues to see nothing anywhere.
Full injection of real Usenet works into a client's search
(plus duplicate-free repeat behavior and TTL cleanup) requires a live Core
Server with real indexer/provider credentials and a real client — that is the manual checklist in
[`m5-acceptance.md`](./m5-acceptance.md#milestone-6--search-interception--ttl-cleanup). The
dedup and TTL-expiry logic themselves are unit-tested (`SearchInjectionTests`,
`EphemeralCleanupTests`).

## ⚠️ Known-fragile: Swiftfin playback compatibility

Swiftfin (iOS/tvOS, both the shipped 1.x app and the rewritten player) only implements
remote/live media sources for **Live TV channels** (`isLiveStream` is literally
`channelType == .tv`). For a movie/episode backed by a Streamarr `RequiresOpening` source it
requests `/Videos/{itemId}/stream?static=true` — which the server cannot satisfy, because the
bytes exist only behind an opened live stream. The result is the generic "Unable to load this
item" alert, while Jellyfin Web (always transcodes → `TranscodingUrl` carries the
`LiveStreamId`) and Streamyfin (plays `MediaSource.Path` verbatim) work.

The shim is isolated in a **single file**, `Playback/StreamarrPlaybackCompatibilityFilter.cs`,
and rewrites only `POST /Items/{itemId}/PlaybackInfo` requests that pass **all** guards —
`SwiftfinCompatibilityEnabled` (on by default), a `Jellyfin-Client` auth claim starting with
`Swiftfin`, and a Streamarr-owned item — to `AutoOpenLiveStream = true` +
`EnableDirectPlay = false`. Jellyfin then opens the Core session itself and answers with a
`TranscodingUrl` that carries the `LiveStreamId` — an HLS **remux** (ffmpeg stream-copy from
the Core capability URL; no re-encode while the codecs fit the client profile), so plugin
open/close session accounting is unchanged. Clients that implement the protocol fully are
never touched.

The filter binds to these 10.11.x contracts (verified against Jellyfin 10.11.11 source):

- the `POST /Items/{itemId}/PlaybackInfo` route shape
  (`MediaInfoController.GetPostedPlaybackInfo`);
- that controller's parameter merge order: the **query-bound** `autoOpenLiveStream` /
  `enableDirectPlay` arguments take precedence over the posted `PlaybackInfoDto` body, which
  is what lets the filter override them without referencing `Jellyfin.Api` types;
- the `Jellyfin-Client` authorization claim (`InternalClaimTypes.Client`);
- `MediaInfoHelper.SetDeviceSpecificData` disabling HTTP direct-stream and building the
  transcoding URL via `StreamInfo.ToUrl`, which appends `&LiveStreamId=`.

Related: the opened `MediaSourceInfo` keeps the **stable release-source id** of the redeemed
offer (`StreamarrMediaSourceProjection.ReleaseSourceId`) instead of the per-open live-stream
id — Swiftfin matches the PlaybackInfo response against the media-source id it selected and
rejects the response on a mismatch. Attribution stays keyed on `LiveStreamId` via the
session tracker.

**Fail-safe contract:** every path is try/catch-wrapped and every guard fails open — any
error, missing claim, or renamed controller parameter leaves the request untouched (native
behavior), never a broken one. Unchecking the plugin's "Swiftfin compatibility" toggle makes
the filter inert.

## Automated host-load verification

[`plugin/scripts/smoke-jellyfin.sh`](../plugin/scripts/smoke-jellyfin.sh) starts
`jellyfin/jellyfin:10.11.11` as the current non-root user with a read-only root
filesystem, all capabilities dropped, `no-new-privileges`, and bounded writable tmpfs
mounts. With the `net9.0` plugin output mounted it requires Jellyfin to become healthy
and asserts these startup messages:

```
PluginManager: Loaded assembly Streamarr.Plugin, Version=0.1.0.0 ... from /config/plugins/Streamarr/Streamarr.Plugin.dll
PluginManager: Loaded plugin: Streamarr 0.1.0.0
Streamarr.Plugin.Playback.PlaybackEventEntryPoint: Streamarr playback event reporter attached
Emby.Server.Implementations.ApplicationHost: Core startup complete
```

The script then completes the Jellyfin wizard and checks connection authorization,
materialization/restart persistence, user isolation, replay-safe playback offers, Core
open/close delivery, root/Latest isolation, reachable injection, movie release discovery,
cold season/episode expansion, and unreachable-Core fall-through. Run it with the
**Jellyfin Plugin E2E (isolated)** Codecraft action, or directly:

```bash
dotnet build plugin/Streamarr.Plugin/Streamarr.Plugin.csproj -c Release
bash plugin/scripts/smoke-jellyfin.sh
```

Full Direct Play / transcode playback requires a real client and is covered by the manual
checklist in [`m5-acceptance.md`](./m5-acceptance.md).

> The plugin folder must be mounted **read-write**: Jellyfin rewrites `meta.json`
> (plugin status) on load. A read-only mount surfaces as
> `IOException: Read-only file system : '/config/plugins/Streamarr/meta.json'`.

### Bounded plugin debug logging in the dev Jellyfin console

The Compose test stack writes Jellyfin's Serilog configuration to
`/config/config/logging.default.json`. After the `streamarr-jellyfin` container has
completed its first startup, enable Debug for only the plugin namespace from the repository
root:

```bash
docker exec streamarr-jellyfin sh -c \
  'cat /config/config/logging.default.json' \
  | jq '.Serilog.MinimumLevel.Override["Streamarr.Plugin"] = "Debug"' \
  | docker exec -i streamarr-jellyfin sh -c '
      umask 077
      file=/config/config/logging.default.json
      tmp="$file.tmp"
      cat >"$tmp"
      mv "$tmp" "$file"
    '
docker restart streamarr-jellyfin
```

Reproduce the request, then read a bounded, namespace-filtered slice of the Jellyfin console:

```bash
docker logs --since 10m --tail 400 streamarr-jellyfin 2>&1 \
  | rg 'Streamarr\.Plugin'
```

Do not dump the container environment or
`/config/plugins/configurations/Streamarr.Plugin.xml`: both can contain credentials.
The plugin's structured search diagnostics report route/constraint decisions and bounded
result counts, not the Core API key or playback capability tokens. Keep log requests bounded
with both `--since` and `--tail` before sharing them.

Return the namespace to Jellyfin's default level after debugging:

```bash
docker exec streamarr-jellyfin sh -c \
  'cat /config/config/logging.default.json' \
  | jq 'del(.Serilog.MinimumLevel.Override["Streamarr.Plugin"])' \
  | docker exec -i streamarr-jellyfin sh -c '
      umask 077
      file=/config/config/logging.default.json
      tmp="$file.tmp"
      cat >"$tmp"
      mv "$tmp" "$file"
    '
docker restart streamarr-jellyfin
```

## Re-testing on a Jellyfin upgrade

The action filter couples to Jellyfin's HTTP pipeline and **must be re-verified on
every Jellyfin release** (BRIEF §11, §13). To move to a new patch/minor:

1. **Bump the pinned versions together** (the server/Controller/ABI versions must
   match, and the framework must be supported by that Jellyfin line):
   - `Jellyfin.Controller` NuGet in `plugin/Streamarr.Plugin/Streamarr.Plugin.csproj`,
   - `targetAbi` in `plugin/Streamarr.Plugin/meta.json`,
   - `TargetFramework` in `plugin/Streamarr.Plugin/Streamarr.Plugin.csproj` and
     `framework` in `plugin/Streamarr.Plugin/meta.json`,
   - the `jellyfin/jellyfin:<tag>` image in `docker-compose.dev.yml`,

   and update the **Pinned versions** table above.
2. **Rebuild** the plugin (`dotnet build -c Release`, warnings-as-errors) and run
   `dotnet test plugin/Streamarr.Plugin.sln` — the mapper, replay-safe offer, bounded
   store/dispatcher, transport-security, search-injection, visibility, and cleanup
   tests must stay green.
3. **Re-run the headless load + fall-through check** (the tables above): load the plugin
   into the pinned docker image with **zero** exceptions from `Streamarr.Plugin.Search`,
   then confirm `/Search/Hints` and `/Items?searchTerm=` return `200` both with
   interception off and with interception on while the Core Server is unreachable.
   Run `bash plugin/scripts/smoke-jellyfin.sh` for the automated host-load portion.
4. **Re-check the bound interfaces** against the new `Jellyfin.Controller` (the two
   lists above). If a signature moved, the fix is confined to `MediaSources/`,
   `Playback/` (including `Playback/StreamarrPlaybackCompatibilityFilter.cs` and its
   PlaybackInfo parameter names), or the single `Search/StreamarrSearchActionFilter.cs`
   file.
5. **Run the manual acceptance** in [`m5-acceptance.md`](./m5-acceptance.md) once with a
   real client + real credentials (Direct Play, forced transcode, session teardown,
   events, and search injection).
