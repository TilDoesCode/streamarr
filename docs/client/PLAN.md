# Streamarr Client — build plan (agent spec)

This is the binding spec for every agent working on the Streamarr viewer client and the
backend pieces it needs. The human-facing version (German, with diagrams) is
[`plan.html`](./plan.html). Progress lives in [`JOURNAL.md`](./JOURNAL.md) and
`journal/<TASK-ID>.md`. Read [`README.md`](./README.md) for the resume protocol.

## 1. Product

A Streamarr-native viewer app that replaces Jellyfin as the playback surface. Jellyfin
hides too much: it cannot show relevant states (resolving, fallback, repair, why a
transcode happens), cannot present release versions meaningfully, and cannot show
errors properly. This app talks to the Core Server directly.

**Core loop (v1 scope):** connect to server → sign in → pick profile → find something
(home rows or search) → pick version (or accept the recommended one) → watch → come back
later → continue watching / next episode. Everything is tracked server-side.

| Target | Priority | Input | Notes |
|---|---|---|---|
| Android TV / Google TV | **P1** | D-pad, back, media keys | Most important TV target |
| iPhone | **P1** | touch | Liquid Glass where available (iOS 26+) |
| iPad | **P1** | touch, keyboard, trackpad | Multi-column layouts, sidebar-adaptive tabs |
| Web (incl. iPad Safari) | **P1** | mouse, keyboard, touch | HTML5 video + hls.js |
| Apple TV | P2 | Siri Remote | Native tvOS focus engine |
| Android phone / tablet | P3 | touch | Should work, not the focus |

Hard requirements: **i18n** (German + English from day one, no hardcoded UI strings),
**multi-user** (several viewer accounts per device, "who's watching?" picker, fast
switching), **dark theme only** (hardcoded), TV UX on par with the best native TV apps.

Out of scope for v1: downloads/offline, quick-connect login, favorites/watchlist,
Chromecast, trickplay thumbnails, light theme, store release/EAS.

## 2. Decisions (made with the user — do not revisit)

- **Location:** the app lives in `client/` (separate from `server/`, `plugin/`, `web/`).
- **Stack:** Expo SDK 57 (React 19.2, RN 0.86) with `react-native` aliased to
  `react-native-tvos@0.86.x` so one codebase builds phone, tablet and TV;
  TV builds via `EXPO_TV=1` + `@react-native-tvos/config-tv`. Expo Router (typed routes),
  TanStack Query v5, NativeWind 4.2 (latest stable) + Tailwind 3.4, React Native Reusables,
  lucide icons, Reanimated 4, expo-image, FlashList, i18next + react-i18next +
  expo-localization, expo-secure-store (native tokens), MMKV (cache/settings),
  `openapi-typescript` + `openapi-fetch` generated from `server/openapi/v1.json`.
  Liquid Glass via `expo-glass-effect` / `@expo/ui` / NativeTabs on iOS 26+, graceful
  fallback (blur or solid surface) elsewhere. Package manager: npm.
- **Player: native first, VLC as fallback.** Ranking of playback methods:
  1. **Native direct play** of the original file from `/stream/{token}` when the device's
     native player supports container + codecs (Android: Media3 ExoPlayer handles MKV/MP4
     with HEVC/AV1/VP9/H.264, AC3/EAC3, DTS/TrueHD via passthrough when available;
     Apple: AVPlayer only MP4/MOV with H.264/HEVC + AAC/AC3/EAC3; web: browser codecs).
  2. **Native via server remux** (video stream-copied into fMP4 HLS, audio copied or
     converted, text subtitles as WebVTT). The normal case for MKV on Apple platforms
     and common on web. **New backend capability (M1.4).**
  3. **VLC direct play** (`expo-libvlc-player`: VLCKit 4 on iOS/tvOS, libVLC on Android)
     when native and remux cannot handle it (e.g. image subtitles, exotic audio without
     passthrough, remux failure) or when the user forces it.
  4. **Server full transcode** to HLS as last resort or when the user picks a reduced
     quality (bandwidth).
  The native engine library (`expo-video` vs `react-native-video`) is chosen by the
  player spike (M3.1) on measured evidence. All engines sit behind one TypeScript
  interface; the player UI overlay is our own and identical everywhere.
- **Device capabilities** come from a small local Expo module `client/modules/media-caps`
  (Android: MediaCodecList, display HDR capabilities, audio passthrough encodings;
  Apple: VideoToolbox HW decode support, HDR modes, audio route channels; web:
  MediaCapabilities / canPlayType). The client sends this profile when starting playback;
  **the server decides** the method and returns human-readable reasons.
- **Git:** commits go directly to `main` (checkpoints by the orchestrator, no push).
  Build agents do **not** commit.
- **Tests on simulators/emulators use Argent** (Software Mansion), via the `argent` CLI
  (`argent run <tool> ...`) or its MCP tools. Argent skills are installed in
  `.claude/skills/argent-*` — read `argent-tv-interact` for TV and
  `argent-device-interact` for phone/tablet/web before driving devices.

- **User decisions 2026-10-01 (after the F round):**
  - Android TV glass may be clearer: body text keeps >= 4.5:1, large text (>= 24 px regular or >= 18.66 px bold at the
    1920 design scale, WCAG "large text") needs >= 3:1 over the brightest art behind it.
  - Cards keep the best existing version's spec; the detail shows both when they differ ("4K HDR10 available · plays
    here in 1080p").
  - Metadata (overviews, titles, genre names) follows the viewer's app language, per request.
  - Converting only the audio does not count as transcoding for "Recommended" (unchanged).

