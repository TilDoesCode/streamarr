# DL-C2 — client UI (offline downloads)

Status: partial — phase A done (UI, nav, detail, settings, tests green); phase B (devices, screenshots) waits for the
orchestrator's go (DL-N/DL-S integration, one native build at a time).

Branch `fb/dl-ui` (worktree `streamarr-worktrees/dl-ui`) = `fb/dl-core` 9fa5d2a3 (fb/downloads + DL-S contract freeze +
DL-N engine freeze + DL-C1 API freeze), fast-forwarded to fb/dl-core 86eec76b (local playback). Spec: PLAN.md § "DL —
offline downloads", `downloads-plan.html` (Ablauf, Mockups, Detailseite), DL-C1 journal § "API freeze", `docs/api.md`
§ 14.

Intent: download sheet/panel (episode, movie, season pack, rest-similar, each yourself), Downloads route + nav entry +
badge, phone Library tab (Movies | Series switch), detail integration (local default, "Heruntergeladen" chip, version
marker, episode icons, season "5/10", running progress), settings section, TV focus, tests. Device verification only
after the orchestrator's go (DL-N + DL-S integrated into fb/downloads).

## Decisions

- **Sheet = route `download/[workId]`** (params `title`, `series`), presented like the version sheet (`SHEET_OPTIONS`):
  iOS formSheet (Liquid Glass) on iPhone and iPad; Android TV a focus-trapped glass side panel; Android tablet the glass
  drawer; Android phone a glass bottom sheet (own frames in `download-sheet-screen.tsx`, confirm button pinned under the
  list). Back steps back inside the flow (`pick` step → main) before the route closes; focus returns to the opener.
- **One flow, segmented switches** (mockup A/C): from an episode `Nur diese Folge | Ganze Staffel`; season scope
  `Staffelpaket` (only when a downloadable pack exists, default then) `| Rest ähnlich | Selbst wählen`. Cards are
  radios (select, then confirm in the footer); the recommended version is preselected when it fits, else the first that
  fits. Non-fitting cards stay listed, dimmed, "Passt nicht · fehlen X" and cannot be picked (TV keeps them focusable).
  Stream-only versions collapse into one line (`streamOnlyCount`). Estimated sizes read "ca. 1,4 GB".
- **Season review rows**: toggle (deselect) + "Ändern" (that episode's downloadable versions, applied at once, back to
  the review). Episodes with a download (any state) are shown ("Auf diesem Gerät" / "In deinen Downloads") and never
  selectable; episodes without a downloadable version (or not aired) are listed as such. Pack mode: rows only toggle
  (the release is the pack's), each episode's size is its candidate with the pack release, else the even share. The
  plan is asked for every usable episode except the anchor and held ones (stable query key; deselection never
  refetches). The anchor defaults to the episode the flow started from, else the first usable one; "Andere Version
  wählen" changes the anchor version and resets the similar-mode picks.
- **After start**: inline confirmation step ("Download gestartet" / "N Downloads gestartet", `Zu den Downloads`,
  `Fertig`) instead of a toast with an action (the toast has none); start failures toast.
- **Optional-provider UI hooks** (`screens/downloads/use-download-ui.ts`): the detail/nav integration reads the core
  through `useOptionalDownloadsContext()` + the core's pure helpers (`resolveLocalPlayTarget`, `downloadProgress`,
  `normalizeSeasonId`), so screens rendered without `DownloadsProvider` (existing app tests, previews) or where downloads
  do not exist (web, Apple TV, engine missing) simply show no download UI. The sheet, the Downloads screen and the
  settings section use the core hooks (they mount only where the core is). New `useOptionalActiveAccount()` next to
  `useActiveServerUrl()` in accounts-provider.
- **Nav entry visibility** = platform + engine (`useDownloadsUi()`); the permission does not hide it (existing downloads
  stay watchable, the screen and sheet explain "ausgeschaltet"). Badge = running downloads (not failed).
- **Phone Library tab = the `(movies)` tab group** relabelled "Bibliothek" (icon library / SF `rectangle.stack` /
  Material `video_library`) whose root shows a `Filme | Serien` switch (persisted in the device MMKV `library.kind`;
  `?kind=` from links wins). `(series)` stays declared as a hidden NativeTabs trigger; since a hidden native tab
  cannot be shown, `AppTabs` redirects a phone `/series` landing (deep link, iPad/Android split-screen resize from the
  rail shell) to `/movies?kind=series`, and `+native-intent` rewrites `/movies` links to `/movies?kind=movie`. Large
  shell (rail) keeps Movies + Series and gets Downloads; web shells and Apple TV unchanged (Downloads hidden trigger on
  Apple TV, filtered on web).
- **Shared title group renamed** `(home,search,movies,series,mylist)` → `(…,downloads)` so a title opened from the
  Downloads tab pushes inside that tab.
