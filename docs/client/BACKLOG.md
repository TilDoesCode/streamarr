# Streamarr Client — backlog

Consolidated from the journals (M1.5 … B1). Triaged in F1 (2026-09-30): every earlier entry is either still open below
(with the reason it stays) or listed under "Fixed" with the task that fixed it. The journals hold the evidence.

## Decisions for the user

- Library rail entries (Movies / Series pages) — task F2, needs the B1 browse endpoints (done).

## Needs Xcode (pending-ios)

- iPhone/iPad: NativeTabs with Liquid Glass (iOS 26+), iPad sidebar, large titles and transparent detail headers,
  version side panel on iPad, Keychain vault, phone forms and keyboard insets.
- Apple TV: native top tab bar, focus restore (`ScreenFocusScope`), Menu-key Back chain, tvOS keyboard, remote via
  `useTVEventHandler`.
- Playback: expo-video on AVPlayer, VLCKit fallback, Swift media-caps (VideoToolbox, HDR/DV, audio route), Safari
  native HLS/HEVC/HDR, AirPlay and picture-in-picture.
- HeroFade has no fallback when the masked-view native module is missing (check after the first iOS pod install).

## Needs real hardware (Android TV, ideally a 2 GB device; a real phone)

- HEVC Main10 / HDR10 / Dolby Vision decode and HDR display modes; AC-3 / E-AC-3 / DTS / TrueHD passthrough; 4K on a TV SoC.
- VLC: direct rendering (zero copy, black on emulators), first-seek latency in MKV (2.7–7.3 s on emulators), HDR output
  (the TextureView cannot carry HDR), stall watchdog on a real stall.
- Hold-scrub tiers 30/60/120 s on a real remote (emulator sends one repeat; unit-tested).
- Memory: home screen uses ~520 MB native in the dev build; measure a release build (the 2 GB emulator had one player ANR
  at ~290 MB free after many bundle reloads in F1).
- Phone blur cost: the software-GL AVD shows RenderThread ~84 % with the blurred ambient; re-measure on a real phone.
- TV: returning to Home from the profile picker shows a 1–2 s frame of lifted rows over the hero copy (slow emulator).
- TLS failure message against a real self-signed server; TV keyboards other than Gboard.

## Player

- Decoder and dropped-frame figures are "—" for expo-video on Android; VLC decoder labels are best effort (needs an
  expo-video API for decoder stats).

## Browse, navigation and UX

- Form factor is recomputed from the window size: Android split screen (< 600 dp) or a web resize across 640 px swaps
  LargeShell and NativeTabsShell and remounts the navigator (tab stacks lost). Needs hysteresis or shared stacks
  (not small: navigator structure).
- Web: a duplicate history entry after popping the active tab (not re-checked since M2.4; P2 fixed titles and Back after
  sign-in only).
- Brand PNGs are large (icon 554 KB, top shelf 2.2–2.6 MB) because of dithered gradients; pngquant bands them. Revisit
  with a noise-free render if bundle size matters.

## Accounts

- Settings UI for sessions/devices, email change, two-factor setup and profile editing (feature work, not a fix).

## Tests and tooling

- Dev only: after a JS reload nothing is focused on TV until the first D-pad press; the dev client can start with a
  cached bundle.

## Server (backend track)