## 3. Conventions (all agents)

- Never use plan mode, `EnterPlanMode`, `ExitPlanMode` or `AskUserQuestion` — you run
  unattended. Make reasonable decisions and record them in your journal file.
- Source comments: at most one line, only where genuinely needed.
- Environment: `source docs/client/env.sh` in every shell (dotnet, JDK 17, Android SDK).
- **Machine has 8 GB RAM.** Run at most one emulator/simulator at a time and shut it down
  when done (`adb -s <serial> emu kill`, `xcrun simctl shutdown all`,
  `argent run stop-all-simulator-servers`). Stop Gradle daemons after Android builds
  (`cd client/android && ./gradlew --stop`). Set `org.gradle.jvmargs=-Xmx2g` and
  `org.gradle.workers.max=4`. Never run two native builds concurrently.
- Xcode may not be installed yet (`xcodebuild -version` fails). If it is missing, skip iOS
  and tvOS verification, record it as `pending-ios` in your journal file, and continue.
- Backend: follow the existing architecture (BRIEF §1.1, §3.3, §11). All domain logic in
  the Core Server; `/stream` stays generic; every endpoint has explicit auth; the
  OpenAPI document `server/openapi/v1.json` is the contract — update it when the API
  changes (check how existing tests/tools keep it in sync), regenerate `web/src/api/schema.d.ts`
  (`cd web && npm run generate:api`) and keep `web` type-check and tests green.
  Update `docs/api.md` and the relevant docs page.
- Server build/test: `cd server && dotnet build Streamarr.sln` and `dotnet test` (use
  `--filter` while iterating; run the full suite before finishing).
- Client: TypeScript strict, `expo lint`, Prettier, jest-expo unit tests. No hardcoded UI
  strings (a unit test enforces de/en key parity and flags literal JSX text). No raw hex
  colors in components — use design tokens.
- Screenshots as evidence go to `docs/client/screenshots/<TASK-ID>/<target>-<name>.png`
  (keep them small; PNG from Argent is fine).
- Ports: Dev World for client work `39300` (Android emulator reaches it as
  `http://10.0.2.2:39300`), Dev World for backend self-tests `39310`, Expo web dev server
  `39301`, Metro `8081`.
- **Dev World isolation.** Backend and client work run concurrently, so client agents never
  build the server from the working tree. `scripts/devworld.sh` (created in M1.1) offers
  `publish` (build + publish the current Dev World into
  `~/.cache/streamarr-devworld/current` atomically — backend agents run it only when their
  work builds and tests green), `start [port]` (run the published snapshot in the
  background, wait for health, log to `/tmp/devworld-<port>.log`), `stop [port]` and
  `status`. Client agents use `start 39300`; backend agents test their own tree on `39310`.
  Generated media is cached in `server/tests/Streamarr.DevWorld/cache/` and shared (write
  via temp file + rename so concurrent instances cannot corrupt it).
- Web verification with Argent: launch Playwright's Chromium
  (`~/Library/Caches/ms-playwright/chromium-*/chrome-mac*/Chromium.app/Contents/MacOS/Chromium`)
  with `--remote-debugging-port=9222 --user-data-dir=/tmp/argent-chromium` and drive it as a
  `chromium` device; close it when done.
- Test audio stays silent: Android emulators run with `-no-audio` (the AVDs have `hw.audioOutput=no`; with
  Argent `boot-device` never pass `sound: true`), Chromium always gets `--mute-audio`, and nobody changes the
  Mac's output volume or mute state.

## 4. Journal protocol (mandatory — this is how work survives a crashed session)

1. At task start, create `docs/client/journal/<TASK-ID>.md` with `Status: in-progress`
   and a short intent. If the file already exists with `Status: in-progress`, a previous
   attempt was interrupted: read it, inspect the working tree, and **continue** rather
   than restart.
2. Keep it updated as you go (decisions, commands that matter, problems, workarounds).
3. At the end set `Status: done` (or `blocked` / `partial` with the reason) and add:
   summary, files changed, verification evidence (commands + results, screenshot paths),
   open issues / follow-ups, and anything the next task must know.
4. Append exactly one line to `docs/client/JOURNAL.md`:
   `- <TASK-ID> · <done|partial|blocked> · <one-line summary> → journal/<TASK-ID>.md`
   (use `>>` append; never rewrite the file).

## 5. Milestones and tasks

### M0 — toolchain (done by orchestrator)
Expo skills (official `expo/skills`), Argent 0.26, watchman, CocoaPods, JDK 17, Android SDK
(platform 36, build-tools 36), AVDs `Streamarr_GoogleTV_1080p` (Google TV, API 36) and
`Streamarr_Phone` (Pixel 9, API 36). Xcode: pending user install.

### M1 — backend

#### M1.1 Dev World harness
A one-command local world for developing and testing the client without real Usenet.
- New console project `server/tests/Streamarr.DevWorld/` (added to `Streamarr.sln`),
  modelled on `server/tests/Streamarr.E2E.Harness` (real Core Server + `MockNntpServer` +
  canned `INewznabClient` + canned `ITmdbClient`, seeded via config/DI).
- Binds `0.0.0.0:39300` by default (`DEVWORLD_PORT` / `DEVWORLD_HOST` override). CORS
  permits any origin for viewer endpoints in this harness only.
