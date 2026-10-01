export const meta = {
  name: 'streamarr-client-w10',
  description: 'W10 (resumes W9): player spike first, then navigation shells, browse and playback UI (client) with backend follow-ups in parallel; fail-stop, bounded verification',
  phases: [
    { title: 'Client', detail: 'M3.1 player spike -> M2.4 navigation shells -> M4.1 browse -> M4.2 playback (waits for M1.5)' },
    { title: 'Backend', detail: 'M1.5 backend follow-ups (starts when M3.1 is committed)' },
    { title: 'Checkpoint', detail: 'path-scoped git commit after each finished task' },
  ],
}

const skip = new Set((args && args.skip) || [])

const RESULT = {
  type: 'object',
  properties: {
    taskId: { type: 'string' },
    status: { type: 'string', enum: ['done', 'partial', 'blocked'] },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    verification: { type: 'array', items: { type: 'string' } },
    openIssues: { type: 'array', items: { type: 'string' } },
    pendingIos: { type: 'boolean' },
  },
  required: ['taskId', 'status', 'summary', 'verification', 'openIssues'],
}

const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    blocking: { type: 'array', items: { type: 'string' } },
    nonBlocking: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'blocking', 'nonBlocking', 'evidence'],
}

const COMMIT = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    hash: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['committed', 'note'],
}

const COMMON = [
  'You are a senior engineer working unattended in the Streamarr monorepo at /Users/til/Development/streamarr (branch main).',
  'WORKING DIRECTORY: your shell may start in an unrelated directory (another git repo) and resets to it after every command. Start every shell command with "cd /Users/til/Development/streamarr && " (or use absolute paths / git -C /Users/til/Development/streamarr). Never run git, npm or dotnet outside /Users/til/Development/streamarr.',
  'SILENT TESTS (the user sits next to this Mac): start Android emulators with -no-audio (argent boot-device: never pass sound: true), start Chromium with --mute-audio in addition to --remote-debugging-port, and never change the Mac output volume or mute state.',
  'Two tracks run concurrently: backend (server/, web/ types, scripts/devworld.sh, docs/*.md) and client (client/). Stay inside your track unless your task explicitly requires otherwise, and never revert changes you did not make.',
  'Before anything else read: docs/client/PLAN.md (binding spec: sections 1-4 and your task in section 5), docs/client/JOURNAL.md, and of the dependency journals docs/client/journal/<id>.md only the Status, Summary, Decisions, Open issues and Notes for next tasks sections (skip their long evidence logs). PLAN.md section 3 (conventions) and section 4 (journal protocol) are mandatory.',
  'Hard rules:',
  '- Never use plan mode, EnterPlanMode, ExitPlanMode or AskUserQuestion. Decide, record the decision in your journal file, continue.',
  '- Do not git commit, push, stash, reset, checkout or clean. A separate checkpoint step commits.',
  '- Run "source docs/client/env.sh" in every shell (dotnet, JDK 17, Android SDK).',
  '- The machine has 8 GB RAM: at most one emulator/simulator, never two native builds at once. Only the client track may run an emulator. Before finishing, stop everything you started (emulators, Metro/Expo servers, Dev World instances, Chromium, Gradle daemons, VBCSCompiler/MSBuild servers). Processes you start must not outlive you.',
  '- Device testing uses Argent (Software Mansion): the argent MCP tools or the argent CLI. Read .claude/skills/argent-tv-interact (TV) or argent-device-interact (phone/tablet/web) before driving a device.',
  '- Only claim what you verified with real commands. Put evidence (commands, observed results, screenshot paths under docs/client/screenshots/<TASK-ID>/) in the journal.',
  '- Source code comments: at most one line each, only where needed.',
  '- Xcode is not installed (check "xcodebuild -version"). If it still fails, skip iOS/iPadOS/tvOS work that needs it, mark it pending-ios in the journal and continue. If Xcode IS installed, include iOS/tvOS verification (simulator runtimes may need "xcodebuild -downloadPlatform iOS|tvOS").',
  'Token economy (the previous run hit the plan usage limit; every tool result costs budget):',
  '- Judge UI state from element trees (describe, the tree returned by interaction tools) and batch device input: tv-remote with a button array, run-sequence for known step lists. Never poll with screenshots; use await-ui-element. Take a screenshot only as evidence of a key state (roughly 15 per task at most).',
  '- Reuse the running emulator, Metro and the installed dev build. Rebuild the native app only when native code, native dependencies or the app config changed; JS changes only need a Metro reload.',
  '- Do not re-read large files or logs you already read; grep for what you need and tail logs with a bounded line count.',
].join('\n')

