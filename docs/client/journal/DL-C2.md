# DL-C2 — client UI (offline downloads)

Status: in-progress

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

## Log

- 2026-11-06: read PLAN §2–4 + DL, downloads-plan.html, DL-C1 journal (API freeze), schema download DTOs, core hooks
  and candidates. `npm install` in client/. Fast-forwarded to fb/dl-core 86eec76b (local playback in the player).
- Baseline on fb/dl-ui = fb/dl-core 86eec76b before any DL-C2 change: jest **237 suites / 2464 tests, all pass**;
  `npm run typecheck` **1 pre-existing error** in DL-C1's `src/player/__tests__/local-mode.test.ts:87` (mediaInfo
  fixture lacks `channels`) — not mine, left for DL-C1 (see Requests).
- Built: segmented control, flow model + candidate card + review row + flow + frames + route, nav (tabs, native tabs,
  rail, web filter, Library tab, redirects), Downloads screen (placeholder list until DL-C1's `DownloadsLibrary`),
  settings section, detail integration, i18n (`tabs.library|downloads`, `downloads.sheet|detail|screen|settings.*`).

## Evidence

## Requests to DL-C1

- `npm run typecheck` fails on `src/player/__tests__/local-mode.test.ts:87` (86eec76b): the mediaInfo fixture's audio
  tracks miss the required `channels`. Trivial, but it is your file.
- (FYI, no change needed) the read hooks throw without `DownloadsProvider`; DL-C2 reads through
  `useOptionalDownloadsContext()` for everything that renders in existing screens.

## Follow-ups