- **Catalog:** ≥ 6 movies and ≥ 2 series (one with ≥ 2 seasons, 3–6 episodes per season).
  Prefer openly licensed titles with real TMDB ids and real artwork URLs (Blender open
  movies: Big Buck Bunny, Sintel, Tears of Steel, Elephants Dream, Cosmos Laundromat,
  Spring, …). Metadata may be captured once into a checked-in fixture JSON (you can read
  public TMDB web pages without an API key; verify ids). If artwork cannot be obtained,
  generate poster/backdrop images with ffmpeg and serve them from the harness. Include
  certifications (one title rated 16/R to test the age gate), genres, runtimes, overviews
  (EN, DE where easily available), episode stills/titles/air dates.
- **Versions / media matrix:** each title has 2–5 releases whose names parse to the real
  attributes of the generated media (the ranker must see what the file really is):
  MP4 H.264/AAC · MKV H.264 + EAC3 5.1 + SRT (de, en) · MKV HEVC Main10 HDR10 (2160p or
  1080p) + TrueHD or DTS · MKV AV1 + Opus (if the local ffmpeg has an AV1 encoder) ·
  MKV with two audio languages (de + en) and ASS styled subtitles + forced subs · one
  "legacy" release that needs a full transcode (e.g. MPEG-2 video) · at least one **dead**
  release (missing articles) ranked first somewhere to exercise auto-fallback · one
  degraded release. Burn the title + variant + running timecode into the picture
  (ffmpeg `drawtext`) so screenshots prove the right item/position is playing.
- **Memory budget:** the mock NNTP server keeps articles in memory and two instances may
  run at once (ports 39300 + 39310); keep total published payload ≲ 450 MB (short clips: movies 3–6 min, episodes 2–3 min, low bitrates; the
  4K HDR sample may be ~60 s). Generate media once into
  `server/tests/Streamarr.DevWorld/cache/` (git-ignored), reuse on later boots.
- **Viewer module enabled** with seeded accounts (print them): `anna` (adult, transcoding
  allowed), `ben` (TOTP enabled, print secret + a current code helper), `kind` (max age 12,
  block unrated), `gast` (transcoding not allowed, max 1 concurrent stream). Password for
  all: `streamarr`. Admin `admin` / `streamarr-dev` so the management UI works too.
  Watch thresholds lowered for fast tests (minimum resumable length 60 s). Email mode:
  test outbox.
- Writes `server/tests/Streamarr.DevWorld/cache/devworld.json` (URL, accounts, titles,
  work ids, release ids, which variant each release is) for agents/tests, and prints a
  banner.
- Add Codecraft action `devworld` to `.codecraft/actions.json` (group `dev`, port 39300).
- Verify: boots in < 60 s with a warm cache; curl flow: viewer login → existing
  `/api/v1/viewer/*` endpoints work; admin `/api/v1/search` returns the fixture titles with
  ranked releases; `/api/v1/resolve` + `/api/v1/stream/{token}` serves bytes that ffprobe
  identifies as the expected codecs; the dead release falls back.

#### M1.4 Server remux ("direct stream") — do this before M1.3
Extend `server/src/Streamarr.Server/Transcoding/` with a stream-copy mode:
- Planner gains a middle tier: `direct` → `remux` → `transcode`, each with reasons.
  Remux when the client can decode the video (codec, profile, bit depth, HDR format,
  resolution) but not the container and/or audio and/or subtitle format.
- Video `-c:v copy` into fMP4 HLS; HEVC tagged `hvc1`; HDR10/HLG colour metadata
  preserved (`colr`, mastering/CLL where possible); master playlist `CODECS` exact
  (`hvc1.2.4.L150.B0`-style strings derived from the bitstream), `VIDEO-RANGE=PQ|HLG|SDR`.
  Dolby Vision: profile 8 plays as its HDR10 base layer (tag `hvc1`); profile 5 → transcode.
- Audio: copy when the client supports it, otherwise convert (EAC3 5.1 → AC3 5.1 → AAC
  stereo, honouring `maxAudioChannels`); multiple audio renditions or re-plan on switch —
  pick the simpler robust option and document it.
- Subtitles: text-based (SRT/ASS/WebVTT) as WebVTT subtitle renditions
  (`EXT-X-MEDIA TYPE=SUBTITLES`); image-based (PGS/VobSub) are not deliverable via remux →
  report so the client can offer VLC or a burn-in transcode.
- **Keyframe-accurate VOD playlist:** build a keyframe index cheaply over range reads
  (Matroska `Cues`; MP4 `stss`/`stts`), fall back to an ffprobe packet scan with a time
  budget, else fall back to transcode. Segment boundaries at the first keyframe ≥ each
  target boundary (target 6 s); `EXTINF` = real durations; `#EXT-X-ENDLIST`. Seeks restart
  ffmpeg at the segment's keyframe with timestamps continuous with the playlist.
- Reuse the existing session/capability model (`/api/v1/transcode/{capability}/…`),
  capacity accounting (remux is far cheaper — count it separately or with a lower weight),
  admin sessions view shows the mode. Keep the full-transcode path unchanged.
- Tests: keyframe index parsing (MKV + MP4 fixtures), segment planning, planner decisions
  matrix, integration test generating media with ffmpeg → remux → validate with
  `server/tools/hlssim` (drift/discontinuity limits) and ffprobe; seek to a late segment.
- Docs: `docs/transcoding.md` (remux section, limits), `docs/api.md`.

