# DL-C2 — client UI (offline downloads)

Status: done — phase A (UI, nav, detail, settings, tests), fix round 1 (DL-C-verify1) and phase B (Android phone,
Android TV, iPhone, iPad against Dev World 39305, 43 screenshots) complete; 8 device bugs fixed. Open: the follow-ups at
the end (iPhone "Mehr" tab, iOS sheet footer not pinned, two failure paths only covered by jest).

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
  list; on iOS the confirm button ends the scroll list and the sheet opens at full height, see phase B). Back steps back
  inside the flow (`pick` step → main) before the route closes; focus returns to the opener.
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
- **Shared title group unchanged** `(home,search,movies,series,mylist)`: a first version added `downloads` to it so
  titles opened from the Downloads tab push inside that tab, but expo-router then resolved title links from Settings
  into the Downloads stack (phone and TV, phase B). Titles opened from Downloads now open in Home (1ba5e125).
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

## Fix round 1 (DL-C-verify1, Codex reviewer; report on fb/dl-verify-client 806adaf1)

Sheet repros (`sheet-adversarial.test.tsx`) promoted to `src/screens/downloads/__tests__/sheet-regressions.test.tsx`
(ordinary `it`), the `__verify__` copy deleted. Node 24.14 for every run.

Commits: 53cb8734 (sheet/library/detail fixes), d7a5f4ab (title-link group order, C1-26), ac6a73a8 (tests). Result under
Node 24.14 (C1-22): `npm run typecheck` 0, `npm run lint` 0, `npx jest` **255 suites / 2622 tests, all pass** (load
average 42 during the run). The earlier 64 failures of `screens.test.tsx` right after the DL-N merge were timeouts at load
average 57: the suite passes 103/103 with `--testTimeout=30000` and in the full run above.

