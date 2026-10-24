# MYLIST — "My List" / watchlist with new-episode monitoring

Status: done

Branch `feat/mylist` (worktree `streamarr-worktrees/mylist`), based on 0.18.0.

## Intent

User request (2026-10-23, "very important"): a My List tab that automatically holds every series the viewer started
(no Next Up cutoff), lets the viewer add movies, series and single seasons, derives the status (want to watch →
watching → caught up → watched) and progress, and flags series with a newly *available* episode (usable releases, not
just TMDB listing) with a badge. The server monitors availability in the background. Optional operator Pushover event.

PLAN.md §1 listed favorites/watchlist as out of scope for v1; the user lifted that on 2026-10-23 (recorded in PLAN §2
and BACKLOG).

## Log

- Read BRIEF, DECISIONS, PLAN §2–§4. Explored watch state (WatchStateService, NextUpService, CurrentEpisodeRule),
  availability (CatalogSpecStore, ViewerCatalogService season lookups, SpecWarmupService) and Pushover.
- Server first (entity, migration with backfill, service, monitor, controller, tests), OpenAPI frozen, then web
  settings toggle, then client (tab, screen, badge, toggles, tests), then Dev World + Playwright screenshots.

## Decisions

- **Recorded the user decision** in PLAN.md §1/§2 (watchlist now in scope) and a BACKLOG section.
- **One table** `ViewerListEntries` (unique ViewerId+WorkId, cascade with the viewer). Removing a series keeps a
  tombstone (`Dismissed`) so auto-add never brings it back; movies and seasons are deleted. Adding it by hand undoes it.
- **Status is derived on every request** (no stored status): want_to_watch (nothing played) → watching (a playable next
  episode or resume point) → caught_up (all aired episodes with releases played; upcoming episode or next one without
  releases) → watched (movie played; season fully played; series ended per TMDB `status` and fully played). Optional
  viewer override (`want_to_watch`/`watched`) holds until the next playback after it.
- **TMDB series status** added to `TmdbTvSeriesCatalog.Status` (+ `Ended`) — needed for "ended series → watched / not
  polled". Dev World fixture: Pioneer One and Sherlock are `Ended`.
- **"New" rule (monitor)**: target = first unplayed episode after the viewer's furthest played one (same order as next
  up, but no window/limit). Only searched when it aired **and** the viewer was caught up when it aired (air date ≥ date
  of the last played episode, or the monitor already saw them wait for it = `PendingEpisodeWorkId`). Viewers who are
  behind are never searched for. Flag only when the version lookup (the normal ranked, non-rejected, not-known-dead
  rule of `CatalogSpecStore.Available`) says available. Each episode flagged once per entry
  (`LastNotifiedEpisodeWorkId`). Playing it or `POST …/seen` clears the flag.
- **Indexer load**: one season lookup serves every viewer waiting on that season; per-season re-check
  `RecheckMinutes` (180), once a day for episodes that aired > `StaleAfterDays` (14) ago, `DailyCap` (150),
  `Concurrency` 1, pass every 30 min after a 120 s start delay. A 503 (all indexers down) or 429 stops the pass without
  changing anything and without setting a back-off. Ended + fully watched entries get `FinishedCheckedAt` and are only
  looked at weekly (no TMDB polling). Monitor off switch `Streamarr:MyList:MonitorEnabled`.
- **Notifications**: no push channel exists → in-app: `GET /viewer/list/summary` (`newCount`) polled by the app every
  3 min + on focus + after playback (list keys live under `['account', id, 'watch', 'list', …]`, so
  `invalidateWatchQueries` refreshes them). Operator Pushover event `NewEpisode` behind the new
  `NotificationConfig.NotifyNewEpisodes` column (default off), toggle in the web admin notification settings.
- **Client**: tab `mylist` between Series and Settings (Bookmark icon; SF `bookmark`, Material `bookmark`); shared
  detail routes moved to group `(home,search,movies,series,mylist)` so details open inside the tab's stack. Page = title
  + "New episodes in N titles" + shelves New episodes · Continue watching · Want to watch · Caught up · Watched (poster
  cards: NEW badge, progress bar, "S1, E4 · 3/4" / "Next episode {date}" / "Not available yet"). Opening a NEW card
  calls `seen`. Badges: rail (count pill on the icon), web top bar, `NativeTabs.Trigger.Badge` (phones/Apple TV).
  Toggles: large detail = round glass button next to Watched (movie, series; series with >1 season also a season
  toggle for the season on stage); phone = "My List" in the action row + labelled season button under the season
  chips; season page = labelled button.