#### M1.2 Viewer catalog API
Under `/api/v1/viewer/catalog` (viewer auth policy, module gate, age policy):
- `GET search?q&type=movie|tv|any&limit` — TMDB candidates only (no indexer calls).
- `GET discover` — home rows (trending movies, trending series, popular …) from TMDB,
  cached for hours; add the needed `ITmdbClient` methods (with safe defaults for existing
  implementations) and fixture data in the Dev World.
- `GET movies/{tmdbId}` — details (title, original title, year, overview, tagline, genres,
  runtime, certification, vote average, poster/backdrop/logo URLs where available),
  the viewer's watch state, and access (`allowed`, reason).
- `GET series/{tmdbId}` — series details + season summaries + watch summary (next episode
  to watch for this viewer, played counts).
- `GET series/{tmdbId}/seasons/{n}` — TMDB episodes with per-episode watch state; fast.
  `?availability=true` overlays version counts (uses the existing season fan-out).
- `GET works/{workId}/versions` — ranked releases as **VersionDto**: releaseId, raw release
  name, resolution, source, video codec, bit depth, HDR format, audio codec, channels,
  Atmos, languages, subtitle hints, edition, release group, size, estimated bitrate,
  age, health, local availability (ready/downloading pre-download), rank, `recommended`.
  Never expose NZB URLs, indexer names/keys. Slow (indexer fan-out) — cache and allow
  `?refresh=true`.
- Age gate: lists hide works the viewer may not watch when the certification is known
  (and unknown ones when `blockUnrated`); detail/versions/playback return
  `403 age_restricted`.
- Tests, OpenAPI, `docs/api.md` §13, `docs/viewers.md`.

#### M1.3 Viewer playback API
Under `/api/v1/viewer/playback`:
- `POST` `{ workId, releaseId?, startPositionTicks?, audioStreamIndex?, subtitleStreamIndex?,
  device: DeviceProfile, preferences: { engine: auto|native|vlc, maxHeight?, maxBitrateKbps?,
  audioLanguage?, subtitleLanguage?, subtitleMode: off|forced|always } }` →
  `202 { playbackId, state }`. Runs asynchronously.
- `GET {playbackId}` → state machine: `queued → resolving → (fallback) → (repairing, with
  progress/eta) → planning → starting → ready | failed`, plus `attempts[]` (release +
  health per hop), `fallbackFrom`, current `version` (VersionDto).
  When `ready`: `method: direct|remux|transcode`, `engine: native|vlc|web`, media `url`,
  `mediaInfo` (container, duration, video: codec/profile/bitDepth/size/fps/HDR; audio
  tracks: index/codec/channels/language/title/default; subtitle tracks:
  index/codec/language/title/forced/default/textBased/`deliveredAs`), `decision.reasons[]`
  (human-readable, stable codes + params for i18n), `streamToken`, `resumePositionTicks`.
  When `failed`: `error { code, message, params }` + `suggestedActions[]`
  (`retry`, `otherVersion`, `lowerQuality`, `useVlc`).
- `POST {playbackId}/switch` — re-plan at a position with new audio/subtitle/engine/quality
  or another release (returns a new async state).
- `POST {playbackId}/stop` — ends transcode/remux sessions, frees the stream slot.
- **DeviceProfile:** platform (`ios|ipados|tvos|android|androidtv|web`), ordered engines
  with their capabilities (containers, video codecs with max size/bit depth/HDR formats,
  audio codecs with max channels + passthrough flags, subtitle formats, HLS support),
  `vlcAvailable`, optional bandwidth cap. Selection follows §2's ranking.
- Enforce `allowTranscoding` (blocks full video transcode; remux stays allowed — document
  it), `maxConcurrentStreams` (active = playback with a recent heartbeat/progress →
  `409 too_many_streams`), age gate. `too_many_streams` names the other device if known.
- Integrate with watch state: `/viewer/watch/progress` accepts `playbackId` (fills release
  and stream token) and keeps the playback alive; idle playbacks expire.
- Tests for every stage/decision/enforcement path with fakes, OpenAPI, docs.

### M2 — client foundation

#### M2.1 Scaffold
`client/`: Expo SDK 57 app (Expo Router, TypeScript strict) with the tvOS alias,
`@react-native-tvos/config-tv`, NativeWind 4.2 + Tailwind 3.4, React Native Reusables
initialised, lucide, Reanimated 4, expo-image, lint/format/jest-expo, app config for
name **Streamarr**, bundle id / package `dev.streamarr.app`, scheme `streamarr`, dark
`userInterfaceStyle`, Android TV banner + leanback launcher, placeholder icons.
Scripts: `web`, `ios`, `android`, `tv:android` (`EXPO_TV=1` prebuild + run), `tv:ios`,
`typecheck`, `lint`, `test`, `gen:api`. Continuous Native Generation: `client/android` and
`client/ios` are generated and git-ignored; all native config lives in `app.config.ts` and
config plugins. Prefer **one Android build that runs on both Google TV and phones**
(leanback launcher + `android.software.leanback`/touchscreen not required; UI decides via
`Platform.isTV`) so switching targets does not need a clean prebuild — verify it works.
iOS vs tvOS need separate prebuilds (`EXPO_TV=1` for tvOS). Verify a placeholder screen with a focusable
button on: web (Chromium via Argent), Google TV emulator (D-pad moves focus, visible
focus style), Android phone emulator; iOS/tvOS if Xcode exists. Add Codecraft actions
`client-web` (port 39301) and `client-metro`.