| Finding | Fix | Test |
|---|---|---|
| C1-09 picked version loses fit | `chosenFits` from `space.verdict()` on every render and again on press; the picked card stays checked + blocked, footer reason "Die gewählte Version passt nicht mehr · fehlen X" | sheet-regressions "C1-09" |
| C1-10 failed items | season rows: failed = selectable `ready` row with "Zuvor fehlgeschlagen: <Grund>" + Ändern (b57051fe + this round); single sheet replaces a failed record (suggestion preselected); detail card + library rows honour `error.actions` (`otherVersion` → "Andere Version" opens the sheet, `retry` only when offered / no actions; no Pause on a failed row) via `failureActions()`; DL-C1's `DownloadsLibrary` got an additive `onOtherVersion` prop | sheet-regressions "C1-10", download-model "failureActions", detail-downloads "failure actions…", downloads-screen "failed downloads in the list" |
| C1-11 anchor | `defaultAnchor()` = first episode from the started one onwards (then wrap) not held whose best version fits; "Andere Folge wählen" → episode list (`AnchorEpisodeRow`, best version or "passt nicht") → version pick; no fitting episode → warning "Keine Folge passt" (no plan request) | sheet-regressions "C1-11" ×5, download-model "default anchor" |
| C1-16 pack vs retained subset | `packSelections()` = per pack the rows it would download now (minus held/deselected, exact own-file sizes else share); card verdict + default pack from it; pack line "Paket gesamt X · ausgewählt Y" | sheet-regressions "C1-16" ×3, download-model "judges every pack…" |
| C1-20 stream-only in pickers | `StreamOnlyLine` under the row and anchor version pickers (episode `streamOnlyCount`) | sheet-regressions "C1-20" |
| C1-25 nav/TV evidence | TV/Android panel inside `FocusLayer` (like `Sheet`); trap on all four sides (`download-sheet-trap`); Close takes preferred focus where it is the only control (permission off, nothing downloadable, season empty); row initial focus only on a control that exists (`rowFocusTarget`); first focusable row in "each"; TV focus returns to the Download button after the sheet (`useReturnTarget` + `tvFocus`); shared title group reordered `(home,search,movies,series,downloads,mylist)` — on the phone a title link from Settings landed in the Downloads stack (found on emulator-5560); `SegmentedControl` keeps only the mounted segment as focus destination (a stale node reached `findNodeHandle`) | sheet-regressions "C1-25" ×5, download-links (6: /series via AppTabs, /series/7 + nested season, Settings→title not in Downloads, native intent, TV focus return + control) |
| C1-06 UI | `file_missing` (actions retry+remove) shows reason, Retry, Delete; no "Heruntergeladen" chip; Play streams | detail-downloads "a missing local file" |
| C1-23 sheet | partial/non-contiguous packs ("Folgen 1, 3, 5 (3)"), mixed exact/share sizes, 24-episode season with edited plan (2 changed, 3 deselected) | download-model "season selection edge cases" ×6, sheet-regressions "names a non-contiguous pack" |
| C1-26 | `navigation/tabs.ts` doc condensed to one line; my other files had none (the remaining multi-line comments are DL-C1's or pre-existing) | — |
| cache warning | `useDownloadsBlocked` listens only to `updated` events of the `me` query (b57051fe) | detail tests: 0 "Cannot update a component" warnings |
| orchestrator | `waiting_*` with `retryAt` → "Warte auf den Server · nächster Versuch in 40 s" (ticks every second) on the detail card | detail-downloads "counts down to the next try" |

## Phase B — devices (2026-11-06/07)

Setup: own Dev World on 39305 (fixtures: Sherlock S2 direct + pack, Pioneer One S01 DEVPACK + RARPACK, Lighthouse Logs
S1 with 26 episodes, mislabeled Elephants Dream; viewer anna), own Metro 8083, every app opened with the explicit
dev-client URL (`…expo-development-client/?url=…8083`, never the launcher list), `adb -s <serial> reverse` for 8083 +
39305. The simulators got `Streamarr.app` from the `dl-native-b1b3a8f4` build; no native rebuild. At most 3 own devices
booted. Merged fb/downloads (a38c1ffe, DL-N) and fb/dl-core (merge 2b314591) before the devices, again at the end (fb/dl-core
0f8f1829 → b69905af, fb/downloads 9df771f1 → 2c585159, one JOURNAL.md conflict: both lines kept).

The iPhone was attached once to DL-C1's Metro 8082 through the launcher list; reconnected with the explicit URL and
checked (debugger project root `dl-ui`, tabs "Bibliothek"/"Downloads"); no screenshot predates the reconnect.

### Evidence per device

| Device | Flows verified | Result |
|---|---|---|
| Android phone `emulator-5560` (Streamarr_Phone_DL2: API 34 google_apis arm64, Pixel 7, 6 GB data) | Library tab Filme/Serien switch; episode sheet (de + en); movie sheet; season pack, Pioneer One RAR pack with a retained subset ("Paket gesamt · ausgewählt"); rest similar, change a row, deselect; selbst wählen; 26-episode season (each + similar); "doesn't fit" with the natural 4.5 GB free (pack 14.8 GB, 18 GB, 7 GB selections blocked with the missing amount, deselect enables); start → confirmation → Downloads; Downloads empty/queue/running/series/library, badge; movie progress, pause/resume (pending state), speed; permission off (admin PATCH `allowDownloads=false`: locked entries, sheet explains, restored after); Settings → Downloads; version picker "Auf diesem Gerät"; title link from Settings | pass after fixes 3bbe0036, 382d7083, dfa5ad6a, 01233fa9, 1ba5e125 |
| Android TV `emulator-5556` (Streamarr_GoogleTV_1080p) | D-pad: rail → detail Download button → panel (initial focus on the recommended card, trap on all sides, footer reachable, Back steps back then closes, focus returns to the opener, also for a non-default episode); season pack, rest similar rows, change, deselect, start; Downloads rail entry + badge; Settings → Downloads; detail "Heruntergeladen" chip + "Spielt von diesem Gerät", season "2/3 geladen", episode marks; running card with pause reachable by D-pad | pass after 1ba5e125, 44755fcc |
| iPhone 17 sim "DL-C2 iPhone" (iOS 26.5, B070AD6C) | formSheet episode sheet, season pack, rest similar, start, Downloads tab badge | pass after 0705d9a0; tab bar shows "Mehr" (follow-up) |
| iPad Pro 11" M5 sim "DL-C2 iPad" (iOS 26.5, C7253140) | rail with Downloads + badge; formSheet episode sheet portrait + landscape; season pack landscape/portrait; start 3 episodes; detail progress card; Downloads screen; delete one download with confirmation (3 → 2, badge follows) | pass after 1605bd44, 44755fcc; confirm button needs a scroll in long sheets (follow-up) |

Not on a device (covered by jest only): the mislabeled-release prepare failure → "Andere Version" (sheet-regressions
"C1-10", detail-downloads "failure actions"; on device it needs a profile whose player cannot take the release), the
`waiting_server` countdown (the armed 503 fault was never hit before the transfers finished; detail-downloads "counts
down to the next try"), "Gesehene löschen" and "Alle löschen" (downloads-screen tests). Dev World faults cleared
(`DELETE /devworld/faults`), anna's `allowDownloads` restored.

### Bugs found on devices

| Commit | Device | Bug → fix |
|---|---|---|
| 3bbe0036 | Android phone | the bottom sheet's list did not shrink, the confirm button was off screen → the list gets what header + footer leave |
| 382d7083 | Android phone | flex does not pass through the focus guide and SlideInDown kept the first frame: footer still below the screen → measured header/footer heights + FadeIn; German segment labels truncated → `adjustsFontSizeToFit` with smaller padding |
| dfa5ad6a | Android phone | slow transfers read "0 MB/s" → KB/s below 1 MB/s; the bar announced "3 % gesehen" → download label; adapted to DL-C1's unknown space and age locks |
| 01233fa9 | Android phone | pause/resume takes the engine seconds, the button looked dead → pending state (disabled + busy until the promise settles) |
| d7a5f4ab, 1ba5e125 | Android phone, TV | a title link from Settings opened in the Downloads stack (expo-router picks shared groups alphabetically after the previous segments) → Downloads left the shared title group |
| 0705d9a0 | iPhone | formSheet showed only the confirm button (a root view with a flexible scroll view collapses in the native sheet) → the scroll view is the sheet's root, the button ends the list |
| 1605bd44 | iPad | the sheet opened at the 60 % detent with the confirm button below the fold → the download route opens at its last detent |
| 44755fcc | iPad, TV | the stage's running-download card showed only icons (flex: 1 text in a wrapping card) → the text column shrinks from its content with a minimum width |

A TV stage that jumped back to episode 1 under the panel turned out to be the Fast Refresh remount of my `_layout.tsx`
edit (a transient `ReferenceError` between two edits); after a clean reload the stage keeps the previewed episode.

Merge fallout: after fb/downloads 9df771f1 the documented-codes drift test (`api/__tests__/errors.test.ts`) failed on
DL-S's new `412 precondition_failed` (offline file `If-Match` without the current ETag) → registered as a T8 content
error with de/en text (5c3938e9); its title had to differ from `download_source_changed`'s and the generated
`docs/client/player/hint-catalogue.md` gained row F114 (f60af7c1). DL-C1 may want its own wording in `downloads.error`
if the engine surfaces it.

DL-S fix round 1 (revocable file links, already merged with fb/downloads) checked against the UI afterwards:
- A download parked until the next sign-in (`waiting_server` + `signed_out`/`download_revoked`) now reads "Nach erneuter
  Anmeldung geht es weiter" / "Continues after you sign in again" on the detail card and in the list (no countdown, no
  warning line, no retry); `waitsForSignIn` sits next to `lockOf` in `@/downloads/library` (3e114590).
- `403 downloads_not_allowed` / `age_restricted` on a running download: DL-C1's manager fails it with
  `actions: ['remove']`, so the detail card and the list show the reason and only cancel/delete (tests added, held already).
- Download button locked with an explanation while `allowDownloads` is off: built in phase A, seen on the phone.

Download notification link (DL-N adds Pause/Cancel and a tap target): `streamarr://downloads` resolves through
`+native-intent` unchanged to `/downloads` → phone Downloads tab, Android TV Downloads rail entry selected, on a cold
start and from another tab (`download-links.test.tsx`); unreachable server → offline shell with the downloads
(`offline-downloads-link.test.tsx`, own file: the offline shell allows one render per file). No code change was
needed. On a device only once DL-N's new dev client ships: a dev client started from a link opens its launcher, not the
bundle, so a cold start cannot be checked with the current one.

Plan language and held-back downloads (orchestrator decision after DL-S fix rounds 1b/2; merged fb/dl-core 9a1366c8…
e9565e8c → b5d2589a, fb/downloads 7691c9df → 7bbb91a9; Dev World 39305 restarted from the round-2 snapshot
20261106T233658Z, kept data; `devworld.sh start` cannot `nohup` here, so the snapshot dll ran directly as DL.md says):
- Rest-similar rows carry the plan's `language_differs`: "Andere Sprache: Deutsch" / "Different language: German"
  ("Sprache nicht angegeben" for an untagged choice) in the warning tone and the row's accessibility label; a version
  the viewer picks drops it (48af7d4c). Dev World has no season that triggers it (every Sherlock episode has a German
  and an untagged version, Pioneer One and The Lighthouse Logs one language each) → jest only. Live plan check: an
  untagged S02E01 anchor now gets `same_release` (untagged) for `audioLanguages` `de` and `en` alike; the earlier finding
  is fixed.
- A download refused with `downloads_not_allowed` / `age_restricted` (failed, only Remove) reads as on hold, not broken:
  "Angehalten", its progress kept, reason "Downloads sind für dein Profil gerade deaktiviert – geht automatisch weiter,
  wenn sie wieder erlaubt sind" / "Für dein Profil gesperrt (Altersfreigabe)" on the detail card and in the Downloads
  list; the entry button and the episode mark show the lock (e2e96294, `blockedBy` next to `lockOf`). Android TV,
  Sherlock S2E2 throttled to 20 KB/s, anna's `permissions.allowDownloads` off: list and detail card switched within
  seconds, focus moved to Delete (`tv-downloads-on-hold-de`, `tv-detail-on-hold-de`). Turned back on, the download did
  **not** continue within 60 s: the merged core has no auto-resume yet (DL-C1's announced change); the copy assumes it.

DL-C1 fix round 1 API, merged again (fb/dl-core 44d54c79 → 8b6295f3, fb/downloads fc88e901 → 6aa5c344; 87d38df7 and
cdd6a6b8 were already in). Conflicts: JOURNAL.md (both kept) and the hint catalogue — DL-C1 registered
`precondition_failed` too (88d59d4c), so the merge left two keys in each locale; DL-C1's wording (the engine restarts) is
kept, mine removed, catalogue regenerated (= fb/dl-core's):
- `SpaceVerdict.unknown`: cards read "Speicherplatz wird geprüft …" / "Checking free space…" (was "Freier Speicher noch
  unbekannt"); confirm stays disabled with the footer reason (20014530).
- `DownloadForWork.locked`: the entry's lock reads "Für dein Profil gesperrt" / "Locked for your profile"; the sheet of a
  locked finished download shows the lock and that the file stays until removed in Downloads, not the green "Schon auf
  diesem Gerät" (20014530). No local Play while locked (unchanged, tested).
- Per-record subscriptions (7dd63a9d): every list-wide progress notification (1/s while downloading) re-rendered the
  rail, the native tab shell, the series stage and every detail page. The hooks select primitives (badge count, season
  counts, a version of the local play target) and re-render only when those change; status card, episode mark and
  entry button follow their own record through `subscribeTo`; page-level callers that only need the file use the new
  `useLocalDownload`. Test: a progress tick re-renders none of badge/season/local/page, the live card at once.
- `error.actions` with `'remove'`, `file_missing` = retry + remove: already handled (failureActions, tested).
- Held-back records never offer retry or another version, also an older one without `error.actions` (908f7fec, found
  on the phone: Pioneer One S1F6 offered "Erneut versuchen"); the list uses a short reason ("Downloads gerade aus – geht
  von selbst weiter, sobald erlaubt") — the long one was cut at three lines in the phone's rows.

Devices after the merge (old dev client `dl-native-b1b3a8f4`; it now shows the "Neue App-Version … muss installiert
werden" banner since DL-N's native changes are merged):
- Android TV `emulator-5556`: Dev World stopped → offline shell in 24 s; Sherlock S2E1 played from the shell (local MKV,
  still playing at 0:27, no bounce back); Back → shell, focus on the play button; cold start while offline → shell,
  "Fortsetzen ab 0:33" from the local position; Dev World back → Home on its own in 19 s; detail S2E1 then shows the
  synced "Noch 1 Min.", "Heruntergeladen", "Spielt von diesem Gerät, ohne Server", season chip "2/3 geladen".
  Cancel: a throttled S1E1 download deleted from Downloads (4 → 3, badge gone), still gone after a force-stop + cold
  start. A warm `streamarr://downloads` opened Downloads with the rail entry selected (D-pad focus stayed on "Start").
  The held-back S2E2 did not resume after downloads were allowed again (no auto-resume in fb/dl-core 44d54c79).
- Android phone `emulator-5560`: offline shell in 35 s; S2E1 (local 720p MP4) played offline, still at 0:21 after 15 s,
  Back → shell; held-back rows show the short reason, only Delete.

Screenshot review (orchestrator) and the next merges (fb/dl-core e4bc6659 → c736ce50, fb/downloads b483b0b7 with DL-S
fix round 3 319cc2dc → c41c2141; one conflict in `DownloadsLibrary`: DL-C1's `isBlockedDownload` next to my row logic —
mine kept (offered actions, other version, sign-in waits), `blockedBy` now reads DL-C1's `BLOCKED_CODES`):
- VLC in the download sheet (97557e2a): version and pack cards no longer show the shared `vlc_fallback` reason ("Der
  eingebaute Player kann diese Version nicht abspielen"), which read like an error on a version that downloads and
  plays fine; a VLC version without another note reads "Spielt auf diesem Gerät mit VLC" / "Plays on this device with
  VLC" next to its VLC chip. The streaming version sheet keeps the shared string. Re-taken: `tv-episode-panel-de`
  (Sherlock S1E1: VLC BluRay + Direct WEB-DL), `ipad-season-pack-landscape-de`, `iphone-episode-sheet-de`.
- iPhone tab bar shot: the Home screen carries the dev client's required-update banner (no close button), so the tab
  bar is shown on the Library tab instead (`iphone-library-tabbar-de` replaces `iphone-home-tabbar-de`).
- DL-C1's auto-resume is in: on the TV the held-back Sherlock S2E2 finished by itself after downloads were allowed again
  (season chip "3/3 geladen").

Phone screenshot review (orchestrator, queued before the VLC one; Android phone, Dev World 39305 from snapshot
20261107T001952Z):
- VLC wording: done in 97557e2a ("Spielt auf diesem Gerät mit VLC"; the native-player reason is not shown in the sheet).
- A selection that doesn't fit (15193f32): the pre-selected pack (Sherlock S2, 476 MB short) and a C1-09 pick that lost
  its fit stayed checked with the accent check mark at reduced opacity, which read as ready. Still the selection
  (`aria-checked`, blocked), but with a red alert mark instead; confirm stays disabled with "Folgen abwählen oder
  Speicher freigeben" (`phone-season-pack-too-big-de`, re-taken).
- Rest similar after DL-S 1b: every row is "Gleiches Release" from an untagged anchor (Sherlock S1, nothing on the
  device; S2's E1/E2 are already on this phone) — `phone-season-similar-de`, `phone-season-similar-edited-de` (F3
  deselected → fits) and `phone-season-similar-en` re-taken.
- Failed row on a device: a 410 fault on Sherlock S1E1's file → "Fehlgeschlagen · 0 MB von 4 MB", reason "Die Quelle
  dieser Version ist weg…", "Andere Version" + delete (`phone-downloads-failed-de`, `-en`). "Andere Version" opens the
  sheet with the failed version marked "Zuvor fehlgeschlagen". Its banner read "…Wähle eine andere Version zum
  Herunterladen. Wähle eine andere Version – oder dieselbe, um es erneut zu versuchen." — fixed (b4d49fc5): the retry
  hint follows only where a retry is offered (`phone-other-version-sheet-de`).
- The phone came back "Zu deiner Sicherheit abgemeldet — Diese Anmeldung wurde anderswo verwendet" after the emulator
  had been killed and the new snapshot started (refresh token reuse); signed in again. Not downloads code; noted for
  the accounts owner.

DL-S fix round 1b (queued note; long merged): live check on Dev World 39305 (snapshot 20261107T005229Z, kept data) —
the untagged Sherlock S02E01 anchor gets `same_release` for `audioLanguages` `de` and `en`. An untagged
`language_differs` choice now reads "Andere Sprache: ohne Angabe" / "Different language: unspecified" (35e5399f,
was "Sprache nicht angegeben"). `tv-season-similar-rows-de` re-taken (it predated fix round 1): Sherlock S1 on the TV,
all three rows "Gleiches Release", 24 GB against 15.5 GB free blocks confirm with the reason. Phone DE/EN were
re-taken on this snapshot before (585d7044, 72b7c8e0). Merged fb/dl-core 730c68ed → a19ad4ee (conflict: DL-C1's
"no Pause on failed rows" 09022098 = my condition, kept mine) and fb/downloads 89df7554 → 837c93a1. DL-C1's new
`offline-shell-blocked.test.tsx` looked for their error message in the list row, which shows the short on-hold
reason since 908f7fec; the assertion follows the row now (bb1f3c0a, same meaning).

DL-N fix round 1 dev clients (`dl-native-a36493d1`, orchestrator 2026-11-07): `fb/downloads` had nothing new
(97d36070 already merged); fb/dl-core d441cacc → 70c55215 (JOURNAL.md conflict; the duplicated DL-C1 line removed in
b13c092a). `emulator-5560` now runs DL-N's `Streamarr_Phone_DLN` — not touched (orchestrator told); my
`Streamarr_Phone_DL2` came up on `emulator-5562`. APK installed (`-r -g`) on 5556 (TV) and 5562; `Streamarr.app`
reinstalled on the DL-C2 iPhone and iPad (data reset → server + sign-in again). Metro 8083 by explicit URL only; on
iOS each link open queues a bundle load, and keys typed while no field has focus reach the dev runtime ("r" = reload),
so one link and a fresh tree before every tap.
- Missing storage volume (7dc0b0d8): the core keeps a transfer in `waiting_volume` and marks a finished file
  `volume_unavailable`. The entry said "Heruntergeladen" with a green check for such a file, the card of a waiting
  transfer showed its state twice and no reason, the list offered Play on the file. Now entry, card, sheet and list say
  "Speicher nicht verfügbar" with why and that it continues / comes back by itself; no retry, no Play on the file
  (`volumeMissing` next to `blockedBy`). Jest only: no removable volume on the emulators.
- Android notification (phone, Sherlock S1E2 throttled to 20 KB/s): "Sherlock · S1, F2 — 181 kB of 3.8 MB · 20 kB/s"
  with Pause / Cancel (`phone-notification-running-de`; its text is English on a German device → DL-N). Pause → the row
  reads "Pausiert · 1 MB von 4 MB" with Resume and stays paused (`phone-notification-paused-de`); tapping the
  notification opened the Downloads tab (warm). Resumed, then `am stop-app` (the Task Manager's stop) and a cold start:
  still "Pausiert". A cold start straight through `streamarr://downloads` lands on the dev client's launcher (dev-client
  limitation; the release path through `+native-intent` is pinned by jest). Android TV, iPhone and iPad: a warm
  `streamarr://downloads` opens Downloads (rail entry / tab selected). iPhone: a download finished on the new engine.
- The phone AVD cold-booted from an older snapshot: its stored refresh token had been used since, so the app came back
  "Zu deiner Sicherheit abgemeldet" (the earlier sign-out on this AVD is the same; not an accounts bug), and the Pioneer
  One records restored from that state failed with `download_not_ready` + Retry (correct). The emulator's virtual Wi-Fi
  did not connect, so "Nur über WLAN laden" is off on this AVD.
- Dev-only LogBox "Can't perform a React state update on a component that hasn't mounted yet" at the TV's cold start:
  expo-router's `useLinking` initial URL (known, F8 journal), once per start.

Last merges before close: fb/dl-core e0555637 → 4e734475 (DL-C1 80a2adc6 adds a sign-in-screen hint "2 downloads
continue after you sign in again" — complements DL-C2's row/card copy, no overlap) and fb/downloads 43084012 → b25f4f90
(DL-S fix rounds 3 and 4; 319cc2dc was already in since c41c2141). No conflicts, no duplicate locale keys. Dev World
39305 started from snapshot 20261107T010707Z (3752e5ad, kept data): Sherlock S2 still lists 2 packs / 3 episodes and
the untagged anchor plans `same_release` for `de` and `en`; stopped again by PID.

Removing state (DL-N fix round 2: cancel/remove wait until the transfer has ended, up to ~30 s; orchestrator's spec,
DL-C1 a519c97b merged → 2e36c1f5): UI in 8c37f4e4, all through `isRemovingDownload` and DL-C1's label
`downloads.state.removing` ("Wird entfernt…" / "Removing…"; no own key). Built first against a local, uncommitted
stand-in of the type, swapped for DL-C1's commit before committing.
- List: the row keeps its place — `completedAt` tells a removed file (season/movie block) from a cancelled transfer
  (in-progress section, creation order); greyed at once, no actions, not focusable; the label only after 600 ms
  (`useDelayedFlag`, `REMOVING_LABEL_DELAY_MS`) so removing a whole season does not flicker. A series whose episodes are
  all removing greys its header.
- Detail: a cancelled transfer's card greyed without controls; Download button disabled (label after the delay);
  episode mark hidden. A removed finished file shows no card (the button says it).
- Sheet: a new download of that work is refused ("Sobald er entfernt ist, kannst du diesen Titel hier wieder
  herunterladen."), the versions return when the record is gone; in a season sheet the episode is a greyed `removing`
  row that cannot be selected. Badge and season counts skip it.
- `retryAt`: the countdown only re-renders a clock (`useNow`), never schedules work.
- Tests: list (in place, no actions, label after the delay, gone after delete), detail card + disabled entry, sheet
  blocked then unblocked, model row status, badge/season counts; all 5 fail without the change. Not yet: the
  end-to-end test with DL-N's fake `stallDrain` / `releaseDrain`, and a device check — both wait for DL-C1's removal
  order (`work_removing`, pending retries), which actually puts records into this state.

DL-S fix round 4 (b5dab8df) and its snapshot (3752e5ad) were already in (b25f4f90). Merged since: fb/dl-core
b4a5e203 (DL-N fix round 2: pending cancel/remove, fake `stallDrain`/`releaseDrain`) → bc4200d3, fb/downloads cbf7deb4
→ b533a33c; no conflicts. The manager does not set `removing` yet, so the end-to-end removing test still waits for
DL-C1's removal order. Dev World 39305 gets the newest snapshot (now 20261107T013453Z, DL-S round 5) before the next
screenshots.

Removal pipeline (DL-C1 cbd37532, then fa42dacb with backed-off pending retries; merges e9387e28, 65d79fc6):
DL-C1 also built the removing row in `DownloadsLibrary` (same behaviour as DL-C2's 8c37f4e4), so the merge keeps one
implementation — DL-C1's row/`isFinishedRow`/`groupLibrary.active` and `REMOVING_LABEL_MS`; DL-C2's duplicate
`RemovingRow` and local active list are gone, DL-C2's held-back / sign-in / missing-storage additions stay. The sheet's
removing message and a start that races a removal now use the core's `work_removing` text (`downloadErrorText`).
End-to-end tests (e4297281) start real downloads through the core (`startThroughCore`): stalled drain → greyed in
place, label after the delay, gone after `releaseDrain`; re-download blocked on detail + sheet and unblocked by itself;
a ~200 ms season removal never shows the label. Trap worth knowing: expo-router's `renderRouter` calls
`jest.useFakeTimers()` and installs a new clock each time, so timers the core scheduled before `open()` never fire —
open the screen first, wait with `waitFor`, step the clock with `jest.advanceTimersByTime`.

### Final checks (fb/dl-ui e4297281, Node 24.14, load average 15–24)

- `npm run typecheck` → **0 errors**; `npm run lint` → **clean**.
- `npx jest --testTimeout=30000` → **278 suites / 2880 tests, all pass** (after fix round 1: 255 / 2622; the rest are
  DL-C1's and DL-S's merged suites plus the phase B fixes' coverage). The 30 s timeout is for the load of the shared
  machine (see fix round 1); no test needed it alone.

### Screenshot index (`docs/client/screenshots/DL-C2/`)

- Android phone: `phone-library-movies-de`, `phone-episode-sheet-de`, `phone-episode-sheet-en`, `phone-movie-sheet-de`,
  `phone-season-pack-too-big-de`, `phone-season-rarpack-subset-de`, `phone-season-similar-de`,
  `phone-season-similar-edited-de`, `phone-season-26-each-de`, `phone-season-26-similar-de`, `phone-season-started-de`,
  `phone-downloads-empty-de`, `phone-downloads-queue-de`, `phone-downloads-running-de`, `phone-downloads-series-de`,
  `phone-downloads-library-de`, `phone-movie-progress-de`, `phone-movie-paused-de`, `phone-permission-off-detail-de`,
  `phone-permission-off-sheet-de`, `phone-settings-downloads-de`, `phone-version-picker-on-device-de`,
  `phone-offline-play-local-de`, `phone-offline-on-hold-de`, `phone-downloads-failed-de`, `phone-downloads-failed-en`,
  `phone-other-version-sheet-de`, `phone-season-similar-en`, `phone-notification-running-de`,
  `phone-notification-paused-de`.
- Android TV: `tv-detail-download-focus-de`, `tv-episode-panel-de`, `tv-back-focus-returned-de`, `tv-season-pack-de`,
  `tv-season-similar-rows-de`, `tv-season-similar-changed-de`, `tv-season-similar-deselected-de`,
  `tv-downloads-rail-badge-de`, `tv-settings-downloads-de`, `tv-detail-downloaded-de`, `tv-detail-progress-de`,
  `tv-downloads-on-hold-de`, `tv-detail-on-hold-de`, `tv-offline-shell-de`, `tv-offline-play-local-de`,
  `tv-detail-after-offline-sync-de`.
- Android phone after the DL-C1 merge: `phone-offline-play-local-de`, `phone-offline-on-hold-de`.
- iPhone: `iphone-library-tabbar-de`, `iphone-episode-sheet-de`, `iphone-season-pack-de`, `iphone-season-similar-de`,
  `iphone-downloads-badge-de`.
- iPad: `ipad-episode-sheet-portrait-de`, `ipad-episode-sheet-landscape-de`, `ipad-season-pack-landscape-de`,
  `ipad-detail-progress-de`, `ipad-downloads-rail-de`.

## Requests to DL-C1

- ~~`npm run typecheck` fails on `local-mode.test.ts:87`~~ — fixed in c78103e1 (merged).
- (FYI, no change needed) the read hooks throw without `DownloadsProvider`; DL-C2 reads through
  `useOptionalDownloadsContext()` for everything that renders in existing screens.
- Additive in your files: `blockedBy` (next to `lockOf`, `@/downloads/library`) and its use in `DownloadsLibrary`
  (on-hold label, reason, progress kept). Once auto-resume lands, the copy "geht automatisch weiter" holds.
- Additive in `DownloadsLibrary` (908f7fec): held-back rows (`blockedBy`) never offer retry or another version, and use
  the short reason `downloads.detail.blockedShort.*`.
- Player, offline local start on the phone: for 1–2 s it shows the streaming start card ("Version prüfen – Es wird
  geprüft, ob alle Teile dieser Version verfügbar sind") and "Die Wiedergabe ist stehen geblieben. Es geht weiter bei
  0:00 …" before the file plays.
- Library wording for an age lock is "Für dieses Profil nicht freigegeben"; detail and sheet now say "Für dein Profil
  gesperrt" (orchestrator's copy) — worth aligning `downloads.library.locked`.
- `DownloadsLibrary` rows show "0,0 MB/s" below 50 KB/s (`transferLine` rounds MB/s to one decimal); the detail line
  switches to KB/s below 1 MB/s (iPad, Dev World throttle at ~37 KB/s).

## Follow-ups

- **iPhone tab bar "Mehr"**: six visible tabs; the bar shows Start, Bibliothek, Meine Liste, Downloads and "Mehr", which
  holds Einstellungen and the trailing search-role tab Suche (`iphone-library-tabbar-de`). Six tabs since My List (Filme +
  Serien); the Library tab took it to five, Downloads back to six. Needs a product decision (e.g. Settings into the
  profile menu).
- **iOS sheet footer**: the confirm button ends the formSheet's list instead of being pinned; long season lists (and the
  iPad in landscape) need a scroll to reach it. react-native-screens lays out iOS formSheet content absolutely without
  a bottom edge, so a flex footer collapses, and `unstable_sheetFooter` is Android-only.
- Device run still missing for the `waiting_server` countdown (jest only); "Andere Version" is covered on the phone.
- `language_differs` row note not seen on a device: no Dev World fixture lacks the anchor's language in an episode
  (jest covers the tagged and the untagged note).
- Android TV: a warm `streamarr://downloads` selects the Downloads rail entry but leaves D-pad focus where it was.
- DL-N: the download notification's text is English on a German device ("181 kB of 3.8 MB · 20 kB/s", Pause/Cancel).
- `volume_unavailable` / `waiting_volume` not seen on a device (no removable volume on the emulators); jest only.
- Removing state: device check with the final dev clients (the end-to-end tests are in, e4297281).
- The in-player version panel does not mark the downloaded version (the player's local mode hides version chips).