- Multi-rendition audio in HLS (#4); see the triage table in `journal/M1.5.md`.
- Palette overflow: overflowed urls can be overtaken by new ones (ordering only, nothing lost); the lock wraps a
  `ConcurrentQueue` where a plain `Queue` would do.
- `IndexerLanguageTests`: the search-term assertions are vacuous (Dev World searches are id-based); the language check
  carries the test.
- Art highlight is measured over the whole backdrop; add per-region values (right panel, left rail) if the client finds
  the whole-image value too strict.

## Next update (out of scope)

- Offline downloads of series and movies on phones and tablets.

## From F2 verify (2026-10-01)
- Android (TV and phone): the filled sort segment turns square-cornered after a sort or genre change; rounded on first mount and on web.
- TV: Right from the rail after a genre deep link lands on "All" (native spatial focus wins over the page's focus memory); needs a forced restore in large-shell for every tab.
- TV: a deep link that arrives while the rail has focus (e.g. streamarr://movies from Home) leaves focus on the rail.
- Web: the last-clicked genre chip keeps a focus ring after browser Back selects another chip (cosmetic).
- Tablet 1024 px: a poster caption's year is squeezed by two spec chips (shared PosterCard).
- TV sign-in: adb text input into the TV sign-in field does not arrive (test tooling; real keyboards untested).

## Fixed

- Server, B3 (2026-10-01): measured art `highlight` per title for the TV glass; palette queue dropped work silently
  (DropWrite channel; also in the spec warm-up and the mailer); unknown `vlcVideoCodecs` names answer 400; tests for
  the indexer language and the warm-up cap; configuration/setup docs; resume items carry the title. Dev World
  `--keep-data` kept a stale NNTP port (playback refused) — orchestrator fix after the B3 verify.
- Server, B2 (2026-10-01): per-request metadata language (Accept-Language, English fallback); VLC engine caps on the
  versions endpoint; persisted LRU release-container store; Dev World `--keep-data` restart; probe process-tree kill;
  palette overflow re-queue; first failure per cause logged at Warning; spec store indexed by series; useVlc
  start-failure test.
- Device-aware "Recommended" (was a decision) — P3 (server) + P2 (plain Play = Recommended).
- Web client hosting (was a decision) — P3 (/watch same origin) + P2 (client connects to its origin).
- Paused step-down to VLC showed frame 0 — P1. Frozen end frame after a cancelled up-next — P1 (end card).
- Continue watching for a played item started at 0 — P3 + P2. ▶ in the same frame as ▲ ignored — M4.2 slice 4.
- Picture-in-picture on Android — P1. `VLCObject (Media) finalized …` leak — P1. Black frame on a remux resume — not
  reproduced in the P2 verification (3/3 remux resumes at the saved position).
- Series "mark watched" toast named the episode — P2. 110 s skeleton on a hanging server — P2 (15 s read timeout).
- "Play" for titles without versions — P2 ("No versions yet"). No "watch again" for a fully watched series — P2.
- Watch state from another device after 1 min — P2 (refetch on focus/foreground/player exit).
- TV hero eyebrow / episode title — P2. German "Season 1" — P2 ("Staffel N"). Search filter across profiles — P2.
- Opaque header band above the art on web and Android detail — R3 (header strip after scroll) + F1 (phone: only a light
  status-bar gradient at scroll 0).
- Back from the player focused Play instead of the version card — P1.
- "container assumed" and "mkv not supported" on one card — R3 (one reason formatter, `_assumed` hidden).
- TV early D-pad presses and rail reopening on the last item — P2.
- Web: one page title for every route; Back after sign-in to /server — P2.
- Duplicate profile tiles after a server reset — P2 (dedupe by server + viewer id/username).
- Screen-level tests for home, search, detail and the version picker — P2 (`src/__tests__/screens.test.tsx`).
- Dev: `player-keys` listener dead after a JS reload — P1.
- Double probe on start (#27) — P3 (one ffprobe per viewer start).
- Web font gate waited up to ~12 s — F1 (3 s gate, brand fonts swap in when they arrive).
- TV rail "Home" label pill over a lifted row heading — F1 (solid pill; the focused rail dims the content beside it).
- TV ambient staying on the previous title after fast Left presses — not reproduced in F1 (the ambient follows the
  focused card after the debounce; see journal/F1.md).
- Web wheel scroll left the previous row's caption line — F1 (top fade on the rows region while scrolled).
- No unit test for LargeShell vs NativeTabs — F1 (`src/navigation/app-tabs.test.tsx`).
- R3 verify findings: 390 px player overflow, TV side panels under the bar, dead code, one method vocabulary, phone
  Version card headline, exit dialog on deep links, web ambient overflow, empty Versions button, jest ICU warning,
  pre-Aurora episode rows — all F1.
- BBB WEB-DL MKV vs MP4 container — B1 (predictions use the real container once a release was opened; persistence is
  the open server item above). `title_not_found` offered `otherVersion` — B1.
- TV focus once returned to the Recommended card instead of Resume — not reproduced in R3 or F1 regression passes.