#### M2.2 Design system, i18n, focus primitives
Dark tokens (surfaces, text, accent, states, focus ring), a responsive type/spacing scale
for handheld vs 10-foot UI, form-factor hook (`phone|tablet|tv|desktop-web`).
Components: Button (variants), IconButton, Badge/Tag, Skeleton, ProgressBar,
PosterCard / LandscapeCard / EpisodeRow, Shelf (horizontal row with TV focus memory),
Hero, EmptyState, ErrorState (code → localized message + actions), Sheet/Dialog,
Spinner, Toast. **TV focus**: every interactive element focusable with a strong focus
treatment (scale + ring/glow, Reanimated on UI thread), focus guides for rows/rails
(`TVFocusGuideView`), remembered focus per row, predictable up/down between rows, back
handling. i18n: i18next + expo-localization, `de` + `en`, language override stored per
device, ICU plurals, date/duration formatting, key-parity + no-literal-text tests.
A hidden `/dev/gallery` route renders every component (for screenshots).

#### M2.3 Data layer, auth, multi-account
`gen:api` generates types from `server/openapi/v1.json`; `openapi-fetch` client with auth
middleware (bearer, single-flight refresh rotation, `refresh_token_reused` → sign-out),
error envelope → typed `AppError` with i18n mapping. Account store (secure-store native,
localStorage web): multiple accounts across servers. Screens: server connect (URL
validation via `/api/v1/viewer/auth/options`, clear messages for unreachable /
`module_disabled`), sign-in (password; email code; forgot password; second factor;
must-change-password), "who's watching?" picker, add/switch/remove account. React Query
with per-account key partitioning, cache reset on switch, AppState/online managers,
persisted cache for home rows (MMKV). Verify against the Dev World on web + Google TV.

#### M2.4 Navigation shells
Routes: `(onboarding)` (server, sign-in, profiles) and `(app)` with Home, Search,
Profile/Settings; stacks for `movie/[id]`, `series/[id]`, `series/[id]/season/[n]`,
`play/[playbackId]`. iPhone/iPad: NativeTabs (Liquid Glass on iOS 26+), sidebar-adaptable
on iPad. Android TV: collapsible left rail with focus handling. tvOS: top tab bar
(native). Web: responsive sidebar/top bar. Back behaviour correct on every target.

### M3 — player spike (risk first)

#### M3.1 Engines + media caps
Engine interface (`load`, `play`, `pause`, `seek`, `setAudioTrack`, `setSubtitleTrack`,
events: state, time, buffering, tracks, error, ended, stats). Implement and compare
`expo-video` vs `react-native-video` as the native engine; `expo-libvlc-player` as VLC
fallback; web engine (`<video>` + hls.js, Safari native HLS). Build `modules/media-caps`.
A dev route plays every Dev World variant (direct MKV/MP4 via `/stream`, HLS via a
transcode/remux session) and logs metrics: time-to-first-frame, seek latency, HW decode
(where observable), dropped frames, track switching, remote/media key events. Run on
Google TV emulator, Android phone, web; iOS/tvOS when Xcode exists. Record a comparison
table and the engine decision with reasons in the journal.

### M4 — core loop
- **M4.1 Browse:** Home (hero, continue watching with progress, next up, trending/popular
  rows), Search (debounced, type filter, recent searches), Movie detail, Series detail with
  seasons + episodes (played/progress), mark played/unplayed, Version picker (cards with
  tags, size, bitrate, health, local-ready, recommended, predicted method for this
  device). Skeletons, empty and error states everywhere.
- **M4.2 Playback:** start flow with the visible stepper (§ plan.html §5), resume vs
  from-start, the player overlay (TV remote map: OK/playPause toggle, ◀/▶ −10 s/+30 s with
  accelerating hold-scrub, rewind/fastForward keys, ▲ panels, ▼ progress, back closes
  overlay then exits), panels for audio / subtitles / version / quality / engine / info
  ("stats for nerds"), mobile gestures (tap toggle, double-tap seek, scrub, pinch-fill,
  lock landscape), PiP + AirPlay where the engine supports it, up-next card with countdown
  and autoplay, progress reporting (start, every 10 s, pause, background, stop, offline
  queue with retry), automatic step-down to the next method on playback error, localized
  error states with actions.
- **M4.3 Loop verification:** end-to-end on Google TV, iPhone, iPad, web (and Apple TV,
  Android phone): sign in → search → play → quit mid-way → relaunch → continue watching →
  finish → next episode. Record Argent flows where supported.

### M5 — polish
Android TV first (focus motion, row memory, long-press, media keys, overscan-safe
layout, performance on lists), Apple TV (top tabs, Siri Remote swipe scrubbing), iPad
(sidebar, split-view sizes), iOS Liquid Glass surfaces, web + iPad Safari (keyboard
shortcuts, responsive), accessibility labels, i18n completeness.

### M6 — acceptance
Argent flows for the loop on every target, adversarial review (correctness, security of
tokens/capabilities, UX states, i18n), screenshots of every screen per form factor, docs
(`client/README.md`, `docs/client/*`), Codecraft actions.

### P — polishing round (user request 2026-09-30)
No Xcode and no real hardware in this round: every pending-ios and hardware item in
[`BACKLOG.md`](./BACKLOG.md) stays open. Tasks P1–P3 below; their guidance and acceptance
lists live in `orchestrator.js` (`node docs/client/prompt-cli.mjs build P1`).
- **P1 player polish** (client): paused step-down frame, end card after a cancelled up-next,
  focus back to the opener, Android phone picture-in-picture, native leaks and dev key listener.
