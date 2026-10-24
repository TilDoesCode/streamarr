# STATUS — viewer service status (banner, verdict, admin outage notifications)

Status: done

Intent: worktree /Volumes/DevSSD/Development/streamarr-worktrees/watchlist-diagnostics (branch feat/watchlist-diagnostics).
Cheap viewer status endpoint GET api/v1/viewer/diagnostics/status (state, categories, impact codes, since, checkedAt,
adminNotified) fed by the shared diagnostics snapshot + a background refresher; Pushover opt-in "service outage /
recovered" (debounced); client banner on Home/Search/My List, verdict on the diagnostics screen, status entry + dot in
Settings and on the Settings tab, "Show server status" on playback failure + search error. Dev World 39320, Expo web 39321.

## Log
- Server: ServiceStatusTracker maps every diagnostics report to four viewer categories (search = indexers,
  usenet = providers, metadata = TMDB, server = database/disk/stream slots), the overall state (down when search,
  Usenet or the database cannot work; TMDB down alone is degraded), impact codes and `since` per problem and per
  category (in memory; a restart starts over). Every report feeds it (viewer/admin diagnostics, refresher).
- GET api/v1/viewer/diagnostics/status serves the tracked status; it checks once (through the shared snapshot cache)
  only when nothing was tracked yet or the last check is older than two refresh periods. Rate limit 30/min per user.
  No names, hosts, error codes or texts (test asserts the raw JSON).
- ServiceStatusRefresher (hosted): first check after 30 s, then every `Diagnostics:StatusRefreshSeconds` (180,
  clamped 60–900, 0 = off), one at a time, BuildAsync(refresh: false) so the 30 s snapshot cache and the probes'
  own timeouts apply; cancels cleanly. Test hosts set it to 0 (ViewerApiFactory) except the refresher fixture.
- Notifications: opt-in NotifyServiceStatus (migration ServiceStatusNotification, default off). Debounce counts only
  distinct snapshots (reports reusing the cached snapshot do not count): outage after NotifyAfterChecks (2) problem
  checks, recovery after 2 good checks, nothing in between. Slowness and a full stream budget never page. An outage
  is only marked announced while the operator is subscribed, so enabling the event mid-outage still sends the start
  and never an orphan recovery. `adminNotified` = Pushover enabled + token + key + event on (cached 30 s,
  invalidated on save).
- Decision: banner wording "Der Admin wird automatisch benachrichtigt." instead of "wurde benachrichtigt": the flag
  says the operator is subscribed; the message itself goes out after two checks.
- Web: toggle "Service outage / recovered (what viewers see)" in Failures & availability.
- Client: src/diagnostics/service-status.ts (query, view model, texts) + service-status-ui.tsx (banner, verdict,
  Settings entry, tab dot, failure-card line). Poll 2 min + on focus, staleTime 30 s. A failing status call is never
  an outage; only a transport failure (network_unreachable/timeout/tls_error) shows "Server nicht erreichbar", and not
  where the screen already shows its own error state (Home rows error, Search error, My List error).
- Banner placement: Home above the rows in every layout (handheld under the hero, web large and TV at the top of the
  rows, lite TV in the list header); on TV it fades with the rows above a focused lower row and takes no initial focus
  (cards keep hasTVPreferredFocus). Search: under the heading, above the field. My List: under the heading.
  Rendered only when shown (no empty wrapper adding a gap).
- Diagnostics screen: verdict block (FocusSection pageTop) above the speed test; its button (ok: "Speedtest starten",
  otherwise "Erneut prüfen" = report refresh, which also invalidates the status) takes TV preferred focus once the
  verdict is there; the speed test button keeps it otherwise.
- Settings: first section "Serverstatus" (pageTop) with dot + verdict + last check, opens /connection; Account keeps
  pageTop and the preferred focus. Settings tab dot: rail, web top bar, NativeTabs (empty Badge = dot).
- Failure card: "Serverstatus anzeigen" before "Zurück" (withServerStatus, cardButtons unchanged for the matrix
  tests) leaves for /connection; a server-side outage is named on the card. Search error: "Serverstatus anzeigen".
- Dev World: Pushover goes to GET /devworld/pushover (never pushover.net); status check every 60 s; README explains
  how to stage outages (provider username "nobody" = Usenet down; `.down.invalid` indexer = search degraded).
- Live: outage staged on 39320 → one "Streamarr service outage" message after the second check, one "Streamarr
  service recovered" after two good checks (Dev World outbox), plus the existing per-provider outage/recovery.
- Problem: the expo-router test harness renders nothing in a file after a navigation or mutation, and a transport
  failure in the full-app world never settled → tests split into five files, each navigating/mutating last; the
  unreachable banner is tested at component level.
- Problem: Expo web was started with CI=1 (no file watching); a later edit needed a restart. Home's banner first
  rendered at desktop size on the web large shell → wrapped in ShellDesign like the other tab pages.

## Summary
Viewers see whether a problem is on the server's side: banner on Home/Search/My List, a plain verdict on Connection
& diagnostics, a status entry + dot in Settings and on the Settings tab, and "Serverstatus anzeigen" on the playback
failure card and search error. Server keeps the status current on its own and can tell the operator via Pushover.

