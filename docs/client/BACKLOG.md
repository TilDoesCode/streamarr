# Streamarr Client — backlog after the core loop (M0–M4.2)

Consolidated from the open-issue sections of `journal/M1.5`, `M2.3`, `M2.4`, `M3.1`, `M4.1` and `M4.2` (state 2026-09-30).
The journals hold the evidence and reproduction details for each item.

## Decisions for the user

- **"Recommended" version:** the server ranks by quality only, so web recommends a 4K HDR10 transcode over a 1080p
  direct stream. Proposal: rank the best version that plays without transcoding first on each device, and fall back to
  transcoding only when none exists (also decides what a plain "Play" starts).
- **Web client hosting:** served by the server (same origin) or from another origin (needs a CORS setting for viewer
  endpoints; Dev World allows `*`).

## Needs Xcode (pending-ios)

- iPhone/iPad: NativeTabs with Liquid Glass (iOS 26+), iPad sidebar, large titles and transparent detail headers,
  version side panel on iPad, Keychain vault, phone forms and keyboard insets.
- Apple TV: native top tab bar, focus restore (`ScreenFocusScope`), Menu-key Back chain, tvOS keyboard, remote via
  `useTVEventHandler`.
- Playback: expo-video on AVPlayer, VLCKit fallback, Swift media-caps (VideoToolbox, HDR/DV, audio route), Safari
  native HLS/HEVC/HDR, AirPlay and picture-in-picture.

## Needs real hardware (Android TV, ideally a 2 GB device)

- HEVC Main10 / HDR10 / Dolby Vision decode and HDR display modes; AC-3 / E-AC-3 / DTS / TrueHD passthrough; 4K on a TV SoC.
- VLC: direct rendering (zero copy, black on emulators), first-seek latency in MKV (2.7–7.3 s on emulators), HDR output
  (the TextureView cannot carry HDR), stall watchdog on a real stall.
- Hold-scrub tiers 30/60/120 s on a real remote (emulator sends one repeat; unit-tested).
- Memory: home screen uses ~520 MB native in the dev build; measure a release build.

## Player polish

- Paused step-down to VLC shows frame 0 for ~13 s after resuming (clock and saved position are correct; the watchdog
  only runs while playing).
- Frozen end frame without controls after a cancelled up-next.
- Continue watching for a played item starts at 0 (the server returns no resume position for played items).
- ▶ pressed in the same frame as ▲ from the seek bar may be ignored (never seeks).
- Picture-in-picture on Android (expo-video `supportsPictureInPicture` + native rebuild).
- Decoder and dropped-frame figures are "—" for expo-video on Android; VLC decoder labels are best effort.
- expo-libvlc-player logs `VLCObject (Media) finalized but not natively released` (small native leak per playback).

## Browse and UX polish

- Series "mark watched" toast names the next episode instead of the series.
- A hanging server shows the skeleton ~110 s before the timeout error (20 s timeout × retries).
- "Play" is offered for titles without versions (e.g. Agent 327) and ends in `no_versions`.
- A fully watched series offers no "watch again from the start".
- Watch state changed on another device appears only after the 1-minute stale time.
- TV hero eyebrow can keep "Continue watching" while focus is on the same title in another row; it can miss the
  episode title if focused before its season loaded.
- German UI shows server season names ("Season 1").
- Search type filter persists across a profile switch.
- Opaque header band above the hero on web and Android detail screens.
- Back from the player focuses Play/Resume, not the version card that started playback.
- Version cards show both "container assumed (mkv)" and "mkv not supported"; simplify the wording for viewers.
- TV: D-pad presses in the first 1–2 s after Home renders can land in the content; the rail reopens on the last focused
  item, not the active tab.
- Web: one page title for every route; a duplicate history entry after popping the active tab; Back after sign-in
  returns to `/server` or `/sign-in`.

## Accounts

- Every re-sign-in after a server reset adds another profile tile for the same user (dedupe by server + user).
- Settings UI for sessions/devices, email change, two-factor setup and profile editing.
- TLS failure message not exercised against a real self-signed server; only Gboard tested as TV keyboard.

## Tests and tooling

- Screen-level tests for home, search, detail and the version picker (current tests are logic-level).
- Dev only: after a JS reload the `player-keys` native listener is dead until a cold start (native fix in the M4.2 journal);
  nothing is focused on TV after a JS reload until the first D-pad press; the dev client can start with a cached bundle.
- Dev World restart wipes its database (sessions end, profiles duplicate).

## Server (deferred in the M1.5 triage)