- **P2 browse, navigation and accounts polish** (client): the "Browse and UX polish" and
  "Accounts" items of the backlog, web titles and history, screen-level tests.
- **P3 backend polish** (server): continue watching and played items, the double probe, and
  the product decisions the user makes in this round.

### R — visual identity and one large-screen shell (user request 2026-09-30)
The user: the app is "very plain and boring", has "no visual identity", and web and TV
"diverge too much". Dark only, as before.
- **D1 design directions** (docs only, no app code): three distinct identities with mockups
  on real Dev World artwork in `docs/client/design/`; the user picks one.
- **R-tasks** implement the chosen direction; defined after the choice. Principle for every
  R-task: TV, web desktop and tablet share **one** large-screen layout (navigation, hero,
  rows, detail, version panel, player overlay, motion); only the input model differs
  (focus + D-pad on TV, pointer + keyboard on web). Phones get the compact variant of the
  same components.

#### R — decision (user, 2026-09-30): Aurora + Signal spec labels, real Liquid Glass on iOS
Direction **C · Aurora** from `docs/client/design/` (tokens and notes in its `README.md`,
mockups `jpg/C-*.jpg`), plus **B · Signal**'s monospace spec labels (resolution, HDR, codec,
audio, playback method) and signal-bar health on cards, the version panel and the player
info panel. Fonts: Outfit (display) + Figtree (text) + JetBrains Mono (spec labels only).
User references: Apple TV app (ambient artwork, glass, calm motion) and Infuse (rich,
precise technical detail).

**Glass rule (hard requirement from the user):** on iOS, glass is **real Liquid Glass**, never
an imitation. Use, in this order:
1. native chrome that adopts Liquid Glass by itself on iOS 26: `NativeTabs` (tab bar,
   `minimizeBehavior="onScrollDown"`, search role; sidebar on iPad), native Stack headers and
   toolbars (transparent headers on detail screens), native `formSheet` with a transparent
   `contentStyle` for sheets (version picker on iPhone), native menus;
2. `expo-glass-effect` (`GlassView`, `GlassContainer`) for our own surfaces and controls:
   non-interactive for surfaces (panels, rails, info strips), `isInteractive` only for real
   controls (player buttons, chips);
3. `@expo/ui` SwiftUI `GlassEffectContainer` + `glassEffect`/`glassEffectId` only where glass
   pieces must merge or morph (player control cluster).
Guards: `isLiquidGlassAvailable() && isGlassEffectAPIAvailable()`; below iOS 26 fall back to
`expo-blur` system material; with Reduce Transparency render a solid surface. Never animate
opacity on a `GlassView` or its ancestors, never put `overflow: 'hidden'` on a glass ancestor
(glass clips itself via `borderRadius` + `borderCurve: 'continuous'`). tvOS: use Liquid Glass
where `expo-glass-effect` supports tvOS 26, otherwise the tvOS system blur. Other platforms
get the Aurora glass look without pretending to be native: web = CSS `backdrop-filter`
(blur 30–40 px, saturate) + 1 px top highlight; Android phone/tablet = translucent tinted
surface (optionally `expo-blur`); Android TV = solid translucent surface, no runtime blur.
All glass lives behind one `Glass` component with platform files, so screens never branch.
iOS cannot be built or run this round (no Xcode): the iOS paths are written, typechecked
and unit-tested (availability and fallback logic), and stay pending-ios for visual checks.

Tasks (guidance and acceptance in `orchestrator.js`):
- **R0 server** (parallel to client work): per-title `tint`/`tint2` extracted from artwork
  and a spec summary (resolution, HDR, codec, audio) on catalog items.
- **R1 client foundation**: Aurora tokens, fonts, `Glass`, ambient backdrop, focus/hover/press
  motion, `SpecLabel` + `SignalBars`, brand assets (wordmark, icon, splash, TV banner),
  iOS native chrome settings, a component gallery screen.
- **R2 one large-screen shell**: rail, hero, rows and cards, search, settings, profile picker
  and sign-in; TV, web desktop and tablet render the same layout.
- **R3 detail, version panel, player, phone**: detail + glass version panel, player overlay
  and panels, phone compact variants.

### F — follow-up round (user request 2026-09-30, evening)
The user looked at the R3 detail screenshot on Google TV and asked to fix the open small
findings and the details that do not match the mockup: the background behind the rail (the
artwork stops at the rail and leaves a dark band), the glow on the focused version card
(double ring, clipped at the panel's list edge) and the few rail entries.
Decisions (orchestrator, following the approved mockups):
- The artwork and ambient are full-bleed on every shell screen; the rail floats above them as
  glass. Android TV glass is a translucent tinted surface without runtime blur (PLAN R rule
  "solid translucent surface"), not an opaque grey; Reduce Transparency stays solid.
- One focus ring per card, tinted glow, never clipped by a scroll viewport.
- The rail gets the mockup's library entries: Movies and Series pages (browse by genre and
  sort, poster grid, paging). The server gains a browse endpoint for that; Settings and the
  profile stay at the bottom. No theme toggle (dark mode is fixed), no watchlist feature.
Tasks (guidance and acceptance in `orchestrator.js`):
- **B1 server**: catalog browse + genres endpoints (TMDB discover, age gate, tint/spec, Dev
  World fake), `title_not_found` without "other version", prediction uses the real container.
- **F1 client fixes**: the screenshot details, the R3 verify findings, the small R1/R2 leftovers
  and a truthful backlog triage.