const TASKS = {
  'M3.1': {
    title: 'Player spike: engines + media caps',
    track: 'Client',
    deps: ['M1.3', 'M1.4', 'M2.1', 'M2.2', 'M2.3'],
    maxFixes: 2,
    guide: [
      '- Priority: this is the most important task of the project. The user wants a flawless player with hardware decoding, especially on Android TV (and later Apple TV, where MPV-based players failed him).',
      '- Load skills first: expo-module (for client/modules/media-caps), expo-dev-client. Read the M1.3 and M1.4 journals (viewer playback API, remux playlists, device profile shape, reasons). The navigation shells (M2.4) do not exist yet: the spike is a standalone dev route.',
      '- Implement PLAN.md M3.1: one TypeScript engine interface; native engine candidates expo-video (SDK 57) and react-native-video (latest stable 6.x; note the 7.x beta status) both implemented behind it for the comparison; VLC engine via expo-libvlc-player; web engine with <video> + full hls.js (subtitles) and native HLS on Safari. Remote/media keys on TV (useTVEventHandler / hardware keys) mapped to engine commands.',
      '- media-caps Expo module (Kotlin + Swift + web): Android MediaCodecList (HW vs SW decoders per codec/profile/max size), Display HDR capabilities, AudioManager passthrough encodings; Apple VideoToolbox HW decode, AVPlayer HDR/DV support, audio route channels; web MediaCapabilities/canPlayType. Output the DeviceProfile shape the M1.3 API expects.',
      '- /dev/player route: lists Dev World variants, starts each through the viewer playback API (sign in as a seeded viewer with the M2.3 account store) with the real device profile, plays with the selected engine and shows a metrics overlay (time to first frame, seek latency, buffering events, dropped frames where observable, decoder in use, track switching, key events).',
      '- Measure on the Google TV emulator, the Android phone emulator and web (Chromium; also note Safari-only paths). Emulators use software/goldfish codecs: record what that means for the numbers and which conclusions still hold. iOS/tvOS pending-ios.',
      '- Write a comparison table (per engine x target x variant: works?, TTFF, seek, tracks, subtitles, HDR signalling, notes) and the engine decision with reasons into the journal. Keep the losing native engine out of the app afterwards (remove its dependency) unless there is a measured reason to keep both.',
      '- Record every backend problem you hit or worked around in the journal under "Backend issues" (the backend follow-up task M1.5 starts from that list).',
    ].join('\n'),
    acceptance: [
      'media-caps returns a plausible DeviceProfile on Google TV, Android phone and web (matches the device, HW vs SW decoders distinguished)',
      '/dev/player starts every Dev World variant through the viewer playback API and plays it, or fails over exactly as the server decision says',
      'audio and subtitle switching work on the chosen native engine and on VLC',
      'TV remote keys (OK/playPause, left/right seek, media keys, back) reach the engine on Google TV',
      'the comparison table exists; spot-check two of its numbers by re-measuring',
      'the engine decision follows from the evidence and the losing engine dependency is removed',
      'typecheck, lint and tests green',
    ],
  },
  'M2.4': {
    title: 'Navigation shells',
    track: 'Client',
    deps: ['M2.1', 'M2.2', 'M2.3', 'M3.1'],
    maxFixes: 1,
    guide: [
      '- Load skills first: expo-router (NativeTabs, stacks, headers, modals), expo-native-ui (Liquid Glass, iPad sidebar), expo-animation.',
      '- Implement PLAN.md M2.4: route groups (onboarding) and (app) with auth redirects based on the M2.3 account store; Home, Search, Profile/Settings tabs; stacks for movie/[id], series/[id], series/[id]/season/[n], play/[playbackId] with placeholder content that already uses the design system (skeleton layouts, not lorem text). Keep the M3.1 /dev/player route reachable.',
      '- Per target: iPhone/iPad NativeTabs (Liquid Glass on iOS 26+, sidebar-adaptable on iPad); Android TV a collapsible left rail (collapsed icons, expands on focus, remembers the last focused tab, D-pad left from content opens it, right returns to the remembered content item); tvOS the native top tab bar; web a responsive sidebar/top bar with keyboard navigation; Android phone bottom tabs.',
      '- Back behaviour: Android TV back closes rail -> pops stack -> returns to Home -> exits (confirm or double-press); focus is restored to the element that opened a pushed screen. Web browser Back (carried over from M2.3). Deep links (streamarr://movie/123) work.',
      '- Settings screen: account (switch, sign out), language override, app/about info with server version.',
      '- Verify on Google TV (D-pad: rail open/close, tab switch, push/pop with focus restoration, back chain), Android phone, and web at desktop and a 1024x1366 iPad-sized viewport. iOS/tvOS pending-ios.',
    ].join('\n'),
    acceptance: [
      'Google TV: rail opens on D-pad left and closes on right back to the remembered item; the last focused tab is remembered',
      'Google TV: push a detail placeholder and back restores focus to the opener; full back chain ends in the exit confirmation',
      'Android phone bottom tabs and back work',
      'web desktop and 1024x1366: sidebar/top bar usable with the keyboard, browser Back works',
      'signed out -> onboarding redirect; deep link streamarr://movie/123 opens the movie route',
      'settings: switch account, sign out and language override work',
      'no hardcoded strings; typecheck, lint and tests green',
    ],
  },
  'M1.5': {
    title: 'Backend follow-ups for the client',
    track: 'Backend',
    deps: ['M1.1', 'M1.2', 'M1.3', 'M1.4', 'M3.1'],
    maxFixes: 1,
    guide: [
      '- This task has no section in PLAN.md; this guidance is its spec. Collect every open backend item: "Open issues", verifier non-blocking findings and "Notes for next tasks" in journal/M1.1-M1.4, plus every backend problem the client tasks recorded (journal/M2.3 and above all journal/M3.1 "Backend issues"; search them for server, API, backend, playback API, contract).',
      '- Triage each item into fix / defer (with reason) and record the table in docs/client/journal/M1.5.md. Fix everything that affects correctness, security, what the client can show the viewer (e.g. a TMDB outage must surface as a retryable upstream error, not as not-found or an empty list), contract accuracy (OpenAPI status codes and shapes match the real responses, e.g. the .vtt subtitle route error codes), and everything the player spike needed but worked around. Defer pure polish.',
      '- Every fix gets a regression test that fails before the fix. Contract: server/scripts/freeze-openapi.sh (with UseSharedCompilation=false DOTNET_CLI_USE_MSBUILD_SERVER=0), web generate:api + tsc + tests, client gen:api + typecheck. Docs updated (docs/api.md, docs/viewers.md, docs/setup.md), full server suite green, server/tests/Streamarr.DevWorld/tools/e2e_playback.py still green against your tree on port 39310, then scripts/devworld.sh publish.',
      '- You run in parallel with client tasks that use the Google TV emulator: never start an emulator, and do not touch client/ except for regenerated API types.',
    ].join('\n'),
    acceptance: [
      'the triage table exists and every M3.1 backend issue is either fixed or deferred with a sound reason',
      'for three fixed items: the regression test fails on the previous commit (use "git worktree add /tmp/m15-base HEAD", remove it afterwards) and passes now',
      'OpenAPI matches real responses for the changed endpoints; web and client typecheck green',
      'full server suite and e2e_playback.py green; Dev World republished',
    ],
  },
  'M4.1': {
    title: 'Browse: home, search, details, versions',
    track: 'Client',
    deps: ['M1.2', 'M1.3', 'M2.2', 'M2.3', 'M2.4', 'M3.1'],
    maxFixes: 1,
    guide: [
      '- Load skills first: expo-router, expo-native-ui, expo-data-fetching, expo-animation, expo-design-system. Read the M1.2 journal (catalog endpoints, VersionDto, predictedMethod, age gate), the M3.1 journal (media-caps device profile, engine decision) and the "Notes for next tasks" of M2.2-M2.4.',
      '- Implement PLAN.md M4.1 in the M2.4 shells, per form factor: Home (hero from discover with backdrop + logo that follows the focused item on TV, continue watching with progress bars, next up, discover rows), Search (debounced, movie/series/any filter, recent searches per account in MMKV, TV-friendly input), Movie detail (backdrop, logo, metadata, certification, play/resume button with the resume position, versions entry), Series detail (season picker, episode list with played state and progress, next-episode call to action), mark played/unplayed, Version picker (sheet on phones, panel/dialog on TV and iPad/web; cards with resolution, HDR, codecs, audio, languages, size, bitrate, health, local-ready, recommended and the predicted method for this device from the M3.1 media-caps profile).',
      '- Play buttons navigate to the play route with workId, releaseId and start position and start playback through the M3.1 engine path (the full start flow and overlay come in M4.2, which only replaces that screen).',
      '- Every screen has skeletons, empty and error states (network, age_restricted, TMDB/upstream errors) with retry. Images via expo-image with placeholders. Lists virtualized where long.',
      '- TV: 10-foot layout, strong focus, row memory, the hero reacts to focus, no focus traps, back returns focus to the opener. iPad/web desktop: multi-column layouts. Phone: compact.',
      '- Verify against the published Dev World on 39300 as anna and kind: Google TV, Android phone, web desktop and a 1024x1366 viewport. German and English.',
    ].join('\n'),
    acceptance: [
      'Google TV: D-pad through home rows with row memory, the hero follows focus, no focus trap',
      'search with the TV keyboard and on web finds a movie and a series; recent searches are kept per account',
      'movie and series detail with season switch, episode progress and mark played/unplayed (watch state matches the server via curl)',
      'version picker shows the version attributes and the predicted method; play navigates to the play route and starts playback',
      'kind: hidden titles and a proper age_restricted message; stopping the Dev World shows an error state with a working retry',
      'phone and web (desktop + 1024x1366) layouts usable; German and English complete; typecheck, lint and tests green',
    ],
  },
  'M4.2': {
    title: 'Playback: start flow, player overlay, progress',
    track: 'Client',
    deps: ['M1.3', 'M1.5', 'M3.1', 'M4.1'],
    maxFixes: 2,
    guide: [
      '- Load skills first: expo-animation, expo-native-ui, expo-router. Read the M3.1 journal (engine decision, engine interface, media-caps, measured behaviour), the M1.3 and M1.5 journals (playback API, reasons, suggestedActions, switch/stepDown, heartbeat) and the M4.1 notes.',
      '- Implement PLAN.md M4.2 completely. Start flow: a visible stepper (resolving, fallback with the attempts, repairing with progress/eta, planning, starting) that explains what happens and why (decision.reasons localized from their codes + params); resume vs from-start choice; failures show the localized error with the suggestedActions as buttons.',
      '- Player overlay (our own, identical on every engine): title/episode, progress with buffered range, play/pause, seek, panels for audio, subtitles, version, quality, engine and an info panel with the technical details (method, engine, codecs, HDR, bitrate, decoder, dropped frames where observable). TV remote map exactly as PLAN.md M4.2 (OK/playPause, left/right -10 s/+30 s with accelerating hold-scrub, rewind/fastForward keys, up panels, down progress, back closes overlay then exits), overlay auto-hide, focus never lost. Mobile gestures (tap toggle, double-tap seek, scrub, pinch-to-fill), landscape lock on phones, PiP/AirPlay where the engine supports it. Web: keyboard shortcuts (space, arrows, f, m) and fullscreen.',
      '- Up-next card with countdown and autoplay for series. Progress reporting: start, every 10 s, pause, background, stop; an offline queue with retry; heartbeat keeps the playback alive. Automatic step-down to the next method via switch with stepDown on a playback error, with a visible notice.',
      '- Verify against the published Dev World on 39300: on Google TV play several variants (direct, remux, transcode, VLC fallback), the dead release (fallback visible in the stepper), gast (transcode blocked message, second stream 409 naming the device), audio/subtitle switching, every remote key, quit mid-way then relaunch and continue watching resumes at the position, finish an episode and autoplay the next. Repeat the core of it on the Android phone and web. Screenshots of the key states.',
    ].join('\n'),
    acceptance: [
      'stepper shows the real states incl. the dead-release fallback; errors show working suggested actions (gast transcode blocked, second stream 409 naming the device)',
      'Google TV: every remote key incl. media keys and hold-scrub, panels, auto-hide, back closes the overlay then exits, focus never lost',
      'audio, subtitle, version and quality switching mid-play; step-down on a forced playback error with a visible notice',
      'progress reaches the server (curl watch state); quit mid-play, relaunch, continue watching resumes at the right position (burned-in timecode proves it)',
      'up-next countdown and autoplay of the next episode',
      'core of the above on the Android phone and web (keyboard shortcuts, fullscreen); i18n complete; typecheck, lint and tests green',
    ],
  },
  'P1': {
    title: 'Player polish',
    track: 'Client',
    deps: ['M3.1', 'M4.2'],
    maxFixes: 1,
    guide: [
      '- This task is part of the polishing round (PLAN.md section 5, "P"). Its spec is this guidance plus the "Player polish" items of docs/client/BACKLOG.md. Read journal/M4.2.md (Status, Fix round 1 and part 2, Verification round 2, Open issues) first.',
      '- Paused step-down to VLC: after a step-down or engine switch while paused, the picture must show the current position immediately (not frame 0 / stale for ~13 s) and keep showing it after play. Extend the VLC stall handling if needed so it also covers the first seconds after a resume.',
      '- End of playback: when an up-next countdown is cancelled (or there is no next episode), the episode must not end on a frozen frame without controls. Show an end card with Replay, Back to details and, when one exists, the next episode; the overlay stays usable by D-pad, touch and keyboard.',
      '- Back from the player returns focus to the element that started playback (version card, episode row, hero Play/Resume or Continue watching card) on TV; on web and phone the scroll position of the opener is kept.',
      '- Android phone picture-in-picture for expo-video (not on TV): enter PiP when the user leaves the app during playback and via a PiP button in the overlay; controls hidden in PiP; playback and progress reporting continue; returning restores the overlay. Requires a native rebuild of the phone APK.',
      '- In the same native rebuild: release libVLC Media objects properly in the expo-libvlc-player patch ("VLCObject (Media) finalized but not natively released"), and make the player-keys module re-register its key callback after a JS reload (dev) so the remote works without a cold start.',
      '- Optional if cheap: the Up/Right same-frame race from the seek bar.',
      '- Leave the visual style of the overlay as it is (a redesign follows in later tasks); only add the controls this task needs using the existing components.',
    ].join('\n'),
    acceptance: [
      'Google TV: paused step-down to VLC shows the current position immediately and after play (burned-in timecode proves it)',
      'Google TV and phone: cancelling up-next or finishing the last episode shows the end card; Replay and Back to details work by D-pad and touch',
      'Google TV: Back from the player focuses the opener (checked for a version card, an episode row and a Continue watching card)',
      'Android phone: PiP on leaving the app and via the button; playback and progress continue in PiP (server watch state via curl); returning restores the player',
      'no "finalized but not natively released" log after five VLC playbacks; the remote works after a JS reload without a cold start',
      'typecheck, lint and tests green; new unit tests for the end-card state and focus restore logic',
    ],
  },
  'P2': {
    title: 'Browse, navigation and accounts polish',
    track: 'Client',
    deps: ['M2.3', 'M2.4', 'M4.1', 'P1'],
    maxFixes: 1,
    guide: [
      '- This task is part of the polishing round (PLAN.md section 5, "P"). Its spec is this guidance plus the "Browse and UX polish", "Accounts" and "Tests and tooling" items of docs/client/BACKLOG.md (not the pending-ios or hardware ones). Read the M4.1 and M2.3/M2.4 journals (Open issues) first.',
      '- Series "mark watched" toast names the series. A hanging server shows a timeout error with Retry within about 20 s (GET timeout and retry budget; mutations are not retried). Titles without versions show a clear "no versions yet" state instead of a Play button that fails. Fully watched movies and series offer "Watch again" from the start.',
      '- Freshness: watch state, continue watching and next up refetch when a screen regains focus, when the app returns to the foreground and after leaving the player, so a change on another device shows up without waiting a minute.',
      '- TV hero: the eyebrow label and episode title always match the focused card (no stale "Continue watching", no missing episode title). German UI shows localized season names ("Staffel 1") when the server name is the generic "Season N".',
      '- Search type filter resets on a profile switch. Version cards: plain-language wording for viewers (no "container assumed (mkv)" next to "mkv not supported"); the technical details stay available in an expandable details area.',
      '- TV navigation: the rail opens on the active tab; D-pad presses in the first seconds after Home renders never land in half-loaded content.',
      '- Web: a page title per route (title of the movie/series on detail pages), no duplicate history entries, Back after sign-in never returns to /server or /sign-in.',
      '- Accounts: signing in again to the same server and user updates the existing profile tile instead of adding a duplicate (dedupe by server + viewer id, migrate existing duplicates).',
      '- Tests: screen-level tests (jest + testing library) for home, search, movie/series detail and the version picker, covering loading, empty, error and the main interaction.',
      '- User decisions (see docs/client/runs/driver/P3-decisions.md): (1) the version marked Recommended and a plain Play are the best version that plays without transcoding on this device (server side in P3; apply any client change P3 lists under "Notes for next tasks" in journal/P3.md). (2) The web client is served by the Streamarr server under /watch: set experiments.baseUrl from the EXPO_BASE_URL env var in client/app.config.ts, and on web default the server URL to the page origin (skip the server step when the origin is a Streamarr server). Verify with an export served by the server if P3 is committed, otherwise with a local static server under /watch.',
      '- Leave the visual style as it is (a redesign follows in later tasks); only add what these items need using the existing components.',
    ].join('\n'),
    acceptance: [
      'web export under /watch works (deep links, reload, assets) and connects to the page origin without the server step; Play and the Recommended badge agree',
      'toast, timeout (error within ~20 s with a working Retry), no-versions state and Watch again verified on web and Google TV',
      'a watch-state change made with curl appears on Home and detail after focus regain / foreground / player exit without waiting a minute',
      'TV hero label and episode title correct for continue watching, next up and discover rows; German season names localized',
      'search filter reset, version card wording, rail opens on the active tab, no early D-pad presses into loading content (Google TV)',
      'web: per-route titles, no duplicate history entries, Back after sign-in stays in the app; profile tiles deduplicated after a Dev World restart',
      'screen-level tests exist and pass; typecheck, lint and tests green',
    ],
  },
  'P3': {
    title: 'Backend polish',
    track: 'Backend',
    deps: ['M1.2', 'M1.3', 'M1.5'],
    maxFixes: 1,
    guide: [
      '- This task is part of the polishing round (PLAN.md section 5, "P"). Its spec is this guidance, the "Server" items of docs/client/BACKLOG.md and the deferred rows of the triage table in journal/M1.5.md. Read journal/M1.5.md first.',
      '- Continue watching and played items: an item that crossed the played threshold must not appear in continue watching with a stale position (the client showed "1 min left" and started at 0). Follow docs/viewers.md watch rules; next up for series moves on to the next episode.',
      '- The double probe on playback start (#27 in the M1.5 triage): probe once and reuse the result; measure the start latency before and after in the Dev World.',
      '- Multi-rendition audio in HLS (#4): stretch goal. Only if the rest is done and it fits: expose all audio tracks as HLS renditions for remux so the client can switch audio without a server switch; otherwise record a design note for later.',
      '- ORCHESTRATOR DECISIONS: see docs/client/runs/driver/P3-decisions.md if it exists (user answers on the device-aware "Recommended" ranking and on serving the web client); implement what it says, otherwise skip those two items.',
      '- You run in parallel with client tasks that use the emulators: never start an emulator, and do not touch client/ except for regenerated API types (client gen:api + typecheck). Test your own tree on Dev World port 39310, republish 39300 at the end without disturbing a running client session more than necessary (tell the orchestrator in your result when you republished).',
    ].join('\n'),
    acceptance: [
      'played items leave continue watching and next up advances; a regression test fails on the previous commit and passes now',
      'one probe per playback start; start latency before/after recorded',
      'decisions from P3-decisions.md implemented with tests and docs, or explicitly skipped if the file does not exist',
      'OpenAPI frozen and matching real responses; web and client typecheck green; full server suite and e2e_playback.py green; Dev World republished',
    ],
  },
  'D1': {
    title: 'Visual identity: three design directions',
    track: 'Design',
    deps: ['M4.1', 'M4.2'],
    maxFixes: 0,
    guide: [
      '- Docs only: do not change app code. Deliverables in docs/client/design/: directions.html (self-contained: inline CSS, fonts from Google Fonts CDN are fine, images embedded as base64 JPEG downscaled to <= 120 KB each), PNG renders of every mockup (headless Chromium from ~/Library/Caches/ms-playwright, always with --mute-audio), and README.md with the token table of each direction.',
      '- Load the expo-design-system skill first (in particular its guidance on apps that look generic or AI-generated) and expo-native-ui. Look at the current app in docs/client/screenshots/M4.1 and M4.2 (TV home, web home, detail, version picker, player) so you know what the user calls "very plain and boring, no visual identity" and why "web and TV diverge too much".',
      '- Use real Dev World artwork: posterUrl/backdropUrl/logoUrl in server/tests/Streamarr.DevWorld/fixtures/catalog.json (Sprite Fright, Sintel, Cosmos Laundromat, Tears of Steel, Agent 327, Big Buck Bunny, Sherlock). Download and embed them.',
      '- Three directions, each a complete, opinionated identity (not three colour swaps): (A) "Projector" - cinematic and warm: warm ink black, projector amber as the signature colour, a characterful display serif for titles and section heads with a clean sans for UI, letterboxed hero, subtle film grain and light bloom behind focus. (B) "Signal" - bold broadcast / technical, fitting Streamarr showing the stream internals Jellyfin hid: near-black with one electric signature colour, a strong grotesk display face, a monospace face for technical metadata (method, codecs, bitrate as spec labels), stream health as signal bars, sharp geometry and hairlines. (C) "Aurora" - ambient and artwork-driven: the backdrop and accents tint from the focused title\'s dominant colour, big blurred backdrops that crossfade with focus, soft glass surfaces (matches Liquid Glass on iOS later), rounded geometric sans, generous space. You may refine names, fonts and colours, but keep the three clearly distinct. All dark; fonts must be open licensed (Google Fonts) so the app can bundle them with expo-font.',
      '- For each direction mock: (1) the ONE large-screen home used by both TV and web desktop (1920x1080; show the TV focus state on a card and, in a small inset, the same screen with a web hover state and pointer - identical layout, only the input affordance differs); (2) the movie or series detail with the version panel open, showing version attributes, health and the predicted playback method; (3) the player overlay with the info panel; (4) the phone detail screen (390x844). Plus a brand block: wordmark, app icon, colour tokens, type ramp, focus/hover/press states, motion notes.',
      '- Add a section "One large-screen shell" (shared by all directions): what TV, web desktop and tablet share (navigation rail with the brand mark and profile, hero behaviour, row and card sizes, section headers, detail layout, version panel, player overlay, motion) and the few things that differ by input (D-pad focus vs pointer hover, row scroll arrows on web, keyboard shortcuts). Compare with the current divergence in two sentences.',
      '- Note per direction what the implementation needs (e.g. Aurora needs the dominant colour per title: server-side palette extraction added to the catalog DTOs vs a client library; fonts to bundle; grain as a tiled image) and a rough effort (S/M/L).',
      '- Keep the HTML well under 1.5 MB. Verify every PNG by looking at it.',
    ].join('\n'),
    acceptance: [
      'directions.html renders standalone with all images and fonts; three clearly distinct directions, each with the four mockups and the brand block',
      'the shared large-screen shell section exists and is concrete',
      'PNG renders exist for every mockup; README.md lists tokens and implementation notes per direction',
    ],
  },
  'R0': {
    title: 'Redesign backend: per-title tint and spec summary',
    track: 'Backend',
    deps: ['P3'],
    maxFixes: 1,
    guide: [
      '- Part of the redesign (PLAN.md section 5, "R — decision"): direction Aurora with Signal spec labels. Read docs/client/design/README.md (Aurora and Signal implementation notes) first.',
      '- Per-title palette: extract two swatches from the title artwork (backdrop first, poster as fallback) when the artwork is fetched: tint (vivid accent) and tint2 (deep shade). Deterministic, cached per image URL (DB or disk), computed off the request path; return null until computed. Adjust tint lightness so it reaches at least 3:1 contrast against #0A0C12 and tint2 so white text reaches 4.5:1 on it. Prefer an MIT-licensed image library (e.g. SkiaSharp) and add it to NOTICE.',
      '- Expose tint and tint2 (hex strings, nullable) on every catalog item the client lists or opens: home rows, continue watching, next up, search results, movie/series/episode detail. Episodes inherit the series tint.',
      '- Spec summary for cards: on list items, a small nullable object with the best available version (by qualityRank): resolution label (e.g. 4K, 1080p), hdr (e.g. DV, HDR10, HLG or null), videoCodec (e.g. HEVC, AV1, H.264), audio (e.g. Atmos, 5.1, 2.0). Device-independent: it describes what exists, the version picker stays device-aware.',
      '- Dev World: make sure its artwork yields real palettes (the fixtures reference TMDB images); record the tints of the D1 mockup titles (Sprite Fright, Big Buck Bunny, Cosmos Laundromat) and compare with docs/client/design/README.md.',
      '- You run in parallel with client tasks that use the emulators: never start an emulator, do not touch client/ except regenerated API types (client gen:api + typecheck). Test your tree on Dev World port 39310; republish 39300 only at the very end and say so in your result.',
    ].join('\n'),
    acceptance: [
      'tint/tint2 on all listed catalog payloads, cached and computed off the request path, with contrast rules and unit tests',
      'spec summary on list items with unit tests; values checked live against the Dev World versions',
      'OpenAPI frozen and matching real responses; web and client typecheck green; full server suite and e2e_playback.py green; Dev World republished',
    ],
  },
  'R1': {
    title: 'Redesign foundation: Aurora tokens, fonts, Glass, ambient, spec labels',
    track: 'Client',
    deps: ['P2', 'R0'],
    maxFixes: 2,
    guide: [
      '- Part of the redesign (PLAN.md section 5, "R — decision"; read it fully, especially the Glass rule). Direction Aurora (docs/client/design/README.md tokens, jpg/C-*.jpg mockups) plus Signal spec labels (jpg/B-*.jpg). Load the expo-design-system, expo-native-ui (references/visual-effects.md) and expo-animation skills first.',
      '- Tokens: replace the current palette and type ramp with Aurora (colours, radius, spacing, type per form factor, motion springs); keep the token architecture (theme/, NativeWind config) so screens keep compiling. Remove the old violet accent everywhere. Dark only.',
      '- Fonts: bundle Outfit, Figtree and JetBrains Mono (expo-font, @expo-google-fonts or local OFL files, Latin subset); the same files on web. Font loading must not flash system fonts on TV (splash until loaded).',
      '- Glass: one Glass component (surface) and GlassButton/GlassChip (controls) with platform files exactly as the Glass rule in PLAN.md says: iOS 26 real Liquid Glass (expo-glass-effect GlassView/GlassContainer; @expo/ui GlassEffectContainer only for morphing), iOS < 26 expo-blur, Reduce Transparency solid, web backdrop-filter, Android translucent, Android TV solid. Unit-test the selection logic (availability, reduce transparency, platform). No screen may branch on platform for glass.',
      '- Ambient backdrop: full-screen blurred artwork of the focused (TV) or hovered/active (web, phone) title with tint/tint2 washes, crossfade ~700 ms debounced ~150 ms via Reanimated; small TMDB image sizes; expo-image blurRadius on native, CSS filter on web; reduced motion = crossfade only. Falls back to a neutral wash when tint is null.',
      '- Focus/hover/press: TV focus spring (scale ~1.10, white ring, tint glow), web hover (scale ~1.04, 2 px ring) and visible keyboard focus, press feedback; one hook or wrapper used by cards and buttons.',
      '- Spec labels: SpecLabel (JetBrains Mono caps chips for resolution, HDR, codec, audio, playback method with ok/warn/bad colours) and SignalBars (health/local state), fed by the R0 spec summary and the version data.','- Server facts from R0 (see docs/client/journal/R0.md): tint and tint2 are null on a title\'s first listing and arrive on later requests; spec is null until someone has opened that title\'s versions. So: a neutral Aurora fallback tint when tint is null, a crossfade (not a jump) when the colours arrive on a refetch, and cards/hero render no spec chips at all (no empty or placeholder chips) when spec is null.',
      '- Brand: wordmark and app mark in Aurora style (from the C brand board), app icon, Android adaptive icon, splash, Android TV banner and the Apple TV assets in app.config; web favicon and theme colour.',
      '- iOS native chrome: NativeTabs minimizeBehavior="onScrollDown" and tint for Liquid Glass; transparent native headers where screens show artwork (typecheck only this round).',
      '- A dev-only gallery route that shows every primitive (tokens, type, Glass variants, buttons, chips, spec labels, signal bars, focus/hover states, ambient) for verification on TV, phone and web.',
      '- Existing screens must keep working with the new tokens (no visual redesign of screens yet; that is R2/R3), with no regressions in tests.',
    ].join('\n'),
    acceptance: [
      'Aurora tokens, fonts and motion in place, old accent gone; existing screens render without regressions on Google TV, phone and web',
      'Glass with platform files per the Glass rule; iOS uses expo-glass-effect / native chrome (code present, typechecked, selection logic unit-tested; visual check pending-ios)',
      'ambient backdrop, focus/hover/press, SpecLabel and SignalBars work in the gallery on Google TV, phone and web (screenshots)',
      'new brand assets (icon, adaptive icon, splash, TV banner, favicon) visible on devices; typecheck, lint and tests green',
    ],
  },
  'R2': {
    title: 'Redesign: one large-screen shell (TV, web desktop, tablet)',
    track: 'Client',
    deps: ['R1'],
    maxFixes: 2,
    guide: [
      '- Part of the redesign (PLAN.md section 5, "R — decision"). Build the ONE large-screen shell from docs/client/design/directions.html (section "One large-screen shell") and the Aurora mockups jpg/C-home.jpg, jpg/C-home-web.jpg, with Signal spec labels on cards (jpg/B-home.jpg).',
      '- TV, web desktop and tablet render the same layout at 1920x1080 logical points: a glass navigation rail with the brand mark and the active profile, a hero that follows the focused (TV) or hovered (web) title with the ambient backdrop, rows of landscape and poster cards in the mockup sizes and gaps, section headers. Remove the web sidebar, greeting bar, fixed top-pick hero and the tablet top bar.',
      '- Input is the only difference: D-pad focus with focus memory and the existing back chain on TV; pointer hover, row scroll arrows, keyboard shortcuts and visible keyboard focus on web. Keep every behaviour P2 and M2.4 verified (focus return, row memory, exit dialog, deep links, page titles).',
      '- Apply the shell to home, search, settings, the profile picker ("Who is watching") and sign-in/server screens.',
      '- Phone: compact variant of the same components (iOS NativeTabs Liquid Glass tab bar, Android bottom bar restyled), stacked hero, same cards and spec labels.',
      '- Compare TV and web desktop side by side at 1920x1080 and fix differences that are not input-related.',
    ].join('\n'),
    acceptance: [
      'TV (Google TV emulator) and web desktop at 1920x1080 show the same layout for home and search; side-by-side screenshots in the journal',
      'rail, hero with ambient backdrop, rows and cards with spec labels match the Aurora mockups; focus (TV) and hover (web) states as specified',
      'profile picker, sign-in, search and settings use the shell; tablet size (1024x1366 web) and phone compact variant work',
      'no regressions in the verified behaviours (focus memory, back chain, row memory, deep links, page titles); typecheck, lint and tests green',
    ],
  },
  'R3': {
    title: 'Redesign: detail, version panel, player, phone',
    track: 'Client',
    deps: ['R2'],
    maxFixes: 2,
    guide: [
      '- Part of the redesign (PLAN.md section 5, "R — decision"). Mockups: jpg/C-detail.jpg, jpg/C-player.jpg, jpg/C-phone.jpg (Aurora) and the Signal spec labels from jpg/B-detail.jpg and jpg/B-player.jpg.',
      '- Detail (movie and series) on the large-screen shell: logo, facts, synopsis, spec labels, resume bar, seasons and episodes, ambient backdrop and tint; glass version panel on the right (mockup width) with version cards showing spec labels, signal-bar health, local-ready, the device-aware Recommended and the predicted method with its reason in plain words.',
      '- Player overlay: glass control bar and right side panels (audio, subtitles, quality, version, engine, info) in Aurora style; the info panel uses spec labels; on iOS the controls are real Liquid Glass (GlassView isInteractive in a GlassContainer, or @expo/ui GlassEffectContainer for the morphing cluster) per the Glass rule; start stepper, error states, end card and up-next restyled. Keep every verified player behaviour (remote key map, back chain, focus return, PiP).',
      '- Phone: compact detail (hero, spec labels, episodes) and the version picker as a sheet (iOS: native formSheet with transparent content for Liquid Glass; Android: the existing sheet restyled); phone player overlay restyled.',
    ].join('\n'),
    acceptance: [
      'detail and version panel match the Aurora mockups with Signal spec labels on Google TV and web desktop; phone compact detail and version sheet work',
      'player overlay, side panels, info panel, stepper, errors, end card and up-next restyled on Google TV, phone and web',
      'iOS glass paths per the Glass rule present and typechecked (pending-ios for visual checks)',
      'no regressions in the verified browse and player behaviours; typecheck, lint and tests green',
    ],
  },
  'B1': {
    title: 'Server: catalog browse for Movies/Series pages and small viewer fixes',
    track: 'Backend',
    deps: ['R0'],
    maxFixes: 1,
    guide: [
      '- Part of the F round (PLAN.md section 5, "F — follow-up round"). The client adds Movies and Series pages to the rail (task F2); they need a paged browse endpoint.',
      '- GET /api/v1/viewer/catalog/browse?type=movie|series&genre=<tmdb genre id, optional>&sort=popular|top_rated|newest&page=<1-based>: TMDB discover (discover/movie, discover/tv) mapped to the existing catalog item DTO including tint/tint2 and spec, filtered by the viewer age gate exactly like discover/search, with paging info (page, totalPages or hasMore). Cache per (type, genre, sort, page) like the discover rows. Validate every parameter with the existing ViewerProblem codes.',
      '- GET /api/v1/viewer/catalog/genres?type=movie|series: TMDB genre list (id + name), cached for hours.',
      '- Dev World: its fake TMDB must answer discover/movie, discover/tv and genre/movie|tv/list from the fixtures (genres already exist per title), honour genre and sort, and page with a small page size so paging is testable with 11 titles.',
      '- title_not_found playback failures must not offer the otherVersion action (the client shows "Choose another version" for a title that does not exist). Check the other failure codes for actions that cannot work.',
      '- Method prediction on the versions endpoint: the Big Buck Bunny WEB-DL is predicted as an MKV remux while playback delivers the MP4 file directly. Find where the container is assumed (release name without a container hint defaults to mkv?) and use the real container once known (probe/file extension), so the version card and playback agree. Unit test it.',
      '- You run in parallel with client task F1, which uses the emulators and Dev World 39300: never start an emulator, do not touch client/ except regenerated API types (client gen:api + typecheck, once at the end). Test your tree on Dev World port 39310; do NOT republish or restart 39300 (the orchestrator does it after your verify).',
    ].join('\n'),
    acceptance: [
      'browse and genres endpoints with validation, age gate, tint/spec, caching and paging; unit and API tests; Dev World fake supports them',
      'title_not_found without otherVersion; predicted method uses the real container (BBB WEB-DL agrees with playback); tests',
      'OpenAPI frozen and matching real responses; web and client types regenerated and typecheck green; full server suite and e2e_playback.py green',
    ],
  },
  'F1': {
    title: 'Client fixes: mockup details, open findings, backlog triage',
    track: 'Client',
    deps: ['R3'],
    maxFixes: 2,
    guide: [
      '- Part of the F round (PLAN.md section 5, "F — follow-up round"). Read docs/client/runs/driver/F1-notes.md first: it lists every item with the screenshot or finding it comes from.',
      '- Visual items first (they are what the user saw): full-bleed artwork/ambient behind the rail on every shell screen, translucent tinted glass on Android TV instead of opaque grey, one tinted focus ring that is never clipped, then a mockup comparison of every large-screen screen against docs/client/design/jpg/C-*.jpg.',
      '- Then the R3/R2/R1 verify leftovers listed in the notes, then a backlog triage: every item in docs/client/BACKLOG.md is either marked fixed (with the task that fixed it), fixed now if small, or kept with a one-line reason.',
      '- Do not add the Movies/Series rail entries or pages (task F2 does that after the server task B1).',
    ].join('\n'),
    acceptance: [
      'artwork and ambient full-bleed behind the rail; Android TV glass translucent and legible; single untruncated focus ring; large-screen screens match the C mockups except the recorded intentional differences (TV and web screenshots, before/after)',
      'R3 verify findings 1-5, 7, 9-12 and the listed R1/R2 leftovers fixed and shown on their target',
      'BACKLOG.md triaged and truthful; typecheck, lint and tests green; no regressions in the verified browse and player behaviours',
    ],
  },
  'F2': {
    title: 'Client library: Movies and Series pages and rail entries',
    track: 'Client',
    deps: ['F1', 'B1'],
    maxFixes: 2,
    guide: [
      '- Part of the F round (PLAN.md section 5, "F — follow-up round"). Uses the B1 endpoints (catalog/browse and catalog/genres; regenerate nothing, the types are in client/src/api/schema.d.ts after B1).',
      '- Rail (large shell): Home, Search, Movies, Series in the mockup order (docs/client/design/jpg/C-detail.jpg shows film and TV icons), Settings and the profile at the bottom; labels on focus/hover as today. Phone: the bottom bar gets Movies and Series too (Android bar and iOS NativeTabs code), five entries.',
      '- Movies and Series pages on the large shell: page title, genre chips (All + genres), a sort switch (Popular, Top rated, Newest), a poster grid with the Home card sizes, captions and spec chips, paging on scroll, skeletons, empty and error states with retry. The ambient follows the focused/hovered card like Home. TV: rail -> chips -> grid focus flow, Back returns to the rail, focus memory per page; web: keyboard and hover, URL keeps genre and sort (/movies?genre=16&sort=top_rated) so reload and Back restore them; phone: the same page as a compact grid.',
      '- Page titles, deep links (streamarr://movies, /series), i18n de/en, screen tests for loading/empty/error/paging.',
    ].join('\n'),
    acceptance: [
      'Movies and Series in the rail and the phone bar; pages with genres, sort, paging, empty/error states on Google TV, web desktop and phone',
      'TV focus flow, web keyboard/hover and URL state, deep links and page titles work; screen tests cover the states',
      'no regressions in the verified browse and player behaviours; typecheck, lint and tests green',
    ],
  },
  'B2': {
    title: 'Server: viewer language, spec warm-up, VLC caps, persistent container store, cleanup',
    track: 'Backend',
    deps: ['B1'],
    maxFixes: 2,
    guide: [
      '- Part of round G (PLAN.md section 5, "G — second follow-up round"; decisions in section 2). Runs in parallel with client task F3, which uses the emulators and Dev World 39300.',
      '- Viewer language: every viewer catalog/watch endpoint honours the Accept-Language request header (primary tag, e.g. de, en; unknown or missing -> the server default). TMDB requests use that language for overviews, titles, taglines, season/episode names and genre names; caches are keyed per language; when TMDB returns an empty localized overview or name, fall back to the English text. Responses carry Vary: Accept-Language. Dev World: the fake TMDB answers the language parameter with German texts for a few fixture titles and German genre names (enough to see it work) and falls back to English otherwise. Contract note in docs/api.md.',
      '- Spec warm-up: cards should carry the spec summary without anyone opening the title first. A background service looks up versions (the existing indexer search + ranking path, never on the request path) for titles that appear in discover rows, browse pages, continue watching and next up, with bounded concurrency (default 2), a per-title cooldown (default 24 h), a daily cap (default 200 titles) and a setting to turn it off (document it in docs/configuration.md; a real server spends indexer API hits on it). Specs appear on the next list fetch; the client already handles null spec.',
      '- VLC engine caps on the versions endpoint: today vlcAvailable=true makes the server assume VLC plays everything (P2 stopped sending it because this VLC only does HEVC up to 1080p). Accept the VLC engine limits next to vlcAvailable (video codecs, max height, HDR formats, 10-bit; choose clear query parameter names, mirror the existing device parameters) and use them in the prediction and the recommendation, so Recommended stays a version that really plays. Unit tests for the decider/predictor with VLC caps. Document the parameters in docs/api.md; the client wires them in F3.',
      '- Container store: persist the real container of opened releases in the database (small table, migration) with LRU-style eviction instead of clearing all entries at once; predictions survive a restart.',
      '- Dev World: a way to restart or republish 39300 without wiping viewer accounts and watch state (e.g. scripts/devworld.sh start <port> --keep-data); the default behaviour and the e2e scripts stay unchanged.',
      '- Cleanup from docs/client/BACKLOG.md (Server section): kill the capability-probe ffmpeg process tree and SIGKILL on timeouts so no probe outlives a killed Dev World; ArtworkPaletteService must not drop work silently when its channel is full (wait or re-queue); log the first palette/spec failure per cause at Warning; CatalogSpecStore.Get indexes series instead of scanning all summaries; a test that useVlc is offered on the playback start-failure path before VLC has failed.',
      '- Never start an emulator, never restart or republish 39300 (the orchestrator does it after verification); test on 39310. Regenerate the client and web API types once at the very end (client gen:api + typecheck, web types) and touch nothing else in client/.',
      '- Keep the OpenAPI freeze, contract check and e2e green; journal each item as you finish it.',
    ].join('\n'),
    acceptance: [
      'Accept-Language de returns German overviews and genre names on the Dev World (English fallback when missing), per-language caches, Vary header; en unchanged',
      'spec warm-up fills card specs for discover/browse/resume titles in the background within its limits and can be switched off; no indexer search on the request path',
      'versions endpoint accepts VLC engine caps and the prediction/recommendation respect them (unit tests); container store persisted with bounded eviction',
      'Dev World can restart with its data kept; cleanup items done; OpenAPI frozen, contract check, e2e and the full server suite green',
    ],
  },
  'F3': {
    title: 'Client: one chip row, clearer TV glass, both specs, language, resize, account settings, leftovers, VLC caps',
    track: 'Client',
    deps: ['F2'],
    maxFixes: 2,
    guide: [
      '- Part of round G (PLAN.md section 5, "G — second follow-up round"; user decisions in section 2). Runs in parallel with server task B2 (server/ and port 39310 are B2\'s; do not touch them).',
      '- Library pages (user complaint): on TV the genre chips and the sort pill form two stacked chip rows that look odd. One chip row only: page title left and a compact sort control right in the same title line; the genre chips in ONE single-line row that scrolls horizontally (keep the focused chip in the title-safe area, a soft edge fade hints at more; D-pad Left from the first chip goes to the rail, Up from the chips reaches the sort). Same layout on web and tablet (one large-screen layout); the phone keeps its swipe row but also moves the sort into the title line. Keep the F2 focus flow, Back chain and focus memory working and re-check them.',
      '- TV glass (user decision): make the Android TV glass clearer. Body text keeps >= 4.5:1 and large text (>= 24 px regular or >= 18.66 px bold at the 1920 design scale) needs >= 3:1 over the measured brightest art; extend tv-glass.test.ts to check each text style against its own threshold. Show before/after of the Big Buck Bunny detail with the Recommended card focused.',
      '- Detail specs (user decision): cards keep the best existing version spec; the movie/series/episode detail shows both when they differ, e.g. "4K · HDR10 available · plays here in 1080p" (DE: "4K · HDR10 vorhanden · hier 1080p"), derived from the versions list (best qualityRank vs the recommended version). TV, web and phone.',
      '- Language (user decision): send Accept-Language with the app language (primary tag) on every API request and put the language into the catalog query keys so a language switch refetches. Harmless before B2 lands; verify the German texts once 39300 runs B2.',
      '- Resize/split screen: an Android split screen below 600 dp or a web resize across 640 px must not remount the navigator and lose the tab stacks (hysteresis and/or keep the stacks); extend the shell-selection unit test.',
      '- Settings account management with the existing /api/v1/viewer/me endpoints: sessions and devices (list, sign out one or all others), change password, change e-mail (with code verification), two-factor (set up with QR code and secret, enable, disable, recovery codes). Phone and web get all of it; TV gets the sessions list and sign-out plus a hint that password, e-mail and two-factor are managed on phone or web. Screen tests for the states.',
      '- F2 leftovers: filled sort segment turns square-cornered on Android after a change; Right from the rail after a genre deep link must land on the selected chip; a deep link that arrives while the rail has focus must move focus into the opened page; web: the clicked chip keeps a focus ring after browser Back. Small items: no native scrollbar on shell pages on web, phone grid titles wrap to two lines instead of truncating, tablet caption year not squeezed by spec chips.',
      '- VLC caps (needs B2 committed; the orchestrator writes the parameter names into docs/client/runs/driver/F3-notes.md): send the VLC engine limits from Android with vlcAvailable again and confirm Recommended = plain Play still holds on TV.',
      '- Silent tests, one emulator at a time, no dev overlays in screenshots, journal after each item, JPEG screenshots in docs/client/screenshots/F3/.',
    ].join('\n'),
    acceptance: [
      'library pages show one chip row with the sort in the title line on TV, web and tablet (phone: sort in the title line), F2 focus flow and Back chain unchanged',
      'TV glass clearer with per-style contrast thresholds tested; detail shows available vs device spec when they differ; Accept-Language sent and German metadata shown once B2 runs',
      'resize/split screen keeps the navigation; account management in Settings (phone/web full, TV sessions); F2 leftovers and small items fixed',
      'VLC caps sent from Android with Recommended = plain Play holding; no regressions; typecheck, lint and tests green',
    ],
  },
}