- **Detail**: Play/Resume/Start over pass no `releaseId` when a finished download exists (the player's
  `prepareLocalSource` then plays the file); cards/rows (`usePlayWork`) skip the last-played version lookup for the same
  reason; with a download the Play button stays even when the server lists no versions. Version sheet + picker list
  the downloaded version first (server entry, else the download's own `VersionDto`) with an "Auf diesem Gerät" pill and
  as the entry card; other versions still stream. Large chip row: first chip "Heruntergeladen" (ok tone) with the
  download's spec chips and "Spielt von diesem Gerät, ohne Server"; phone version card: "Heruntergeladen" badge and
  "Auf diesem Gerät". Running/paused/failed downloads show a progress card (bytes, speed, pause/resume, retry, cancel
  with confirmation). Season chips append "· 5/10 geladen". Episode cards (strip) get a corner mark (✓ / progress
  ring / !), phone rows a state-aware row action; iPad's strip context menu gains "Herunterladen".
- **Phone action row** with four items (Gesehen, Merken, Herunterladen, Details) shares the width (narrow phones).
- **Downloads screen = core `DownloadsLibrary`** (merged from fb/dl-core e7bf22a9) with my header (page title, count ·
  size, permission note, Alle pausieren / Gesehene löschen (confirm) / Verwalten → Settings); its `StorageSummary` is
  also the settings storage bar (my placeholder list and bar were removed). The offline shell's settings gain the
  Downloads section (DL-C1's request), without the "Downloads öffnen" row.
- **Permission off**: entries stay visible with a lock ("Downloads aus", read from the profile sync's cached
  `/viewer/me`, no provider needed); pressing opens the sheet which explains it; the Downloads screen shows a warning
  but keeps the downloads playable. Hidden only where downloads do not exist (platform/engine).
- **Settings copy**: "Downloads öffnen" reads "N Titel auf diesem Gerät · X GB" (the sign-out prompt of DL-C1 already
  says "N Downloads"; one wording per screen).

- **Failed downloads are replaceable** (orchestrator's DL-S codes, 2026-11-06): the sheet shows the error
  (`downloadErrorText`) + "Wähle eine andere Version – oder dieselbe, um es erneut zu versuchen", marks the failed
  release "Zuvor fehlgeschlagen" and preselects `error.params.suggestedReleaseId`, else the best other version; the core's
  `start()` replaces the failed record. In a season, failed episodes are regular rows (selected, plannable) with the
  same marker. The detail status card shows the reason and "Andere Version" (opens the sheet). `too_many_downloads` /
  `download_not_ready` are the core's waiting states (labels from DL-C1); `downloads_not_allowed` = permission off.
- Sizes that are not exact read "ca." (the task's wording), not "≈".

## Log

- 2026-11-06: read PLAN §2–4 + DL, downloads-plan.html, DL-C1 journal (API freeze), schema download DTOs, core hooks
  and candidates. `npm install` in client/. Fast-forwarded to fb/dl-core 86eec76b (local playback in the player).
- Baseline on fb/dl-ui = fb/dl-core 86eec76b before any DL-C2 change: jest **237 suites / 2464 tests, all pass**;
  `npm run typecheck` **1 pre-existing error** in DL-C1's `src/player/__tests__/local-mode.test.ts:87` (mediaInfo
  fixture lacks `channels`) — not mine, left for DL-C1 (see Requests).
- Built: segmented control, flow model + candidate card + review row + flow + frames + route, nav (tabs, native tabs,
  rail, web filter, Library tab, redirects), Downloads screen (placeholder list until DL-C1's `DownloadsLibrary`),
  settings section, detail integration, i18n (`tabs.library|downloads`, `downloads.sheet|detail|screen|settings.*`).
- Commits: 231baaed (sheet, screen, settings), 87f1fbf6 (nav), 10643f9c (detail), c519aa1f (tests).
- Full-suite runs under load (another lane building natively) timed out 3 tests at 5 s once
  (`streaming-path-device-failed`, `streaming-path-measure-all`, `screens.test` "ranks the versions with the engine…");
  all pass alone and in every later full run — load flakiness, not a regression.
- Merged fb/dl-core a6215b6d (6e0e0b96): DownloadsLibrary, offline shell, DL-S merge, notification prompt. The only
  conflict was DL-C1's amended `local-mode.test.ts` (took fb/dl-core's, as the orchestrator said); the duplicate
  `HardDrive` icon export dropped. Then 76696b22 (Downloads screen on `DownloadsLibrary`), c713b258 (offline-shell
  settings), cbeaa512 (locked entries).

- Orchestrator update (DL-S merged, error codes, Dev World fixtures: Pioneer One S01 RAR pack, mislabeled MP4/AAC →
  MKV/DTS release). Gap found: a failed download blocked the sheet ("already in your downloads") → fixed (b57051fe).
  `useDownloadsBlocked` listened to the whole query cache (React "update while rendering" warning ×3 in the detail
  tests) → only the profile query's `updated` events now (0 warnings). Merged fb/downloads (5e456723, journal only).
  Final: typecheck 0, lint 0, jest **251 suites / 2564 tests** all pass.

## Evidence

Phase A (no devices yet, by instruction). On fb/dl-ui cbeaa512:

- `npm run typecheck` → **0 errors** (the pre-existing `local-mode.test.ts` error is fixed upstream).
- `npm run lint` (expo lint) → **clean** (0 warnings, 0 errors).
- `npx jest` → **251 suites / 2561 tests, all pass** (baseline 237 / 2464; +DL-C1's merged suites; DL-C2 adds 6 suites,
  ~70 tests):
  - `screens/downloads/__tests__/download-model.test.ts` (14): default pick, season id, each/similar/pack rows, held and
    unavailable episodes, selection/request items, note order, phone/Apple TV/no-engine tab sets, rail, `/movies` links.
  - `download-sheet.test.tsx` (16): movie list (recommended preselected, "about", VLC + PGS hint, stream-only footer,
    start → items → confirmation → "Go to Downloads"), not fitting (blocked, first fitting preselected), nothing fits,
    empty, already downloaded, permission off, unsupported, German strings; season from an episode (scope switch,
    plan anchored on it), pack (3/3 complete, deselect, held episode skipped, items per episode with the pack
    release), rest similar (markers, change → pick → Back → pick, deselect, items, "2 downloads started"), new anchor
    asks the plan again, each yourself (prefill, change), too big (disabled + reason, deselect enables), no
    downloadable version; Android TV frame (dialog) + Back leaves the pick step.
  - `detail-downloads.test.tsx` (9): large chip "Downloaded" + 2160p chips + "Plays from this device…", Play without
    `releaseId`; version sheet: downloaded version first with "On this device", another one streams with its
    `releaseId`; phone card + action row; Play stays without server versions; "Download" opens `/download/…`; locked
    entry when the admin turned it off; running download progress + pause + cancel label; series large ("Season 1 ·
    0/3 · 2/3 downloaded", card marks done/active, chip row) and phone (row action, hero action, season button →
    `/download/tmdb-tv-7-s01`).
  - `downloads-screen.test.tsx` (12): rail entry + badge "1" (a11y "1 download running"), summary, library sections,
    storage; pause all, delete watched after confirm; play from the list (no `releaseId`); permission note; empty;
    no rail entry/unsupported screen without the engine; Settings section (Wi-Fi, 3 at once, delete watched, delete
    all with confirm, open Downloads, absent without downloads); phone Library tab (switch, persisted, `?kind=`),
    large shell keeps Movies/Series.
  - `navigation/native-tabs-shell.test.tsx` (+2): German phone bar Bibliothek/Downloads, Filme/Serien gone, hidden
    `(series)` trigger, Downloads badge "3"; no engine → hidden `(downloads)`.
  - `navigation/app-tabs.test.tsx` (+3): phone `/series` → `/movies?kind=series`; large shell and Apple TV keep it.
  - `screens/offline/__tests__/offline-shell-downloads-settings.test.tsx` (1): offline shell shows the section (no
    "Open Downloads"), Wi-Fi only switches.
- Web: nothing of this renders there by design (no downloads on web; the web shells filter Downloads, the phone
  Library tab is native-only); covered by the jest shell tests, no web screenshots.

## Requests to DL-C1

- ~~`npm run typecheck` fails on `local-mode.test.ts:87`~~ — fixed in c78103e1 (merged).
- (FYI, no change needed) the read hooks throw without `DownloadsProvider`; DL-C2 reads through
  `useOptionalDownloadsContext()` for everything that renders in existing screens.

## Follow-ups

- **Phase B** (after the go): merge fb/downloads + fb/dl-core, then one device at a time — Android phone emulator,
  Android TV emulator, iPhone simulator, iPad simulator against Dev World 39300 (Metro 8083): every sheet flow incl.
  not fitting (small-storage AVD or filled storage), season pack + rest similar on the Dev World series fixtures (RAR
  pack), TV D-pad (initial focus, Back steps, focus return), Library tab + deep links, rail entry + badge, detail
  defaults; screenshots to `docs/client/screenshots/DL-C2/<device>-<flow>.png`.
- Watch on devices: Android Material bottom bar with 6 visible tabs (hidden triggers are filtered before the native
  view, as for today's 6), iOS formSheet footer position at the 0.6 detent, Android TV panel list height (`room`).
- The in-player version panel does not mark the downloaded version (the player's local mode hides version chips).