- New error codes `invalid_status`, `list_full` documented, known to the client, translated.

## Files

- Server: `Viewers/MyList/{MyListContracts,MyListScanner,MyListService,MyListMonitor,MyListTracking}.cs`,
  `Viewers/Controllers/ViewerListController.cs`, `Persistence/Entities/ViewerListEntryEntity.cs`,
  migration `20261023212639_ViewerMyList` (table + `NotifyNewEpisodes` + backfill of started series), DbContext,
  `WatchStateService` (auto-add/clear hook in `ReportAsync`/`SetPlayedAsync`, shared viewer lock),
  `ViewerCatalogService.RefreshSeasonAvailabilityAsync`, options `StreamarrOptions.MyList`, Pushover kind,
  notification config/contract, `Streamarr.Core/Tmdb/TmdbTvCatalog.cs` + `TmdbClient.cs` (series status),
  Dev World fixture status. OpenAPI `server/openapi/v1.json`.
- Tests: `Viewers/MyListTestHost.cs`, `Viewers/MyListTests.cs` (7), `NotificationConfigServiceTests` extended.
- Web: `notification-settings.tsx` (+ test), `schema.d.ts`.
- Client: `src/mylist/{queries.ts,sections.ts,tab-badge.tsx,list-toggle.tsx}`, `src/screens/mylist/mylist-screen.tsx`,
  routes `src/app/(app)/(tabs)/(mylist)/`, group rename, `navigation/{tabs.ts,tab-stack.tsx,native-tabs-shell.tsx,
  web-shell.tsx}`, `shell/shell-rail.tsx`, detail screens (`movie-screen`, `series-screen`, `series-stage`,
  `season-screen`), icons, i18n en/de, error codes, `jest/app-routes.tsx`, `jest/mylist-world.tsx`, tests.
- Docs: `docs/api.md` (§ My List, notifications), `docs/viewers.md`, `docs/configuration.md`, PLAN, BACKLOG.

## Verification

- `dotnet build server/Streamarr.sln -c Release`: 0 errors.
- `dotnet test server/Streamarr.sln -c Release --no-build`: Usenet 247/247, Core 505/505, DevWorld 91/91,
  Server 1569/1582 — the 13 failures are all `Transcoding.RemuxIntegrationTests` / `TranscodingIntegrationTests` and
  fail identically when run alone: local ffmpeg 9.0.1 rejects the pipelines ("Invalid time base: -1"); no transcoding
  code is touched here. My List tests 7/7 (weekly release flagged only once releases exist + back-off; TMDB-listed but
  no release → no flag; all indexers down → no change, no back-off; new season flagged; ended series not polled;
  behind viewers never searched; manual entries/override/tombstone/age gate/per-viewer; migration backfill).
- Web: `tsc -b` clean, vitest 34 files / 245 tests.
- Client: `tsc --noEmit` clean, `expo lint` clean, prettier clean; jest 186 suites / 2144 tests, 2 failures in
  `src/player/__tests__/tab-guard.test.tsx` that fail the same on the untouched base (stash check). New: sections
  (4), My List screen/badge/toggle (5 + 1 navigation), native tab badge (1).
- Live: `scripts/devworld.sh start 39310 --tree` (media cache cloned from another worktree with `cp -Rc`), Expo web on
  39311, anna seeded through the API (played Sherlock S1–S2, Pioneer One E1–3, Lighthouse E1–20, Tears of Steel at
  50 %, list adds). Dev World air dates are all in the past, so the NEW flag for Lighthouse E21 was set in the Dev World
  database for the screenshots (the monitor path itself is covered by the server tests).
- Screenshots (`docs/client/screenshots/MYLIST/`): `web-tv-mylist.png`, `web-tv-mylist-caught-up-watched.png`,
  `web-tv-home-badge.png`, `web-tv-movie-list-button.png`, `web-tv-series-list-buttons.png`, `web-tv-mylist-empty.png`,
  `web-phone-mylist.png`, `web-phone-series-list-action.png`, `web-phone-mylist-empty.png`.

## Open / follow-ups

- No real push (APNs/FCM); badge polling only. NativeTabs badge unverified on iOS/tvOS (pending-ios) and the rail
  badge unverified on a Google TV box. TV page uses a plain ScrollView of shelves (no row lift); check on a box.
- Jest quirk: in one file, a test rendering after a list mutation renders nothing (expo-router test harness);
  mutation tests are last in their file (`mylist.test.tsx`, `mylist-open.test.tsx`).
- The list is derived per request (TMDB cache + watch state); add a per-viewer cache if large lists get slow.
