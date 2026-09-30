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