- **F2 client library**: Movies and Series pages on every form factor and the new rail entries.

### G — second follow-up round (user request 2026-10-01)
The user approved packages 3 and 4 of docs/client/next-steps.html with the orchestrator's recommendations (see the
decisions in section 2) and added: on TV the library pages' two stacked chip rows (genres, then the sort pill) look odd.
Tasks (guidance and acceptance in `orchestrator.js`):
- **B2 server**: per-viewer metadata language (Accept-Language), spec warm-up so cards carry specs without opening a
  title, VLC engine caps on the versions endpoint, persistent bounded container store, Dev World keeps its data on
  restart when asked, cleanup (orphaned probes, palette queue, logging, spec store index, useVlc test).
- **F3 client**: one chip row on the library pages, clearer TV glass, both specs on the detail, Accept-Language, no
  navigation rebuild on resize/split screen, account management in Settings, F2 leftovers and small items, then the
  VLC caps once B2 is in.
- **B3 server** (added after F3 slice 2): a measured art highlight per title next to tint/tint2 so the client can size
  the TV glass per title (the rule over the brightest art alone only allowed 0.70 -> 0.64), plus the B2 verify
  follow-ups. F3 then uses the highlight and fixes the near-square tablet detail.

### H — Apple platforms, polish and audio renditions (user request 2026-10-01, afternoon)
The user installed Xcode 27 (iOS 27 and tvOS 27 simulators) and asked for packages 1, 2 and 4 of the round G report:
iPhone/iPad/Apple TV running, the polish round, and multi-rendition audio. Real hardware (Android TV device, real phone,
real iPhone/Apple TV) is tested by the user afterwards and is out of scope here; everything Apple runs on simulators.
Tasks (guidance and acceptance in `orchestrator.js`):
- **B4 server polish**: e-mail code cooldown answered explicitly, viewer e-mails in the viewer language, atomic sign-out
  of other sessions, `vlcHdrFormats=none`, artwork in the viewer language, display name/avatar editable, B3 leftovers.
