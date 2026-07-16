# Streamarr Jellyfin plugin

A **thin adapter** (BRIEF §8) that surfaces the Streamarr Core Server's Usenet results
inside Jellyfin and makes them playable through Jellyfin's transcoding pipeline. It
contains **zero domain logic** — no parsing, ranking, rejecting, health-checking, or
fallback decisions. Those are the Core Server's job (BRIEF §1.1, §3.1 rule 3, §11). The
plugin only translates between the Core Server's interface-agnostic API and Jellyfin's
data model.

Target: **Jellyfin 10.11.11** (`net9.0`). See [`../docs/jellyfin-compatibility.md`](../docs/jellyfin-compatibility.md).

## What it does (M5 playback + M6 search interception)

| Piece | File | Role |
|---|---|---|
| `Plugin` + config page | `Plugin.cs`, `Configuration/` | Server URL, API key, TTL, interception toggle, profile id, pinned query; "Test connection" + "Materialize pinned work" buttons |
| Typed HTTP client | `Api/StreamarrApiClient.cs` | Bounded transport over shallow `/health`, authenticated `/caps`, `/search`, `/resolve`, `/sessions/{token}/close`, and `/events` |
| Service wiring | `PluginServiceRegistrator.cs` | Registers the typed `HttpClient`, media-source provider, event bridge, scheduled tasks, and the search action filter (`Configure<MvcOptions>`) |
| Ephemeral materialization | `Library/` | One private virtual `Movie`/`Episode` per work, stable GUID from `workId`, explicit ownership ids, persisted bounded release cache, and ownership-safe TTL cleanup |
| **Search interception** ⚠️ | `Search/StreamarrSearchActionFilter.cs` | **The single version-fragile file.** `IAsyncActionFilter` over `/Items` (with `searchTerm`) + `/Search/Hints`: calls `/api/v1/search` (short timeout), materializes/merges ephemeral works. Fully try/catch-guarded behind the toggle — any error/timeout falls through to native results |
| Search merge/hint shaping | `Search/SearchInjection.cs` | Host-free, unit-tested merge + dedup + hint building (no domain logic) |
| Lazy media sources | `MediaSources/` | `IMediaSourceProvider`: one `MediaSourceInfo` per release (`RequiresOpening`) with an opaque, bounded, short-lived, one-use offer tied to the authenticated Jellyfin user/item/work/release; `OpenMediaSource` validates and consumes it before `/resolve`, accepts only an attributed same-work fallback, and exposes no reusable media auth header; `ILiveStream.Close` → capability session close |
| Playback events | `Playback/` | Hooks `ISessionManager` start/progress/stop → bounded/coalesced delivery to `POST /api/v1/events` |
| Bootstrap task | `ScheduledTasks/SyncPinnedWorkTask.cs` | "Sync one pinned work" — materializes one item for the M5 smoke test |
| **TTL cleanup task** | `ScheduledTasks/EphemeralCleanupTask.cs` | `IScheduledTask` (hourly): deletes `usenet-ephemeral` items past their TTL via `ILibraryManager` |

> **Never breaks native search.** The action filter is behind the `InterceptionEnabled` toggle
> and wraps every path in try/catch: a killed/unreachable Core Server, a timeout, or a Jellyfin
> ABI change all fall through to unmodified native results (BRIEF §8.2, §11). Verified headlessly
> — see [`../docs/jellyfin-compatibility.md`](../docs/jellyfin-compatibility.md) and
> [`../docs/m5-acceptance.md`](../docs/m5-acceptance.md#milestone-6--search-interception--ttl-cleanup).

## Build

```bash
# from repo root
(cd plugin && ~/.dotnet/dotnet build Streamarr.Plugin/Streamarr.Plugin.csproj -c Release)
```

Output: `plugin/Streamarr.Plugin/bin/Release/net9.0/` — `Streamarr.Plugin.dll` + `meta.json`
(the Jellyfin assemblies are **not** copied; the host supplies them).

## Test

```bash
(cd plugin && ~/.dotnet/dotnet test Streamarr.Plugin.sln -c Release)
```

Run the isolated real-host click-through from the repository root:

```bash
dotnet build plugin/Streamarr.Plugin/Streamarr.Plugin.csproj -c Release
bash plugin/scripts/smoke-jellyfin.sh
```

In Codecraft this is the **Jellyfin Plugin E2E (isolated)** test action. It starts the
pinned Jellyfin image with a deterministic Core fixture, executes Jellyfin Web's grouped
search request, then follows movie detail/PlaybackInfo and
series → seasons → episodes. It also checks unavailable episodes, user isolation,
restart persistence, and root/Latest isolation.

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
URL + API key, "Test connection", "Materialize pinned work". The connection test requires
both anonymous shallow health and authenticated capabilities, so a wrong machine key
fails even when Core is live. Materialized items live under a private, hidden
implementation folder and surface only through eligible intercepted searches. Full
acceptance steps are in
[`../docs/m5-acceptance.md`](../docs/m5-acceptance.md).

## Licensing

Streamarr is GPL-3.0 (DECISIONS.md #1). This plugin links Jellyfin (GPL-2.0) assemblies,
which is normal and expected for a Jellyfin server plugin.