Endpoint: GET /api/v1/viewer/diagnostics/status →
`{ state, categories: [{ id: search|usenet|metadata|server, state, since, affected, total }], impacts: [...],
since, checkedAt, adminNotified }`.

Commits: e815343 server, 47c2f94 web, cc54516 client, 81d1712 client fix, 645dc68 devworld, + docs.

## Verification
- dotnet build -c Release: 0 errors. dotnet test: Usenet 247/0, Core 512/0, DevWorld 91/0, Server 1629 passed /
  13 failed (the known ffmpeg 9.0.1 Transcoding/Remux integration failures, unchanged). New tests: ServiceStatus*
  21 (tracker 14 incl. theory rows, endpoint 4, notification e2e 1, refresher 2); Diagnostics + Notification 62/62.
- OpenAPI frozen (server/scripts/freeze-openapi.sh); web `npm run generate:api`, client `npm run gen:api`.
- web: typecheck ok, vitest 264/264, build ok.
- client: tsc ok, expo lint ok, prettier ok, jest 2180/2182 (193 suites; the 2 tab-guard failures are pre-existing).
  New: diagnostics/__tests__/service-status*.test.tsx (17), native tabs dot (1), failure card (2).
- Screenshots (Playwright, Expo web 39321 → Dev World 39320, German): docs/client/screenshots/STATUS/
  web-tv-1920-{home,search,mylist,settings,diagnostics}-outage-de.png, web-tv-1920-player-failure-de.png,
  web-tv-1920-{home,settings,diagnostics}-ok-de.png, web-phone-390-{home,settings,diagnostics}-outage-de.png,
  web-phone-390-diagnostics-ok-de.png.

## Open / follow-ups
- 1920×1080 is the web large shell; no Android TV emulator/Apple TV run (D-pad into the Home banner from the hero and
  back down to row 0 is `pending-device`; on TV, Up from row 0 still jumps to the hero via the existing guide, so the
  banner is reached from the hero with Down).
- `since` lives in memory: a server restart during an outage resets it.
- Dev World's failure card for Usenet down shows release_dead (the server's classification); the card's outage line
  still names the cause.
- The 13 transcoding test failures with ffmpeg 9.0.1 remain (environment).

## Follow-up (2026-10-24): outage-led failure card, one speed test button

Status: done

- Failure card: while the status reports a problem whose impacts include playbackUnavailable/playbackMayFail with a
  broken usenet or server category (`playbackOutage`, same mapping as the server's impacts; search, TMDB and
  slowness never count), the card leads with "Störung auf dem Server" / "Server-side outage", the body names the
  category + impact + "not your device" (+ "Der Admin wird automatisch benachrichtigt." only with adminNotified), and
  the buttons are Serverstatus anzeigen (primary, TV initial focus) · Erneut versuchen · Andere Version wählen (only if
  the server offered it) · Zurück; lower quality / VLC are dropped. Footnote line, release reason and the "pick another
  version" hint are hidden then. Without an outage the card is unchanged.
- Decision: failures an outage cannot explain keep their own card even during an outage (sign-in, access, not_found,
  the device's connection, app-internal codes such as player_internal_error/player_load_failed, capability errors).
- Decision: the status is read in a small FailureCause component under the card, so the player itself does not
  subscribe to the polled status query during playback (render-loop test).
- Diagnostics: exactly one "Speedtest starten" / "Start speed test". All fine + idle: only the verdict's button; it
  starts the test, scrolls to the speed section (native) and moves focus to its button (TV preferred focus, web
  useInitialFocus), which from then on is "Erneut testen" (+ Abbrechen while running) while the verdict's button goes.
  During a problem the verdict keeps "Erneut prüfen" and the speed section its own start button. de wording:
  "Speedtest" everywhere (section title, button, error); en "Start speed test" in both keys.
- Verification: client tsc ok, expo lint ok, prettier ok, jest 2188/2190 (194 suites; the 2 tab-guard failures are
  pre-existing). New tests: card-actions (2), failure card outage/no-outage/TV focus/sign-in (4), playbackOutage +
  German message (2), single speed button + handoff and problem-state button (in the verdict/settings tests).
- Screenshots (Dev World 39320 --tree, Expo web 39321, Usenet down via provider username "nobody", Pushover on):
  docs/client/screenshots/STATUS/web-tv-1920-player-failure-outage-de.png, web-phone-390-player-failure-outage-de.png,
  web-tv-1920-player-failure-no-outage-de.png (resolve_dead fault, no outage: unchanged card), web-tv-1920-diagnostics-ok-de.png
  (refreshed, one button), web-tv-1920-diagnostics-ok-after-speedtest-de.png (focus on "Erneut testen").
  web-tv-1920-player-failure-de.png (old footnote card) removed. Stack stopped afterwards.
- Open: on the 390 px phone the start stepper's long release names overflow the card sideways (pre-existing, not part
  of this change). TV focus verified in jest only (no device run).