- **B5 server audio renditions**: remux and transcode deliveries carry the offered audio tracks as HLS audio renditions
  so players switch language in-session (backlog #4).
- **I1 iPhone**: first build and run on iOS, core loop, Liquid Glass native chrome, Keychain, Apple playback (media
  caps, AVPlayer, VLCKit fallback, PiP, AirPlay); muted simulator playback (`EXPO_PUBLIC_TEST_MUTED=1`).
- **I2 iPad and Safari**: the large shell on three iPad sizes, multitasking sizes, keyboard and pointer, the web client
  in Mobile Safari with native HLS.
- **I3 Apple TV**: tvOS build, focus engine, Menu Back chain, Siri Remote and keyboard, AVPlayer playback.
- **F4 client polish**: the F3 verify follow-ups, profile editing and the B4 endpoints.
- **F5 client audio renditions**: in-session audio switching on every player using B5.
- **B6 server** (added after I1 slice 3): tone-mapped HDR -> SDR transcodes tagged bt709 so AVPlayer accepts them
  (VIDEO-RANGE consistent with the stream tags, guarded in e2e), plus the B5 verify follow-ups.
- **B7 server** (added after I1 slice 4): Cache-Control no-store on every secret-bearing response (iOS cached a
  token response on disk), engine-correct reason lines for VLC predictions, small B4/B6 follow-ups.
Order: server B4 -> B5 and client I1 -> I2 -> I3 -> F4 -> F5 run as two tracks in parallel; one device and one native
build at a time.

#### H — user review 2026-10-02 (after F4)
The user looked at the F4 screenshots: the iPhone hero stops below the status bar, they saw no back button on the iPad
detail, TV focus rings of neighbouring buttons touch, and on large screens the always-visible Versions panel takes the
space that should belong to content. Versions are a technical detail you rarely need.
- **F6 client**: edge-to-edge phone screens, a back control on every detail-type page, one TV focus spacing rule.
- **D2 widescreen detail concept** (docs only, user picks): content first, versions in a sheet; series show their
  episodes side by side at the bottom, selecting one updates the copy and buttons above and marks it, Play or the
  version sheet from there; series facts smaller (e.g. on the right). Mockups for TV, iPad and web desktop.
- **F7 client**: implements the chosen D2 concept; defined after the choice.
Order: D2 runs now beside F6 (no devices); F5 after F6; F7 after the user's choice.

**D2 decision (user, 2026-10-02 14:20):** variant 1 **Bühne**. Additions from the user:
- **No navigation events** when the episode or the season changes: copy, buttons, states, chips and backdrop update in
  place (screen-local state); no push/replace/setParams, no history entries on web, Back leaves the page. A deep link
  may still choose the initial season/episode.
- **What plays must stay visible:** next to Play/Resume a row of chips for exactly the version that button starts:
  which version (resolution, HDR format, video codec, audio codec + channels, source) and — most important — the
  playback method (direct play / direct stream (remux) / transcode / VLC) as the most prominent chip, with the reason
  when it is not direct. Resume shows and starts the same version it resumes. For series this follows the selected
  episode.
- Defaults the user did not object to: TV Select on an episode plays it (long press opens its versions); the movie's
  lower half stays artwork; no network/status line (needs a server field).
- **D2b** (docs, now): add the version chip row and the no-navigation rule to the Bühne mockups. **F7** implements the
  Bühne after F5.
**User decisions 2026-10-02 18:40 (implemented in F7 S4):**
- **Forced subtitles follow the audio language.** On an audio switch (in-session or `/switch`) a forced subtitle moves
  to the forced track of the new audio language, or off when that language has none; the server's `subtitleMode:
  forced` rule ("a forced track in the audio language") is the reference. A full (non-forced) subtitle the viewer
  picked on purpose stays as it is. This replaces F5's "an audio switch never changes the subtitle".
- **Phones resume the last played version too.** Phone Resume uses the same `playTarget` as the Bühne (last played
  version when it is still offered and playable here, else the recommendation), and the phone version card names that
  version with the method and a "Zuletzt gespielt" marker, so card and Play never disagree.

### I — tip top (user request 2026-10-04 16:10: "mach weiter bis die app tip top ist")
Goal: every target feels finished. No known defect in the core flows, no visual rough edge, the Apple TV native gaps
closed, release builds checked, the backlog cleared or parked with a reason (real hardware only). Real hardware stays
out of scope (the user tests it). Order and parallelism (8 GB RAM, one simulator/emulator at a time, disk ~14 GB free):
- **Phase 1 (parallel):** **Q1** quality walkthrough on every device (no code changes) ‖ **B8** server follow-ups
  (no devices, Dev World 39310) ‖ **T1** tests and code health (no devices, in its own git worktree, merged by the
  orchestrator).
- **Phase 2 (client, one after the other, each verified):** **F8** TV polish (JS, Google TV + Apple TV) → **I4** Apple
  TV native focus and Menu (tvOS rebuild) → **F9** phones, tablets and web. Q1 findings are assigned to these three by
  the orchestrator (P1/P2 must be fixed, P3 fixed when cheap, rest to BACKLOG).
- **Phase 3:** **R1** release builds (Android TV APK on the Google TV AVD, iOS/tvOS Release on the simulators, web
  production export): start time, memory, the dev-only crashes, bundle size → **Q2** final walkthrough with the Q1
  checklist on every device + round I report.
Decisions taken by the orchestrator (technical, no user decision needed):
- **Replay keeps a resume point** (backlog, F4 slice 4): fixed on the server. After a playback completed the work, a
  later report of the same playback whose position went back below the resume threshold starts a new viewing (resume
  point again, played state stays); post-credits reports past the completion threshold stay ignored.
- **Severity scale for Q1/Q2:** P1 broken flow, crash, data loss, security, sign-out without reason; P2 visible defect
  (layout break, clipped/wrong text or language, lost focus, wrong state, focus ring touching a neighbour); P3 polish
  (spacing, alignment, motion, copy tone). Round I is done when Q2 finds no P1/P2 on any target.
**Re-plan after Q1 S1 (orchestrator, 2026-10-04 18:10):** Q1 S2 (Apple targets) runs on the devices while F8 and F9
start with a code-only slice each in their own git worktree (jest only, no devices), so both lists of S1 findings are
fixed at the root before the live slices. After Q1 S2 the worktrees are merged; F8 S2 (Google TV + Apple TV) and F9 S2
(web, Android phone, iPhone, iPad, Safari) check every fix live, one device at a time, then each is verified.
Assignment of the Q1 S1 findings (P1/P2 must be fixed, P3 fixed when cheap, else BACKLOG with a reason):
- **F8 — player, playback and TV:** Q1-01, 02, 13, 15 (subtitle names, codec label), 25 (TV JS thread busy during
  playback: profile what runs per tick), 28, 39, 40, 41; the replay report at position 0 (B8 follow-up); the F8
  BACKLOG items (Google TV sign-out cause first: refresh rotation interrupted by an app kill; versions-loading state
  that keeps focus; stage pill without the episode number).
- **F9 — browse, detail, Home, Settings, sign-in, search (every size):** Q1-03, 04/26/36 + 27 (series initial
  selection = the episode with an active resume point first, then next up; watched + resume point shown together),
  05, 06, 07, 08, 09-12, 14, 15 (genre and certification names), 17-24, 34, 37, 38, 43, 44, 45.
- Dev-client-only and emulator-load items (Q1-29, 32, 33, 35, 30) go to R1 (release builds).
**I4 approach and decisions (orchestrator, 2026-10-04 20:05, after the I4 research in docs/client/journal/I4.md):**
- One small Expo module `client/modules/tv-native` (tvOS only, so the cached iPhone/iPad dev build stays valid; JS
  calls guarded to Apple TV): a Menu gate that hands Menu to the app's BackHandler only while JS claims it, a focus
  request that does not go through the React Native root view (+ `TVFocusHost` at screen/sheet roots), and the tab
  bar's content scroll view for Settings. Built in its own git worktree (`../streamarr-i4`, Pods APFS-cloned,
  single-arch DerivedData) so the main tree's iOS prebuild stays untouched; a probe build settles the two unproven
  causes before the fixes.
- **Deep link over an open detail (item 8):** push by title id with de-duplication on every platform — a link to the
  title that is already open returns to it (no second copy), a link to another title is pushed so Back returns to
  where the viewer was.
**R1 decisions (orchestrator, 2026-10-04 21:25):** release builds ignore `EXPO_PUBLIC_TEST_MUTED` by design, so Apple
release builds on the simulators never start playback (the user sits next to the Mac): first frame is measured in
release on Android (AVDs without audio output) and web (`--mute-audio`) only; Apple targets keep their dev numbers.
R8 and resource shrinking are tried in S2 with a smoke test and adopted in app.config only if the release build
still plays, signs in and browses; the APK ships arm64 + x86_64 only if the AVDs need it, else arm64-v8a.
