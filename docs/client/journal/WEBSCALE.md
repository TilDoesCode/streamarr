# WEBSCALE — web viewer sizing and browser zoom

Status: done

User report (2026-10-24, translated): the web version shipped with the server was "way too zoomed in", looked weird and
did not react to browser zoom. Scope: the viewer app at `/watch` (Expo web export of `client/`), brief audit of the
admin SPA (`web/`). Branch `fix/web-scaling` (based on `feat/watchlist-diagnostics`, PR #48).

## Root cause (confirmed)

- `client/src/shell/shell-metrics.ts` `shellScale()` (base: line 69–72): desktop-web and tablet used
  `max(0.6, windowWidth / 1920)`, uncapped. Every large-shell size (`useShell().s()`, `font()`, and `ShellDesign`, which
  builds the TV design at `1920 × scale`) is the 10-foot TV mockup scaled to the window width.
  - Too big: 1920 rendered the full TV sizes (row title 32, card title 22, poster 208, detail title 56); 2560 → ×1.33,
    3440 → ×1.79 (row title 57.5, poster 372.5, detail title 100.5). Rows always fit exactly 7 posters at every width.
  - Zoom cancelled: Ctrl/Cmd + shrinks the CSS width, the scale shrinks by the same factor. Measured: row title 32
    physical px at 67 %, 100 % and 150 % zoom (48 CSS × 0.67, 32 × 1, 21.5 × 1.5); only the 0.6 floor (200 % on
    1920) let zoom through partially (38 phys).
- Viewport meta of the export is fine (`width=device-width, initial-scale=1, shrink-to-fit=no`; no maximum-scale /
  user-scalable): pinch zoom was never blocked; the app's own scaling cancelled it. No `+html.tsx`, `web.output: single`.

## Other problems found

1. **Web playback failed on the first play of every page load in the production export** (not a sizing issue, but it
   made the player overlay unreachable and is in the shipped build): hls.js is a split chunk; Metro's `asyncRequire`
   first requires the chunk synchronously and loads it only when that throws. In the export, `guardedLoadModule`
   reports that throw to `ErrorUtils.reportFatalError`; the playback crash guard (`src/player/crash-guard.ts`) swallowed
   it and handed it to the running playback → "Interner Fehler im Player / player_internal_error" and the chunk never
   loaded. Fix: the guard passes `Requiring unknown module …` to the previous handler (which throws, so the chunk loads).
   Before: every before/*-player.jpg shows the error card; after: video + overlay.
2. Home hero on wide windows: the artwork was a fixed `s(1500)` at the right edge; with fixed CSS px it would have left
   a gap on 2560/3440. Now the artwork width and hero height follow the window (below).
3. Admin SPA: dashboard "Service" card's version string (`v1.0.0+<sha>`) overflowed its card at 200 % zoom → wraps
   anywhere now. Otherwise the admin SPA is rem/Tailwind based, zooms natively at 100/150/200 %, no horizontal
   overflow (scrollWidth = innerWidth), `max-w-5xl` content cap on normal pages; tables use full width on 2560 (fine).
   Many `text-[9px]`/`[10px]` labels are tiny but zoom normally; not changed.
4. Observed, not changed: NetInfo on web probes `GET /` (401 in Dev World, admin SPA in prod); the controller only uses
   `isConnected`, so harmless. NativeWind is configured with `inlineRem: 16`, so Tailwind classes in the client are px
   too (zoom works, browser default font size does not apply to them).

## New sizing model

- TV: unchanged, `width / 1920` exactly (test pins 960 → 0.5, 1920 → 1, also when called with `web: true`).
- Native tablets (iPad/Android, not web): unchanged, `max(0.6, width / 1920)`.
- Phones: unchanged (compact layout, not the shell).
- Web (desktop-web and touch tablets in a browser): `WEB_SHELL_SCALE = 0.72`, independent of the window width, times
  the browser's default font size / 16 (clamped 0.75–2; `webTextScale()` in `use-shell.ts`) so the text-size
  preference applies. Resulting CSS px: hero title 52 (logo box 115), row title 23, card title 16, card subline 13,
  overview 17.5, meta 16, spec chips 11 (floor), buttons 46 tall / 16 text, poster 150 × 225, landscape 253.5 × 142.5,
  rail 75 wide, content left edge 121, page/detail title 40.5.
- Layout breakpoints instead of scaling: card counts follow the width (posters fully visible: 1280 → 7, 1920 → 10,
  2560 → 14, 3440 → 19); the existing width breakpoints keep working (web < 640 CSS px → phone layout, series/season
  two columns ≥ 1280, detail info column → button when narrow, search/library grids by width).
- Home hero on the web (`shellHeroFrame(…, web = true)`, `WEB_HERO`): artwork width = max(s(1500), 78 % of the window
  width); hero height = min(55 % of the window height, max(s(660), 0.36 × artwork width)); rows keep the mockup's
  overlap (rowsTop = hero − s(12)); the copy is anchored to the hero's bottom (`copyAnchor: 'bottom'`, hidden until
  measured so it does not jump). TV/native keep `copyAnchor: 'top'` and the mockup frame.
- Browser zoom: CSS sizes stay constant, so physical sizes grow with the zoom; at 200 % on 1920 (960 CSS) the shell
  still applies with fewer cards; below 640 CSS px (e.g. 200 % on a 1280 window) the phone layout takes over.
- Ultrawide/4K show more, not bigger: rows extend to the full width; detail copy, settings/connection pages keep their
  fixed column widths (left aligned like before).

## Measurements (Home, popular/trending poster row; CSS px, phys = × dpr)

| Size | Row title before → after | Card title | Poster width | Hero height | Posters fully visible | Detail title |
|---|---|---|---|---|---|---|
| 1280×800 | 21.5 → 23 | 15 → 16 | 138.5 → 150 | 440 → 440 | 7 → 7 | 37.5 → 40.5 |
| 1920×1080 | 32 → 23 | 22 → 16 | 208 → 150 | 660 → 540 | 7 → 10 | 56 → 40.5 |
| 2560×1440 | 42.5 → 23 | 29.5 → 16 | 277.5 → 150 | 880 → 720 | 7 → 14 | 74.5 → 40.5 |
| 3440×1440 | 57.5 → 23 | 39.5 → 16 | 372.5 → 150 | 880 → 792 | 7 → 19 | 100.5 → 40.5 |
| Retina 1440×900 @2x | 24 → 23 | 16.5 → 16 | 156 → 150 | 495 → 475 | 7 → 7 | 42 → 40.5 |
| Zoom 67 % (2866×1612, dpr .67) | 48 (32 phys) → 23 (15 phys) | 33 → 16 | 310.5 → 150 | 985 → 806 | 7 → 16 | 83.5 → 40.5 |
| Zoom 150 % (1280×720, dpr 1.5) | 21.5 (32 phys) → 23 (35 phys) | 15 → 16 | 138.5 (208 phys) → 150 (225 phys) | 440 → 396 | 7 → 7 | 37.5 → 40.5 |
| Zoom 200 % (960×540, dpr 2) | 19 (38 phys) → 23 (46 phys) | 15 → 16 | 125 → 150 (300 phys) | 330 → 297 | 6 → 5 | 33.5 → 40.5 |
| iPad 1180×820 touch | 19.5 → 23 | 15 → 16 | 128 → 150 | 406 → 451 | 7 → 6 | 34.5 → 40.5 |
| Phone 390×844 | 20 → 20 | 15 → 15 | 112 → 112 | 543 → 543 | 3 → 3 | 19 → 19 |

Hero logo box height: before 107/160/214/287 (1280/1920/2560/3440), after 115 everywhere. Hero text title (titles
without a logo): 72 × scale before (72 at 1920, 129 at 3440), 52 after.
Zoom check, physical row title on a 1920×1080 screen: before 32 / 32 / 32 / 38 at 67/100/150/200 % (cancelled);
after 15 / 23 / 35 / 46 (grows with the zoom like any website). Same for posters: before 208/208/208/250 phys,
after 101/150/225/300.

## Verification

- Client: `npx tsc --noEmit` clean; `npm run lint` clean; full jest **2204 passed / 2 failed / 2206** (195 suites;
  the 2 failures are the known tab-guard tests, also failing on origin/main). One earlier full run also had one
  `screens.test.tsx` timeout under load; that file passes alone (99/99) and in the final full run.
- New/changed tests: `shell-metrics.test.ts` (TV scale unchanged; native tablet unchanged; web scale constant for
  640…5120; zoom simulation 67/150/200 % keeps CSS values and grows physical ones; desktop values 52/23/16/150; text
  scale clamp; hero frame TV/native/web), `shell-hero-layout.test.ts` (bottom-anchored copy), `crash-guard.test.ts`
  (chunk probe goes to the app handler). Without the source changes: 10 shell tests and the crash-guard test fail.
- Admin SPA: `npm run typecheck` clean, vitest 268/268, `tsc -b && vite build` (to /tmp) ok.
- Production export exactly like the Dockerfile (`EXPO_BASE_URL=/watch npx expo export --platform web`) before (base
  48eca57) and after, served by the Dev World server under `/watch` via `Streamarr__ViewerWebPath` (Dev World
  `start 39350 --tree`, fresh data + the same My List seed for both runs). Playwright (Chrome for Testing, muted),
  zoom emulated as CSS viewport = 1920 / zoom with deviceScaleFactor = zoom. Screens: home, series, versions sheet,
  My List, Settings → Verbindung & Diagnose, player overlay.
- Screenshots: `docs/client/screenshots/WEBSCALE/{before,after}/<size>-<screen>.jpg` (+ `metrics.json`),
  `admin/admin-<size>-<page>.jpg`, contact sheet `docs/client/screenshots/WEBSCALE/compare.html` (self-contained
  thumbnails, links to the full files, light + dark).
- Servers stopped (Dev World 39350, Vite 39352).

## Not verified / follow-ups

- Real Safari/iPad (pinch zoom, `pointer: coarse`), real Android TV/Apple TV (unchanged code paths, unit-pinned only),
  native tablets (unchanged code path).
- Browser default font size: implemented via the root font size; only unit-tested, not exercised in a browser.
- Changing the browser font size or zoom without a resize event is picked up on the next resize/re-render only
  (zoom always fires resize).