const TRACK_PATHS = {
  Backend: ['server', 'web', 'scripts', 'docs/api.md', 'docs/viewers.md', 'docs/transcoding.md', 'docs/setup.md', 'docs/README.md', 'docs/architecture.md', 'docs/configuration.md', '.codecraft/actions.json'],
  Client: ['client', '.codecraft/actions.json'],
  Design: ['docs/client/design'],
}

function buildPrompt(id, t) {
  return [
    COMMON,
    '',
    'YOUR TASK: ' + id + ' - ' + t.title,
    'Dependencies (read their journal files): ' + t.deps.join(', '),
    'Spec: docs/client/PLAN.md section 5, ' + id + '. Additional guidance:',
    t.guide,
    '',
    'Acceptance checklist (an independent verifier will check exactly these):',
    t.acceptance.map(a => '- ' + a).join('\n'),
    '',
    'If docs/client/journal/' + id + '.md already exists with Status: in-progress, a previous attempt was interrupted: continue from it and the working tree instead of starting over.',
    'Work until the acceptance checklist is met or you are truly blocked. Then finish the journal file (status, summary, decisions, files changed, evidence per checklist item, open issues, notes for next tasks), append the JOURNAL.md line, and return the structured result.',
  ].join('\n')
}

function verifyPrompt(id, t, reported, round, prevBlocking) {
  const scope = round === 1
    ? [
        'Check exactly this acceptance checklist, item by item; this is not an open-ended audit:',
        t.acceptance.map(a => '- ' + a).join('\n'),
        'Also look over the diff for code quality (dead code, speculative abstractions, comments longer than one line) and whether tests are meaningful.',
      ]
    : [
        'This is a re-check after a fix round. Check ONLY that these previous blocking findings are really fixed, then do one short smoke test of the main path to catch regressions:',
        prevBlocking.map(b => '- ' + b).join('\n'),
      ]
  return [
    COMMON,
    '',
    'You are the independent VERIFIER for task ' + id + ' - ' + t.title + ' (verification round ' + round + '). Be skeptical and reproduce every claim yourself; do not trust the report.',
    'Builder report: ' + JSON.stringify(reported || { note: 'no builder report in this run; rely on the journal' }),
    'Read the spec (PLAN.md section 5, ' + id + ') and the journal docs/client/journal/' + id + '.md. Inspect the real code (git status, git diff on the task paths; the other track may have uncommitted changes).',
  ]
    .concat(scope)
    .concat([
      'Stop exploring once the scope above is covered; aim for at most about 120 tool calls.',
      'Blocking = a checklist item fails or cannot be reproduced, a broken build or tests, a crash, data loss or a security issue. Everything else is non-blocking: list it, it becomes follow-up work and does not trigger another fix round.',
      'Do not fix product code yourself (throwaway scripts in /tmp are fine). Append a section "## Verification (round ' + round + ')" to docs/client/journal/' + id + '.md with the verdict, a pass/fail line per checklist item, blocking and non-blocking findings and evidence. Stop everything you started. Return the structured verdict.',
    ])
    .join('\n')
}

