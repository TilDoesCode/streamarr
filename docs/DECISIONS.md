# Design decisions (confirmed 2026-07-12)

These resolve Section 13 of `docs/BRIEF.md`. They are settled — do not re-litigate
them in later milestones without the project owner's sign-off.

| # | Decision | Outcome |
|---|---|---|
| 1 | **Licensing** | **GPL-3.0 accepted for the whole project.** Radarr/Sonarr parser regexes, quality definitions, and scoring logic MAY be ported directly (shallow clones in `refs/` for reference). `server/` and `web/` are GPL-3.0 (see `LICENSE`). nzbdav (MIT) is vendored with attribution — MIT is GPL-compatible. Attribute every ported file in a header comment (source repo + path). |
| 2 | **Jellyfin target version** | **10.10.x stable.** Pin the exact patch release in `docs/jellyfin-compatibility.md` when M5 starts; integration-test the action filter against it. |
| 3 | **Ephemeral item isolation** | ~~Dedicated hidden virtual folder / collection, excluded from Latest & recommendations (brief default).~~ **Revised 2026-07-17 (owner request): library integration.** The plugin folder is a `BasePluginFolder` below the user root that surfaces as its own "Streamarr" library; items are materialized as built-in `Movie`/`Series`/`Season`/`Episode` types so they participate in Continue Watching, Next Up, Favorites and per-library Latest. Access mirrors the compatible-library rule (plus native EnabledFolders/BlockedMediaFolders controls); a `LibraryEnabled=false` plugin setting restores the fully isolated placement. Engaged items (resume position, favorite, watched) are exempt from TTL cleanup and evicted last at the capacity bound. |
| 4 | **Materialization** | Real persisted ephemeral items with stable GUIDs derived from `workId` — not pure request interception (brief default). |
| 5 | **Watch state** | Plugin reports playback events to `POST /api/v1/events` from day one. No user-facing watch-state feature in v1 (brief default). |
| 6 | **Multi-provider Usenet** | **Schema, config API, and UI support multiple priority-ordered providers from M1/M3.** Actual failover logic (primary → block account) lands in M7. The NNTP pool is written against a provider list from the start so M7 is additive. |
| 7 | **SPA router / codegen** | **TanStack Router** (typed routes, first-class TanStack Query integration) + **openapi-typescript** for generated types with a thin typed fetch wrapper. Justify in `web/README.md`. |

## Repo conventions

- Layout: `server/` (ASP.NET Core, .NET 8), `plugin/` (Jellyfin net9.0), `web/`
  (React 19 + Vite), `docs/`, `refs/` (git-ignored reference clones).
- Work lands on `main`; every milestone task commits granular, test-passing commits
  and pushes. `dotnet` lives at `~/.dotnet/dotnet` (PATH is set in `~/.zprofile`).
- API style: ASP.NET Core **controllers** (consistency rule from the brief).
- The Management UI must always work with Jellyfin absent — treat a regression there
  as a build break (brief §3.1 rule 4).

## Open items (owner input needed, non-blocking)

- **Real Usenet provider credentials + a Newznab indexer API key** are required for
  the M1 acceptance measurement ("cold-start and seek latency against the real
  provider") and for end-to-end search validation in M2. Until provided, all
  integration tests run against the in-repo mock NNTP server and canned Newznab XML
  fixtures, and the real-provider measurement is tracked as an open checklist item in
  `docs/m1-latency.md`. Configure real credentials via `appsettings.Local.json` or
  the Management UI once available.
- Exact Jellyfin 10.10.x patch version the owner runs (needed at M5).
