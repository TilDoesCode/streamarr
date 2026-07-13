# Streamarr Jellyfin plugin

A **thin adapter** (BRIEF §8) that surfaces the Streamarr Core Server's Usenet results
inside Jellyfin and makes them playable through Jellyfin's transcoding pipeline. It
contains **zero domain logic** — no parsing, ranking, rejecting, health-checking, or
fallback decisions. Those are the Core Server's job (BRIEF §1.1, §3.1 rule 3, §11). The
plugin only translates between the Core Server's interface-agnostic API and Jellyfin's
data model.

Target: **Jellyfin 10.10.7** (`net8.0`). See [`../docs/jellyfin-compatibility.md`](../docs/jellyfin-compatibility.md).

## What it does (M5 thin-slice)

| Piece | File | Role |
|---|---|---|
| `Plugin` + config page | `Plugin.cs`, `Configuration/` | Server URL, API key, TTL, interception toggle, profile id, pinned query; "Test connection" + "Materialize pinned work" buttons |
| Typed HTTP client | `Api/StreamarrApiClient.cs` | Transport over `/health`, `/search`, `/resolve`, `/sessions/{token}/close`, `/events` |
| Service wiring | `PluginServiceRegistrator.cs` | Registers the typed `HttpClient`, the media-source provider, the event bridge, the bootstrap task |
| Ephemeral materialization | `Library/` | One isolated `Movie` per work, stable GUID from `workId`, tag `usenet-ephemeral`, TMDB metadata passed through |
| Lazy media sources | `MediaSources/` | `IMediaSourceProvider`: one `MediaSourceInfo` per release (`RequiresOpening`), `OpenMediaSource` → `/resolve`, dead → server fallback once; `ILiveStream.Close` → session close |
| Playback events | `Playback/` | Hooks `ISessionManager` start/progress/stop → `POST /api/v1/events` |
| Bootstrap task | `ScheduledTasks/SyncPinnedWorkTask.cs` | "Sync one pinned work" — materializes one item for the M5 smoke test |

## Build

```bash
# from repo root
(cd plugin && ~/.dotnet/dotnet build Streamarr.Plugin/Streamarr.Plugin.csproj -c Release)
```

Output: `plugin/Streamarr.Plugin/bin/Release/net8.0/` — `Streamarr.Plugin.dll` + `meta.json`
(the Jellyfin assemblies are **not** copied; the host supplies them).

## Test

```bash
(cd plugin && ~/.dotnet/dotnet test Streamarr.Plugin.sln -c Release)
```

## Install

Copy the build output into Jellyfin's plugin directory:

```
<jellyfin-config>/plugins/Streamarr/
    Streamarr.Plugin.dll
    meta.json
```

Mount it **read-write** — Jellyfin rewrites `meta.json` on load. The dev stack does this
for you:

```bash
docker compose -f ../docker-compose.dev.yml up --build
```

Then configure it: Jellyfin → Dashboard → Plugins → **Streamarr** → set the Core Server
URL + API key, "Test connection", "Materialize pinned work". Full acceptance steps are in
[`../docs/m5-acceptance.md`](../docs/m5-acceptance.md).

## Licensing

Streamarr is GPL-3.0 (DECISIONS.md #1). This plugin links Jellyfin (GPL-2.0) assemblies,
which is normal and expected for a Jellyfin server plugin.