function fixPrompt(id, t, verdict, round) {
  return [
    COMMON,
    '',
    'YOUR TASK: fix the verifier findings for ' + id + ' - ' + t.title + ' (fix round ' + round + ').',
    'Blocking findings (must be fixed):',
    verdict.blocking.map(b => '- ' + b).join('\n'),
    'Non-blocking findings (fix only when cheap and clearly right; otherwise leave them in the journal as follow-ups):',
    (verdict.nonBlocking || []).map(b => '- ' + b).join('\n') || '- none',
    'Read docs/client/journal/' + id + '.md (builder notes and the latest verification) first. Fix root causes, re-run the relevant checks, add "## Fix round ' + round + '" to the journal file with what changed and the evidence, keep its Status accurate, and append a JOURNAL.md line "- ' + id + ' · fix ' + round + ' · <summary> -> journal/' + id + '.md". If backend: republish the Dev World when green. Return the structured result.',
  ].join('\n')
}

function commitPrompt(id, t, outcome) {
  const paths = TRACK_PATHS[t.track].concat(['docs/client/journal/' + id + '.md', 'docs/client/JOURNAL.md', 'docs/client/screenshots/' + id])
  return [
    'You create one git checkpoint commit in /Users/til/Development/streamarr (branch main). Do nothing else: no code edits, no push, no reset/stash/checkout/clean.',
    'Task: ' + id + ' - ' + t.title + ' (' + t.track + ' track). Outcome: ' + outcome + '.',
    '1. If .git/index.lock exists, wait 15 s and re-check (up to 8 times); if it persists and no git process runs (pgrep -x git), report it and stop.',
    'Your shell may start elsewhere and resets after every command: prefix EVERY command with "cd /Users/til/Development/streamarr && ".',
    '2. Stage only these paths (skip any that do not exist): git add -A -- ' + paths.join(' '),
    '3. Run "gitleaks git --staged --no-banner --redact". If it reports leaks, unstage the offending files (git restore --staged -- <file>), and mention them in your note.',
    '4. If nothing is staged, return committed=false. Other tracks may have staged files outside your paths: never commit them. Always commit with an explicit pathspec, git commit -m <msg> -- <the existing paths from step 2>, then check "git show --stat HEAD" lists only files under those paths.',
    '5. Commit with a conventional message: subject "' + (t.track === 'Backend' ? 'feat(server)' : 'feat(client)') + ': <what the task delivered> (' + id + ')" (max 72 chars), a short body (3-6 bullet lines) based on docs/client/journal/' + id + '.md Summary and the verification outcome, and the final trailer line exactly: Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
    'Return committed, the short hash and a one-line note.',
  ].join('\n')
}