- Multi-rendition audio in HLS (#4), double probe on start (#27); see the triage table in `journal/M1.5.md`.

## Next update (out of scope for the core loop)

- Offline downloads of series and movies on phones and tablets.

## Found during the polish round (2026-09-30)

- **Server: VLC limits on the versions endpoint.** `vlcAvailable=true` makes the server assume VLC plays every file,
  so on Google TV it recommended a 4K HEVC file "with VLC" while the device's VLC only decodes HEVC up to 1080p and
  plain Play (full device profile) chose the 1080p WEB-DL. The client stopped sending `vlcAvailable` (P2). Fix: let the
  versions request carry the VLC engine caps (or the full device profile), then send it again from Android.
- **Server: orphaned capability-probe ffmpeg.** A hardware capability probe (`FfmpegCapabilityProbe`, VideoToolbox)
  outlived a killed Dev World and hung for ~13 h at 0 % CPU (needed SIGKILL). Kill the probe's process tree when the
  host stops, and make sure step timeouts use SIGKILL.
- **Player: black frame on a remux resume** seen once on the Google TV emulator at 0:34 while reporting "playing"
  (being checked in the P2 verification).
- **Server: palette queue silently drops work.** `ArtworkPaletteService` uses a bounded channel (2048) with
  `DropWrite`; `TryWrite` still returns true, so URLs beyond the limit stay marked as queued and never get a tint until
  a restart (and `WhenIdleAsync` never returns). Matters on the first load of a large library. Fix: wait or re-queue
  instead of dropping, and clear the queued marker on drop.
- **Server: palette/spec failures log only at Debug.** A broken image host or a missing native Skia library goes
  unnoticed in production; log the first failure per cause at Warning.
- **Server: series spec lookup scans all stored summaries per list item** (`CatalogSpecStore.Get`); index by series.

## From R1 verify (2026-09-30)
- Brand PNGs are large (icon 554 KB, top shelf 2.2-2.6 MB) because Chrome dithers the gradients; pngquant 80-95 cuts them 5x but bands the dark gradients visibly. Revisit with a render that avoids dithering (e.g. noise-free SVG export) if bundle size matters.
- Web font gate waits up to ~12 s (expo-font timeout) when font requests hang; a shorter timeout with system-font fallback would avoid the blank page.
- Phone blur cost: software-GL AVD shows RenderThread ~84 % with the blurred ambient backdrop; re-measure on a real phone before shipping the phone ambient.
- Backend: TMDB metadata uses one server-wide language (TmdbClient `options.Language`), so a German viewer UI shows English overviews. Consider a per-request language on the viewer catalog/detail endpoints (from the client's i18n locale) with a cached per-language overview.

## From R2 verify (2026-09-30)
- TV: ambient can stay on the previous title while focus sits in the rail after fast Left presses; the rail "Home" label pill overlaps a lifted row heading.
- TV: returning to Home from the profile picker shows a 1-2 s frame of lifted rows animating over the hero copy (slow emulator; re-check on hardware).
- Web: mouse-wheel scroll leaves the previous row's caption line above the next row header (no top fade on the rows region).
- Form factor is recomputed from window size: Android split screen (< 600 dp) or a web resize across 640 px swaps LargeShell and NativeTabsShell and remounts the navigator (tab stacks lost). Consider hysteresis or keeping the stacks.
- HeroFade has no fallback when the masked-view native module is missing (fine for our builds; check after iOS pod install).
- No unit test covers the LargeShell vs NativeTabs selection.

## From R3 verify (2026-09-30)
- Web 390 px phone player: a source with subtitles gives 8 bottom buttons and the fullscreen button sits half off-screen; collapse the chips into an overflow menu below ~420 px.
- TV player side panels end ~10 px under the top of the control bar (web is fine).
- Dead code: `predictionReasons()` is only used by a test; `VersionsButton` is unused (pre-existing).
- One vocabulary for delivery methods: version cards say "Direct stream" for remux while the player info panel says "Repackaged".
- Phone Version card headlines the last played release while Resume starts the Recommended one (pre-existing logic; card is labelled "Last played").
- Big Buck Bunny WEB-DL: the web reason names an MKV container while TV playback info says MP4; check the server's container data.
- The exit dialog stays open when a deep link opens a detail screen inside the shell (R3 fixed it only for the player route).
- TV: once, after a long action sequence, focus returned to the Recommended card instead of Resume; not reproducible.
- Web: the ambient backdrop makes pages ~7.5 % wider than the window, so the page can scroll sideways (pre-existing, also Home).
- Episodes in a season without versions still offer a Versions button that opens an empty panel.
- jest prints an ICU warning because a test fixture lacks a parameter.
- Large-screen episode rows still use the pre-Aurora EpisodeRow look (left over from R3 slice 4).
- Backend: `title_not_found` failures offer the `otherVersion` action although the title does not exist.
