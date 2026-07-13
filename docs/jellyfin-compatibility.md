# Jellyfin compatibility

The Streamarr plugin's search interception and media-source APIs are version-sensitive
(BRIEF §8, §11; DECISIONS.md #2). This document pins the exact versions the plugin is
built and tested against. Change these three values together and re-run the load check.

> The plugin is a **thin adapter** — it translates between the Core Server's
> interface-agnostic `/api/v1` and Jellyfin's data model, and contains zero domain
> logic (BRIEF §11). See [`architecture.md`](./architecture.md) for the boundary and
> [`api.md`](./api.md) for the contract it consumes. This doc is only about the
> Jellyfin-facing coupling.

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

### M7 relationship — the plugin stays thin; the Core got smarter

M7 hardened the **Core Server**, not the plugin. The plugin remains a pure adapter, and
nothing in this file changed shape. Two M7 behaviours are worth noting for anyone
debugging the Jellyfin path:

- **Server-side auto-fallback backstops the plugin's manual fallback.** BRIEF §8.4 has
  the plugin follow `suggestedFallbackReleaseId` **once** on a dead release. As of M7,
  `POST /api/v1/resolve` already walks the next-best releases of the work itself
  (bounded by `Streamarr:MaxFallbackHops`) and returns the first healthy one, with an
  `attempts` trail and `fallbackFromReleaseId`. So by the time the plugin sees a
  response, the Core has usually *already* recovered — the plugin's single-hop retry is
  now a rarely-exercised backstop, not the primary mechanism. Fallback selection is a
  Core concern (BRIEF §11); the plugin still decides nothing.
- **The connection budget is global.** Concurrent Jellyfin streams share the same
  `Streamarr:ConnectionBudget` gate as every other client; the plugin does no
  connection accounting of its own. Per-provider/​budget state is observable at
  `GET /api/v1/metrics`.

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

## Re-testing on a Jellyfin upgrade

The action filter couples to Jellyfin's HTTP pipeline and **must be re-verified on
every Jellyfin release** (BRIEF §11, §13). To move to a new patch/minor:

1. **Bump the three pinned values in lockstep** (they must always match):
   - `Jellyfin.Controller` NuGet in `plugin/Streamarr.Plugin/Streamarr.Plugin.csproj`,
   - `targetAbi` in `plugin/Streamarr.Plugin/meta.json`,
   - the `jellyfin/jellyfin:<tag>` image in `docker-compose.dev.yml`,

   and update the **Pinned versions** table above.
2. **Rebuild** the plugin (`dotnet build -c Release`, warnings-as-errors) and run
   `dotnet test plugin/Streamarr.Plugin.sln` — the host-free mapper/store/tracker,
   `SearchInjectionTests`, and `EphemeralCleanupTests` must stay green.
3. **Re-run the headless load + fall-through check** (the tables above): load the plugin
   into the pinned docker image with **zero** exceptions from `Streamarr.Plugin.Search`,
   then confirm `/Search/Hints` and `/Items?searchTerm=` return `200` both with
   interception off and with interception on while the Core Server is unreachable.
4. **Re-check the bound interfaces** against the new `Jellyfin.Controller` (the two
   lists above). If a signature moved, the fix is confined to `MediaSources/`,
   `Playback/`, or the single `Search/StreamarrSearchActionFilter.cs` file.
5. **Run the manual acceptance** in [`m5-acceptance.md`](./m5-acceptance.md) once with a
   real client + real credentials (Direct Play, forced transcode, session teardown,
   events, and search injection).