async function must(prompt, opts) {
  const r = await agent(prompt, opts)
  if (!r) throw new Error(opts.label + ' failed (agent error, e.g. usage limit or expired token)')
  return r
}

async function runTask(id) {
  const t = TASKS[id]
  if (skip.has(id)) {
    log(id + ' skipped (done per journal)')
    return { id, skipped: true }
  }
  let last = await must(buildPrompt(id, t), { label: 'build ' + id, phase: t.track, schema: RESULT })
  if (last.status === 'blocked') throw new Error(id + ' blocked: ' + last.summary)
  let round = 1
  let fixes = 0
  let verdict = await must(verifyPrompt(id, t, last, round, []), { label: 'verify ' + id + ' #' + round, phase: t.track, schema: VERDICT })
  while (verdict.verdict === 'fail' && fixes < t.maxFixes) {
    fixes++
    log(id + ': ' + verdict.blocking.length + ' blocking finding(s), fix round ' + fixes)
    last = await must(fixPrompt(id, t, verdict, fixes), { label: 'fix ' + id + ' #' + fixes, phase: t.track, schema: RESULT })
    round++
    verdict = await must(verifyPrompt(id, t, last, round, verdict.blocking), { label: 'verify ' + id + ' #' + round, phase: t.track, schema: VERDICT })
  }
  const outcome = verdict.verdict + ' after ' + fixes + ' fix round(s)' + (verdict.verdict === 'fail' ? '; open blocking: ' + verdict.blocking.join(' | ') : '')
  log(id + ' finished: ' + outcome)
  const c = await must(commitPrompt(id, t, outcome), { label: 'commit ' + id, phase: 'Checkpoint', schema: COMMIT, effort: 'low' })
  log(id + ' checkpoint: ' + (c.committed ? c.hash : 'nothing committed') + ' - ' + c.note)
  return { id, verdict: verdict.verdict, fixRounds: fixes, openBlocking: verdict.blocking, nonBlocking: verdict.nonBlocking }
}

