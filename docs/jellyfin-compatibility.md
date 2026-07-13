# Jellyfin compatibility

The Streamarr plugin's search interception and media-source APIs are version-sensitive
(BRIEF §8, §11; DECISIONS.md #2). This document pins the exact versions the plugin is
built and tested against. Change these three values together and re-run the load check.

## Pinned versions

| What | Value |
|---|---|
| Jellyfin server target | **10.10.7** (stable, 10.10.x line) |
| Docker image | `jellyfin/jellyfin:10.10.7` (`docker-compose.dev.yml`) |
| `Jellyfin.Controller` NuGet | **10.10.7** (`plugin/Streamarr.Plugin/Streamarr.Plugin.csproj`) |
| Plugin `targetAbi` | **10.10.7.0** (`plugin/Streamarr.Plugin/meta.json`) |
| Plugin target framework | `net8.0` |

The `Jellyfin.Controller` package version, the plugin `targetAbi`, and the Jellyfin
docker image tag MUST stay in lockstep. `Jellyfin.Controller` is referenced with
`<Private>false</Private>` + `ExcludeAssets=runtime`, so the host supplies the assemblies
at runtime and the plugin ships only its own DLL.

## Interfaces the plugin binds (10.10.x ABI)

Verified by reflection against `Jellyfin.Controller` 10.10.7:

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

The filter binds to these 10.10.x contracts (verified against `Jellyfin.Controller` 10.10.7):

- The `/Items` action returns `MediaBrowser.Model.Querying.QueryResult<BaseItemDto>`, and
  `/Search/Hints` returns `MediaBrowser.Model.Search.SearchHintResult`. We **dispatch on the
  response value type**, not on the route string, so a route rename alone does not break us.
- The `searchTerm` query-string key selects search requests.
- `MediaBrowser.Controller.Dto.IDtoService.GetBaseItemDto(BaseItem, DtoOptions, User, BaseItem)`
  turns a materialized ephemeral item into a `BaseItemDto`.
- `SearchHint.Id` (note: `SearchHint.ItemId` is `[Obsolete]` in 10.10 — we set `Id`).
- The filter is injected into the MVC pipeline from `PluginServiceRegistrator` via
  `serviceCollection.Configure<MvcOptions>(o => o.Filters.Add<StreamarrSearchActionFilter>())`.
  This is the plugin-side registration mechanism for a global `IAsyncActionFilter`. (The
  meilisearch reference plugin plugs into search a different way — an `IExternalSearchProvider`
  — but BRIEF §8.2 mandates an action filter so the raw `QueryResult`/hints can be mutated.)

**Fail-safe contract (non-negotiable, BRIEF §11):** every path in the filter is wrapped so any
error, timeout, ABI mismatch, or unreachable/killed Core Server falls through to the
**unmodified native result**. Disabling `InterceptionEnabled` makes the filter inert. This is
verified headlessly (see below): with the filter registered, `/Search/Hints` and
`/Items?searchTerm=` return `200` both with interception off and with interception on while the
Core Server is unreachable.

If a future Jellyfin release changes any of the above, **only `StreamarrSearchActionFilter.cs`
needs updating** — update it and re-run the headless load + fall-through check.

### Headless fall-through verification (M6)

`docker run jellyfin/jellyfin:10.10.7` with the built plugin mounted, startup wizard completed
via the API, then:

| Scenario | `/Search/Hints` | `/Items?searchTerm=` |
|---|---|---|
| Interception **off** (default) | `200` (native) | `200` (native) |
| Interception **on**, Core Server **unreachable** | `200` (native, fast fall-through) | `200` (native) |

Jellyfin logs show the plugin assembly + plugin loading with **zero** exceptions from
`Streamarr.Plugin.Search`. Full injection of real Usenet works into a client's search (and the
duplicate-free repeat behavior, and TTL cleanup deleting items) requires a live Core Server with
real indexer/provider credentials and a real client — that is the manual checklist in
[`m5-acceptance.md`](./m5-acceptance.md#milestone-6--search-interception--ttl-cleanup). The
dedup and TTL-expiry logic themselves are unit-tested (`SearchInjectionTests`,
`EphemeralCleanupTests`).

## Headless load verification

`docker run` of `jellyfin/jellyfin:10.10.7` with the built plugin bind-mounted into
`/config/plugins/Streamarr` logs, with **zero errors**:

```
PluginManager: Loaded assembly Streamarr.Plugin, Version=0.1.0.0 ... from /config/plugins/Streamarr/Streamarr.Plugin.dll
PluginManager: Loaded plugin: Streamarr 0.1.0.0
Streamarr.Plugin.Playback.PlaybackEventEntryPoint: Streamarr playback event reporter attached
```

This confirms assembly load, `IPluginServiceRegistrator` execution, the hosted
event-reporter service, and (implicitly) that the `IMediaSourceProvider` registration
did not throw. Full Direct Play / transcode playback requires a real client and is
covered by the manual checklist in [`m5-acceptance.md`](./m5-acceptance.md).

> The plugin folder must be mounted **read-write**: Jellyfin rewrites `meta.json`
> (plugin status) on load. A read-only mount surfaces as
> `IOException: Read-only file system : '/config/plugins/Streamarr/meta.json'`.
