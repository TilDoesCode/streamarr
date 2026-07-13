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
- `MediaBrowser.Model.Tasks.IScheduledTask` — the "sync pinned work" bootstrap task.

If any of these signatures change in a future Jellyfin release, the coupling is isolated
to `MediaSources/` and `Playback/` and this file must be updated.

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