function signal() {
  let done
  const p = new Promise(resolve => { done = resolve })
  return { p, done }
}
const spikeDone = signal()
const followUpsDone = signal()

async function lane(name, steps) {
  const out = []
  try {
    for (const step of steps) out.push(await step())
  } catch (e) {
    log(name + ' lane stopped: ' + e.message)
    out.push({ stopped: e.message })
  }
  return out
}

async function gate(sig, id, waitingFor) {
  if (skip.has(id)) return true
  const ok = await sig.p
  if (!ok) throw new Error(id + ' not started: ' + waitingFor + ' did not finish')
  return true
}

const results = await parallel([
  () => lane('Client', [
    async () => {
      try {
        const r = await runTask('M3.1')
        spikeDone.done(true)
        return r
      } catch (e) {
        spikeDone.done(false)
        throw e
      }
    },
    () => runTask('M2.4'),
    () => runTask('M4.1'),
    async () => {
      await gate(followUpsDone, 'M4.2', 'M1.5')
      return runTask('M4.2')
    },
  ]),
  () => lane('Backend', [
    async () => {
      try {
        await gate(spikeDone, 'M1.5', 'M3.1')
        const r = await runTask('M1.5')
        followUpsDone.done(true)
        return r
      } catch (e) {
        followUpsDone.done(false)
        throw e
      }
    },
  ]),
])
return results.filter(Boolean).flat()
