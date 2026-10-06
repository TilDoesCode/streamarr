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
  'SILENT TESTS (the user sits next to this Mac): start Android emulators with -no-audio (argent boot-device: never pass sound: true), start Chromium with --mute-audio in addition to --remote-debugging-port, and never change the Mac output volume or mute state. iOS and tvOS simulators play through the Mac speakers: play video there only from a Metro started with EXPO_PUBLIC_TEST_MUTED=1 (every player starts and stays muted; added by I1 before any iOS playback), and Safari in a simulator only with muted test pages or a muted player.',
  'Two tracks run concurrently: backend (server/, web/ types, scripts/devworld.sh, docs/*.md) and client (client/). Stay inside your track unless your task explicitly requires otherwise, and never revert changes you did not make.',
  'Before anything else read: docs/client/PLAN.md (binding spec: sections 1-4 and your task in section 5), docs/client/JOURNAL.md, and of the dependency journals docs/client/journal/<id>.md only the Status, Summary, Decisions, Open issues and Notes for next tasks sections (skip their long evidence logs). PLAN.md section 3 (conventions) and section 4 (journal protocol) are mandatory.',
  'Hard rules:',
  '- Never use plan mode, EnterPlanMode, ExitPlanMode or AskUserQuestion. Decide, record the decision in your journal file, continue.',
  '- Do not git commit, push, stash, reset, checkout or clean. A separate checkpoint step commits.',
  '- Run "source docs/client/env.sh" in every shell (dotnet, JDK 17, Android SDK).',
  '- The machine has 8 GB RAM: at most one emulator/simulator (an iOS/tvOS simulator counts), never two native builds at once (Xcode and Gradle never together). Only the client track may run an emulator or simulator. Before finishing, stop everything you started (emulators, simulators via argent stop-simulator-server + xcrun simctl shutdown, Metro/Expo servers, Dev World instances, Chromium, Gradle daemons, xcodebuild, VBCSCompiler/MSBuild servers). Processes you start must not outlive you.',
  '- Device testing uses Argent (Software Mansion): the argent MCP tools or the argent CLI. Read .claude/skills/argent-tv-interact (TV) or argent-device-interact (phone/tablet/web) before driving a device.',
  '- Only claim what you verified with real commands. Put evidence (commands, observed results, screenshot paths under docs/client/screenshots/<TASK-ID>/) in the journal.',
  '- Source code comments: at most one line each, only where needed.',
  '- Xcode 27 is installed (/Applications/Xcode.app; iOS 27 and tvOS 27 simulator runtimes; CocoaPods 1.17). docs/client/env.sh exports DEVELOPER_DIR, so xcodebuild/xcrun/expo run:ios work even if xcode-select still points at the Command Line Tools. Never use sudo. Argent sees iOS/tvOS simulators because its shared tool-server was started with DEVELOPER_DIR; if list-devices ever shows no iOS simulators (the server was respawned without it), the client track restarts it with \"source docs/client/env.sh && argent server start --detach --force\" while it has no device running, then retries. Read .claude/skills/argent-ios-simulator-setup before booting a simulator. Real hardware is out of scope (the user tests devices later).',
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
  'B3': {
    title: 'Server: art highlight for per-title TV glass, B2 verify follow-ups',
    track: 'Backend',
    deps: ['B2'],
    maxFixes: 1,
    guide: [
      '- Part of round G (PLAN.md section 5, "G — second follow-up round"). Runs in parallel with client task F3, which uses the emulators and Dev World 39300.',
      '- Art highlight (orchestrator decision on the TV glass): F3 found that the per-style contrast rule over the brightest art (Big Buck Bunny white sky) only allows TV glass 0.70 -> 0.64, which is hardly visible. The client will size the glass alpha per title from the art actually behind the glass. Add the measured highlight next to tint/tint2 wherever the palette is returned: the colour (#RRGGBB) at a high luminance percentile (e.g. 95th, robust against single white pixels) of the backdrop the TV detail and hero draw behind their glass, measured per region if cheap (the right part behind the Versions panel, the left strip behind the rail) or once for the whole backdrop (conservative). Null when unknown; bump the palette version so cached palettes recompute; unit tests with synthetic images (white sky, dark scene); Dev World titles get real values. Document the field and how the client should use it (keep 4.5:1 body / 3:1 large text against the highlight) in docs/api.md.',
      '- B2 verify follow-ups (docs/client/BACKLOG.md, Server section): ArtworkPaletteService.DrainOverflow peek/write/dequeue race (can duplicate one item and lose another) and the unused Pending property; vlcVideoCodecs answers 400 for unknown codec names; a test that indexer searches use the server language for a German viewer; a test for the spec warm-up concurrency cap; docs consolidation (ViewerLanguages and the warm-up in docs/configuration.md, devworld --keep-data in docs/setup.md or the Dev World docs); resume items with title null: fill the title or drop the field if no client reads it (check client/ and web/ first).',
      '- Never start an emulator, never restart or republish 39300 (the orchestrator does it after verification); test on 39310. Regenerate the client and web API types once at the very end (client gen:api + typecheck, web types) and touch nothing else in client/.',
      '- Keep the OpenAPI freeze, contract check and e2e green; journal each item as you finish it.',
    ].join('\n'),
    acceptance: [
      'palette responses carry a measured highlight per title (null when unknown), unit-tested on synthetic bright and dark images, documented for the client; Dev World titles have values',
      'B2 verify follow-ups fixed or explicitly answered (palette overflow race, unknown codec 400, indexer language test, warm-up concurrency test, docs, resume title)',
      'OpenAPI frozen, contract check, e2e and the full server suite green; client and web types regenerated',
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
      '- Per-title TV glass (orchestrator decision after slice 2, needs B3 committed): size the TV glass alpha per title from the art highlight B3 adds to the palette, so dark art gets clearly clearer glass while every text style keeps its threshold against that highlight; fall back to the conservative constant (0.64) when the highlight is null. Unit tests for the alpha function; before/after on a dark title (Sherlock or Night of the Living Dead) and on Big Buck Bunny.',
      '- Near-square Android tablet (found in slice 2, e.g. 2300x2424 px at 420 dpi): the Versions panel on the large detail runs under the rail and its title is clipped; fix and screenshot.',
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
  'B4': {
    title: 'Server: polish from the F3/B3 follow-ups (mail cooldown and language, sign out others, vlcHdrFormats none, artwork language, profile)',
    track: 'Backend',
    deps: ['B3'],
    maxFixes: 1,
    guide: [
      '- Part of round H (PLAN.md section 5, "H — Apple platforms, polish and audio renditions"). Runs in parallel with the client track (iOS simulators, Dev World 39300): work and test on 39310 only, never restart or republish 39300, never start an emulator or simulator.',
      '- E-mail codes: a request inside the resend cooldown must not answer verificationSent: true without a mail. Answer it explicitly (e.g. 429 with a code such as email_code_cooldown, Retry-After and retryAfterSeconds) for the e-mail change and the e-mail sign-in code; the password-forgot answer stays generic (no account enumeration). Document it in docs/api.md.',
      '- Viewer e-mails (verification, sign-in code, password reset, anything else the viewer module sends) in the viewer language from the request (Accept-Language, same ViewerLanguages list as the catalog), German and English templates, English fallback; tests per language.',
      '- vlcHdrFormats=none (and an explicitly empty value) means VLC renders no HDR format; tests for the HDR HEVC <= 1080p case from the F3 journal; docs.',
      '- Sign out all other sessions atomically: one endpoint for the signed-in viewer (keeps the current session, answers the count), OpenAPI, tests, docs; the client switches to it in F4.',
      '- Artwork language: posters, backdrops and logos follow the viewer language (TMDB image language order: viewer language, then textless/null where it makes sense, then English), cached per language like the texts; the Dev World fake TMDB gets a visibly different German poster/logo for at least Big Buck Bunny and Sherlock so the client can show it.',
      '- Profile editing for F4: check what PATCH /api/v1/viewer/me accepts; make sure the display name can be changed by the viewer (validation, uniqueness rules as documented) and add a small avatar choice (a key from a fixed server-documented set, null = derived default) if it does not exist; OpenAPI and docs.',
      '- Small B3 leftovers from docs/client/BACKLOG.md (Server): palette overflow ordering (overflowed urls first) with a plain Queue under the lock; make IndexerLanguageTests meaningful or drop the vacuous term assertions.',
      '- Keep the OpenAPI freeze, contract check and e2e green; regenerate the client and web API types once at the very end (touch nothing else in client/).',
    ].join('\n'),
    acceptance: [
      'e-mail code cooldown answered explicitly (no false verificationSent), forgot stays generic; viewer e-mails in German and English by Accept-Language; tested and documented',
      'atomic sign-out of all other sessions; vlcHdrFormats=none; artwork in the viewer language with a visible German variant in the Dev World; display name (and avatar choice) editable via the viewer API',
      'B3 leftovers fixed; OpenAPI frozen, contract check, e2e and the full server suite green; client and web types regenerated',
    ],
  },
  'B5': {
    title: 'Server: multi-rendition audio in HLS (switch audio language without a new session)',
    track: 'Backend',
    deps: ['B4'],
    maxFixes: 2,
    guide: [
      '- Part of round H. Backlog item #4 (docs/client/journal/M1.5.md triage row 4: today an audio switch in a remux or transcode needs /switch and a new delivery). Read the M1.3/M1.4 journals (remux and transcode pipeline) first.',
      '- Goal: remux and transcode deliveries carry the offered audio tracks as EXT-X-MEDIA TYPE=AUDIO renditions in one group (LANGUAGE, NAME, DEFAULT, AUTOSELECT, CHANNELS), the variants reference the group, video playlists carry no audio, segments are aligned (fMP4/CMAF), so a player switches audio inside the same session with no restart. ffmpeg can do this in one process with the hls muxer (-var_stream_map with agroup) — prefer that over one process per track.',
      '- Bound the cost: offer the default track plus the tracks a viewer may want (preferred languages, at most a small fixed number, e.g. 4), convert only tracks the device cannot decode (AAC stereo fallback per the device profile), copy the rest; measure CPU, disk per session and start time against the single-rendition path on the Dev World and keep transcodes real-time; keep the session disk bound.',
      '- Contracts: the playback response lists the renditions (id, language, label, channels, codec, default) and whether in-session switching is available; /switch stays as the fallback (and for direct play); seek, resume, stop, heartbeats and subtitles (WebVTT renditions) unchanged. Document it in docs/api.md and docs/transcoding.md.',
      '- Dev World: the dual-audio release (mkv-dualaudio-ass-1080p) and at least one transcode case show two renditions; extend e2e/contract checks (ffprobe each rendition playlist, aligned segment durations, the master playlist structure). If mediastreamvalidator is available (Apple HTTP Live Streaming tools, not part of Xcode) run it; otherwise say so.',
      '- Never start an emulator or simulator; test on 39310; regenerate the client and web types once at the end. The client side (track switching in the players) is task F5.',
    ].join('\n'),
    acceptance: [
      'remux and transcode masters carry an audio group with one rendition per offered track, variants reference it, segments aligned; verified with ffprobe on the Dev World dual-audio title and a transcode',
      'cost bounded and measured (CPU, disk, start time vs single rendition); transcodes stay real-time; /switch, seek, resume, stop and subtitles unchanged',
      'playback contract lists the renditions; docs; OpenAPI frozen, contract check, e2e and the full server suite green; client and web types regenerated',
    ],
  },
  'I1': {
    title: 'Client: iPhone — build, core loop, Liquid Glass, Apple playback',
    track: 'Client',
    deps: ['F3'],
    maxFixes: 2,
    guide: [
      '- Part of round H (PLAN.md section 5). First time the app runs on Apple platforms: everything iOS so far was written, typechecked and unit-tested only (see the pending-ios items in docs/client/BACKLOG.md "Needs Xcode" and the R/R1/R3/M3.1/M4.2 journals).',
      '- Toolchain: npm run ios (scripts/prebuild-ios.mjs ios + expo run:ios) on an iPhone 18 Pro simulator (iOS 27). Fix build problems at the root in our code, config plugins or patches (patch-package), never by editing node_modules by hand. Record build commands, durations and memory notes in the journal for later tasks. The simulator reaches the Dev World at http://127.0.0.1:39300.',
      '- Silent playback first, before any iOS playback: EXPO_PUBLIC_TEST_MUTED=1 makes every player (expo-video, VLC, web video) start and stay muted in dev builds; unit test; start Metro with it for every simulator session from now on.',
      '- Core loop on iPhone: connect, sign in (anna / streamarr), profile picker, Home, search, detail, version sheet (iPhone formSheet), play (expo-video / AVPlayer: direct mp4, HLS remux and transcode), resume, next episode (Sherlock), Settings incl. account security, multi-account switch, German and English.',
      '- Native chrome per the glass rule (PLAN.md R): NativeTabs with Liquid Glass (minimizeBehavior, search role), large titles and transparent detail headers over the hero, the HeroFade masked-view on iOS (backlog: no fallback when the module is missing), expo-glass-effect surfaces and interactive player controls, Reduce Transparency fallback.',
      '- Keychain vault (expo-secure-store) for tokens and accounts; forms and keyboard insets (server URL, sign-in, settings forms).',
      '- Apple playback: the Swift media-caps module (VideoToolbox HEVC/HDR/DV, audio route) feeds the device profile; Recommended = picker default = plain Play on iPhone (the burned-in release name tells); a release AVPlayer cannot play (MKV, AV1, DTS/TrueHD in the Dev World) goes to VLCKit (expo-libvlc-player) or the server as designed, with the step-down path; PiP (expo-video) and an AirPlay route button present and wired.',
      '- Keep Android, web and Android TV unchanged (jest, tsc, lint; one Android smoke at the end).',
      '- Screenshots (JPEG) under docs/client/screenshots/I1/: sign-in, Home with the Liquid Glass tab bar, search, detail with transparent header, version sheet, player with controls, settings, German detail.',
    ].join('\n'),
    acceptance: [
      'iOS app builds from a clean prebuild and runs on the iPhone simulator; simulator playback is muted via EXPO_PUBLIC_TEST_MUTED; build steps recorded',
      'full core loop on iPhone (sign in, profiles, Home, search, detail, version sheet, play, resume, next episode, settings, account switch) in German and English with screenshots',
      'NativeTabs Liquid Glass, large titles and transparent headers, HeroFade, Keychain vault and keyboard insets work; media caps feed the profile and Recommended = plain Play; formats AVPlayer cannot play take the VLCKit or server path; PiP and AirPlay present',
      'no regressions on Android, web and Android TV; typecheck, lint and tests green',
    ],
  },
  'I2': {
    title: 'Client: iPad and Safari',
    track: 'Client',
    deps: ['I1'],
    maxFixes: 1,
    guide: [
      '- Part of round H. Builds on I1 (read its journal for build commands). Simulators: iPad Pro 13-inch (M5), iPad Air 11-inch (M4), iPad mini (A17 Pro); one at a time.',
      '- iPad uses the large-screen shell (R2: TV, web desktop and tablet render the same layout; code in navigation/app-tabs.tsx). Check it on all three sizes in portrait and landscape: rail, hero, rows, library pages (one chip row), detail with the glass Versions panel, player, settings; safe areas and the home indicator.',
      '- Multitasking: Split View / Slide Over / Stage Manager window sizes across the shell breakpoint keep the navigation state (F3 found the stacks are kept on Android and web; prove it on iPad) and lay out correctly at each size.',
      '- Input: hardware keyboard (focus, Return, Escape/Back, space and arrows in the player where designed) and trackpad/pointer hover on cards and buttons.',
      '- Player on iPad: AVPlayer playback, PiP, AirPlay button, panels.',
      '- Safari: the web client in Mobile Safari on the iPhone and iPad simulators (the hosted /watch client of the Dev World or the Expo web dev server): sign-in, Home, detail, play with native HLS (Safari profile from P2/M4.2), fullscreen, Back; muted playback only.',
      '- Screenshots (JPEG) under docs/client/screenshots/I2/ for each iPad size, Split View, Safari on iPhone and iPad.',
    ].join('\n'),
    acceptance: [
      'iPad large shell correct on three sizes in both orientations (rail, rows, library, detail with Versions panel, player, settings)',
      'Split View / Stage Manager sizes keep the navigation and lay out correctly; hardware keyboard and pointer hover work',
      'web client in Mobile Safari on iPhone and iPad: sign-in, browse, native HLS playback, fullscreen, Back',
      'no regressions; typecheck, lint and tests green',
    ],
  },
  'I3': {
    title: 'Client: Apple TV — tvOS build, focus engine, remote, playback',
    track: 'Client',
    deps: ['I2'],
    maxFixes: 2,
    guide: [
      '- Part of round H. npm run tv:ios (clean prebuild for tvOS; switching back to iPhone needs a clean prebuild — record both commands) on the Apple TV 4K (3rd generation) simulator, also check the 1080p one. Apple TV uses NativeTabs (native top tab bar) per navigation/app-tabs.tsx.',
      '- Focus engine: focus restore when returning to a screen (ScreenFocusScope / UIFocusGuide), rows and grids, library chips and sort, detail and Versions panel, settings devices; Menu-key Back chain (detail -> page -> tab bar -> leaving the app at the root as tvOS expects), deep links.',
      '- Input: Siri Remote via useTVEventHandler (select, play/pause, swipe/arrow scrubbing in the player), tvOS keyboard for search and sign-in.',
      '- Glass on tvOS: Liquid Glass where expo-glass-effect supports tvOS 26+, otherwise the system blur; contrast like Android TV (body 4.5:1, large 3:1; per-title alpha from highlight where our own glass is used).',
      '- Playback: AVPlayer on tvOS with the tvOS device profile (media caps), Recommended = plain Play, HDR/tone-mapping policy, player controls and panels with the remote, resume and next episode; muted playback only.',
      '- Screenshots (JPEG) under docs/client/screenshots/I3/: Home, Movies/Series, search with keyboard, detail with focus on Recommended, player controls, settings.',
    ].join('\n'),
    acceptance: [
      'tvOS app builds and runs on the Apple TV simulator; both prebuild switches documented',
      'focus engine: restore, rows, library, detail, Versions panel and settings reachable; Menu Back chain correct; deep links work',
      'Siri Remote and tvOS keyboard work; playback with the tvOS profile, Recommended = plain Play, resume and next episode; glass legible',
      'no regressions on iPhone, Android and web; typecheck, lint and tests green',
    ],
  },
  'F4': {
    title: 'Client: polish from the F3 verify follow-ups, profile editing, B4 endpoints',
    track: 'Client',
    deps: ['I3', 'B4'],
    maxFixes: 1,
    guide: [
      '- Part of round H. Items from docs/client/BACKLOG.md "Browse, navigation and UX" and "Accounts": TV Down from the sort control reaches the genre row; Back from Settings (and every tab page) follows the same chain as the library pages; after a device sign-out focus moves to the neighbouring row; TV glass buttons and chips sized per title like the panel; the release-name line on version cards meets 4.5:1 (add it to the per-style contrast table); near-square tablet rail logo below the status bar; web 500 px detail without a native scrollbar; web duplicate history entry after popping the active tab (re-check, fix if it reproduces).',
      '- Accounts: profile editing in Settings (display name and avatar choice from B4) on phone, web, iPhone/iPad and TV where it makes sense; sign-in method labels translated (password, password+2fa, email code, …); the two-step panel closes after saving or turning it off; "Sign out all other devices" uses the B4 endpoint; the e-mail code cooldown from B4 shows "wait N s"; a reliable live pass of the phone settings flows (argent keyboard/paste instead of adb text).',
      '- Check the changes on Android TV, Android phone, web and the iPhone simulator (one device at a time).',
    ].join('\n'),
    acceptance: [
      'the listed TV focus, glass, contrast, tablet and web items fixed with evidence',
      'profile editing, translated sign-in methods, two-step panel closing, atomic sign-out of others and the e-mail cooldown message work on phone, web and iPhone (TV where applicable)',
      'no regressions; typecheck, lint and tests green',
    ],
  },
  'F5': {
    title: 'Client: switch audio renditions in the players without a new session',
    track: 'Client',
    deps: ['F4', 'B5'],
    maxFixes: 1,
    guide: [
      '- Part of round H. Uses B5 (read its journal and docs/api.md): when the delivery lists audio renditions, the audio panel switches inside the session — hls.js audioTracks on web, Safari native audioTracks, AVPlayer media selection on iOS/tvOS (expo-video audio track API), ExoPlayer tracks on Android; VLC keeps switching its own direct plays; fall back to /switch when no renditions exist.',
      '- No restart: position kept, no black frame or rebuffer beyond the segment boundary; measure the switch time per platform and compare with the old /switch path; the selected track is remembered like today (preferences).',
      '- Check on Google TV, Android phone, web (Chrome and Safari in the iOS simulator), iPhone and Apple TV simulators with the Dev World dual-audio title, muted playback only; screen tests for the panel states.',
    ].join('\n'),
    acceptance: [
      'audio switches in-session on web, Safari, iPhone, Apple TV and Android with the Dev World dual-audio title; /switch fallback when there are no renditions',
      'position kept, switch times measured and better than /switch; preferences remembered',
      'no regressions; typecheck, lint and tests green',
    ],
  },
  'F6': {
    title: 'Client: edge-to-edge phone screens, back buttons on detail pages, TV focus spacing',
    track: 'Client',
    deps: ['F4'],
    maxFixes: 1,
    guide: [
      '- Part of round H, user review 2026-10-02 (notes in docs/client/runs/driver/F6-notes.md). (1) iPhone: the Home hero starts below the status bar and leaves a dark band (docs/client/screenshots/F4/26-iphone-portrait-after-player-close.jpg); artwork and hero surfaces must run edge to edge behind the status bar / Dynamic Island while text and controls stay inside the safe area. Check every phone screen on iPhone and the Android phone, keep the iOS large-title collapse and tab-bar minimise from I2 working.',
      '- (2) Every detail-type page (movie, series, season, versions route, any pushed page) needs a visible back control on iPad (touch large shell), Android tablet, web desktop and narrow web, and phones; the user saw none on the iPad. TV uses Menu/Back and needs no button. One shared component, glass style, safe-area and iPadOS window-controls aware, keyboard and pointer reachable on web.',
      '- (3) TV focus spacing: on Apple TV the focused \"Noch keine Versionen\" button and the watched toggle next to it touch (docs/client/screenshots/F4/32-tvos-no-versions-initial-focus.jpg). Audit every row of focusables on Apple TV and Android TV (detail actions, versions, chips + sort, player controls and panels, settings, profile picker, onboarding, up-next) and fix with one spacing rule derived from the focus scale and ring, not per screen.',
      '- The widescreen detail page gets a new concept (D2) and is rebuilt later: fix (2) and (3) in shared primitives, do not redesign the detail now.',
    ].join('\n'),
    acceptance: [
      'phone screens with artwork run edge to edge behind the status bar on iPhone and Android phone, controls inside the safe area; large-title collapse and tab-bar minimise still work',
      'every detail-type page has a visible, working back control on iPad, Android tablet, web (desktop + narrow) and phones',
      'no focused element on Apple TV or Android TV touches or overlaps a neighbouring focusable (audit table with evidence)',
      'no regressions; typecheck, lint and tests green',
    ],
  },
  'F7': {
    title: 'Client: widescreen detail page as the Bühne (D2) — versions in a sheet, episode strip, what-plays chips',
    track: 'Client',
    deps: ['F5', 'F6'],
    maxFixes: 2,
    guide: [
      '- Part of round H. Implements D2 variant 1 "Bühne" (docs/client/design/detail-concept.html, its F7 outline, and the D2b addendum renders docs/client/design/jpg/D2b-*.jpg) on TV, iPad/tablet and web desktop; phones keep their detail page. Read PLAN.md section 5 "D2 decision" first: it is binding.',
      '- No navigation events when the episode or season changes: selection is screen-local state (initial value from route params / nextEpisode / deep link); never router.push/replace/setParams/navigate on a selection change; no web history entries; Back/Menu leaves the page (Android TV: strip -> actions -> leave). Screen tests assert the router is not called on selection changes.',
      '- What-plays chip row next to Play/Resume for exactly the version that button starts (one decision function shared by the chips and the play call): playback method chip most prominent (direct / direct stream / transcode / VLC, colour per the Aurora + Signal tokens, reason when not direct), then resolution, HDR format, video codec, audio codec + channels, source. Resume shows and starts the version it resumes (last played when still offered and playable here, else the recommended one, stated in the chip row). For series it follows the selected episode (versions of the selected episode, debounced, cached).',
      '- Versions only in a sheet (versions/[workId] as formSheet/transparentModal on iPad/web/TV) opened from "Versionen · N" (one version: "Details", none: hidden); remove the always-visible VersionPanel on large screens. Reuse F6 BackControl and the focus clearance rule; Apple TV: geometry-only focus paths, explicit list heights, no JS focus moves after Menu (I3 findings).',
      '- Slices per the D2 F7 outline: S1 version sheet, S2 movie Bühne + chip row, S3 episode strip + season chips (no navigation), S4 input per platform (Android TV Back chain, Apple TV autoFocus guides + long press, web keyboard/hover, iPad), S5 sizes (iPad portrait/window, near-square tablet, web 1280/1920) + device pass. Muted playback only.',
    ].join('\n'),
    acceptance: [
      'the Bühne matches the D2/D2b concept on Apple TV, Android TV, iPad and web desktop (movie and series, all states), phones unchanged',
      'changing episode or season never triggers a navigation event (tests + live: no history entry, Back leaves the page)',
      'the chip row always names the version and playback method that Play/Resume actually start (checked against the started playback on every platform)',
      'versions only in the sheet; focus paths work by geometry on Apple TV; no focus ring touches a neighbour',
      'forced subtitles follow the audio language on every audio switch (in-session and /switch), a full subtitle the viewer picked stays; phones resume the last played version and their version card names it',
      'no regressions; typecheck, lint and tests green',
    ],
  },
  'B6': {
    title: 'Server: tone-mapped transcodes tagged SDR, colour metadata consistent with the playlist, B5 follow-ups',
    track: 'Backend',
    deps: ['B5'],
    maxFixes: 1,
    guide: [
      '- Part of round H. Found by I1 on the iPhone simulator (docs/client/journal/I1.md item 10): the 4K HDR10 -> SDR transcode writes H.264 with color_transfer=smpte2084 (PQ) while the master says VIDEO-RANGE=SDR; AVPlayer refuses the item (CoreMediaErrorDomain -12927) and the client ends with no_more_methods. Android players tolerated it, Apple does not.',
      '- Fix at the root: every tone-mapped (HDR -> SDR) output is tagged bt709 (primaries, transfer, matrix, range) in the bitstream (VUI/SEI) and the fMP4 colr box; non-tone-mapped HDR passthrough keeps its HDR tags and VIDEO-RANGE=PQ/HLG; SDR sources stay bt709. Check every transcode and remux path (H.264/HEVC encoders, hardware/software, the 4K, 1080p and 720p cases, HLG and DV sources in the Dev World) and the VIDEO-RANGE attribute against the actual tags.',
      '- Guard: e2e/contract checks ffprobe the init + first segment of every transcode/remux case and fail when VIDEO-RANGE and the stream colour tags disagree (SDR <-> bt709/unknown, PQ <-> smpte2084, HLG <-> arib-std-b67); a unit test for the argument builder per case. If Apple tools are available (they are not by default: say so), run mediastreamvalidator; otherwise use hlssim plus ffprobe.',
      '- B5 verify follow-ups (docs/client/BACKLOG.md Server): Fmp4TrackSplit throws only InvalidDataException on malformed input, bounds the trun sample count, and the controller answers a clear 5xx code (not a generic 500) without leaking internals; rendition NAME/label describe what is delivered after conversion (e.g. "Deutsch · AAC 2.0", localised like the current labels); one codec per AUDIO group where the device profile allows it (convert the odd one out, or document why not); fMP4 audio tracks carry their language (-metadata:s:a:i language=); docs/transcoding.md bitrate example fixed; drop the test-only synchronous Segment helper or use it in production; admin plan/preview lists the renditions.',
      '- Never start an emulator or simulator, never touch client/ (except regenerating client/src/api/schema.d.ts once at the end if the OpenAPI changes), never restart or republish 39300; test on 39310.',
    ].join('\n'),
    acceptance: [
      'tone-mapped transcodes are tagged bt709 in bitstream and container, HDR passthrough keeps HDR tags, and VIDEO-RANGE matches the tags for every Dev World transcode/remux case; an e2e/contract guard fails on a mismatch',
      'B5 follow-ups fixed or explicitly answered (splitter errors, rendition labels after conversion, codec per group, track language, docs, test-only helper, admin preview)',
      'OpenAPI frozen, contract check, e2e and the full server suite green; client and web types regenerated if the contract changed',
    ],
  },
  'B7': {
    title: 'Server: no-store on token responses, VLC reason lines, small B4/B6 follow-ups',
    track: 'Backend',
    deps: ['B6'],
    maxFixes: 1,
    guide: [
      '- Part of round H. Security finding from I1 (docs/client/journal/I1.md item 14): iOS NSURLCache wrote a 2FA sign-in response with access and refresh tokens to the app cache on disk. Every response that carries a secret (viewer auth: login, second factor, e-mail code verify, refresh, password reset; /viewer/me two-factor setup and recovery codes; playback responses with a stream token; admin auth/session responses; anything else that returns a token, secret or one-time code) must send Cache-Control: no-store (plus Pragma: no-cache where useful). Prefer one central rule (middleware/filter keyed on route groups or response type) over per-action attributes, so new endpoints are covered; a test that walks the OpenAPI routes and asserts the header on every secret-bearing response; docs.',
      '- Version reason lines: for a release predicted to play with VLC, the reasons describe the native-engine conversion ("HEVC video is converted for this device", "HDR10 is converted to SDR") although VLC plays it without conversion (seen on the iPhone version sheet, docs/client/screenshots/I1/16-version-sheet-vlc-en.jpg). Reasons must describe the predicted engine and method; tests; check the client formats the reason codes it gets (record client changes for F4 instead of making them).',
      '- Small follow-ups from docs/client/BACKLOG.md Server: avatarKey in admin viewer responses (B4); an automated test for the controller 500 rendition_split_failed and docs that match the splitter exceptions (B6); verify_devworld.py next-up check tolerant of kept watch state (--keep-data) or run against a fresh probe viewer; the duplicate login validation on the sign-in code path (B4).',
      '- Never start an emulator or simulator, never touch client/ (except regenerating client/src/api/schema.d.ts once at the end if the OpenAPI changes), never restart or republish 39300; test on 39310. Keep host load modest (a client agent runs an iOS simulator and Xcode builds in parallel): filtered dotnet test runs while iterating, the full suite once at the end.',
    ].join('\n'),
    acceptance: [
      'every secret-bearing response sends Cache-Control: no-store via one central rule, covered by a route-walking test and docs',
      'VLC predictions carry engine-correct reason lines; follow-ups (admin avatarKey, rendition_split_failed test and docs, verify next-up with kept data, duplicate validation) fixed or answered',
      'OpenAPI frozen, contract check, e2e and the full server suite green; client and web types regenerated if the contract changed',
    ],
  },
  'Q1': {
    title: 'Client: quality walkthrough on every device (audit, no code changes)',
    track: 'Client',
    deps: ['F7'],
    maxFixes: 0,
    guide: [
      '- Part of round I ("tip top"). An audit, not a fix task: do NOT change product code. Output: docs/client/journal/Q1.md with one findings table (id Q1-NN, target, screen/flow, severity P1/P2/P3 per PLAN.md section 5 "I", what is wrong, exact repro, expected, screenshot path, suspected file/area, "BACKLOG" when already listed there) and screenshots docs/client/screenshots/Q1/.',
      '- Targets, one at a time: S1 web Chrome (1280, 1920, 390 px; DE and EN), Google TV emulator, Android phone emulator (if the dev build stays responsive; record ANRs as a finding with host load); S2 iPhone 18 Pro, iPad Pro 13 (portrait + landscape), Apple TV 4K. Mobile Safari only as a short smoke (iPhone).',
      '- Flows per target (the same checklist is reused by Q2): first start / sign-in (deep link + password, wrong password, unreachable server via a wrong port), profile picker and switch (anna, ben with 2FA, the kid profile), Home (hero, rows, continue watching, next up, row memory), Movies/Series browse (genres, sort, paging, empty genre), Search (typing, recent searches, no results), movie and series detail (Bühne on TV/iPad/web, phone detail), versions sheet, About sheet, player (start stepper, seek, audio + subtitles incl. forced, next episode/up-next, end card, replay, close, resume afterwards), Settings (profile edit, devices, sign out others, language switch DE<->EN live, sign out), error/empty/loading states, back/Menu chains, rotation on phones, focus on TV (lost focus, rings touching neighbours, focus after closing sheets/player).',
      '- Look at every screenshot you judge; judge like a picky designer and a picky QA engineer (alignment, clipping, truncation, wrong language, inconsistent spacing between platforms, jank, slow transitions with a number). Do not report emulator-only slowness as P1/P2 unless it would plausibly happen on hardware; mark it "emulator".',
      '- Muted playback only. Leave anna signed in, ben unchanged; record every test-data change (watch state, last played version) in the journal.',
    ].join('\n'),
    acceptance: [
      'every target and every flow of the checklist covered or explicitly marked as not reachable with the reason',
      'findings table complete (severity, repro, screenshot) and cross-referenced with BACKLOG.md',
      'no product code changed; all devices, Metro and Chromium stopped',
    ],
  },
  'B8': {
    title: 'Server: replay resume point, consistent rendition codec, round I follow-ups, Dev World long season',
    track: 'Backend',
    deps: ['B7'],
    maxFixes: 1,
    guide: [
      '- Part of round I. Replay keeps a resume point (PLAN.md section 5 "I" decision): after a playback completed the work (CompletedBy), a later report of the same playback whose position went back below the resume threshold starts a new viewing (resume point again, played state stays); post-credits reports stay ignored. Tests for both.',
      '- Audio renditions (docs/client/BACKLOG.md Server, F5): the delivered rendition codec must not depend on start vs /switch or on audioLanguage for the same device and title (Safari AC-3 2.0 at start vs AAC 2.0 after /switch; iPhone/Apple TV the reverse); the rendition label/channels describe what is delivered (Sintel German AC-3 5.1 is labelled 2.0 — find out whether it is downmixed and label it truthfully). Tests.',
      '- Viewer sessions: never store the English literal "Unknown device"; store null (or carry the name from the first sign-in step) so clients show their translated fallback; migrate existing rows. A display name of only spaces answers 400 (validation), docs.',
      '- B7 leftovers: docs/api.md versions section lists predictedMethod vlc and VLC reasons; the no-store route-walk test also asserts Expires: 0 and walks HEAD/OPTIONS; verify_devworld.py always removes its probe viewer (try/finally); one-line XML summary on NoStoreApiResponses. Dev World stream info of the 4K HDR10 BBB: videoRange must agree with hdr (check the generated file tags, fix the fixture or the probe).',
      '- Dev World: add one long season (at least 24 episodes, short generated media like the existing episodes, artwork optional) to an existing or a new fixture series so the TV long-season strip can be checked live; keep existing fixture ids stable (clients and tests depend on them); update e2e/verify scripts and the fixture docs.',
      '- Never start an emulator or simulator, never touch client/ (except regenerating client/src/api/schema.d.ts once at the end if the OpenAPI changes), never restart or republish 39300 (a client audit uses it); test on 39310. Keep host load modest: filtered dotnet test runs while iterating, the full suite once at the end.',
    ].join('\n'),
    acceptance: [
      'replay after completion leaves a resume point; post-credits reports stay ignored (tests)',
      'same device + title deliver the same rendition codec at start and after /switch; rendition labels match the delivered channels (tests)',
      'no stored "Unknown device" literal (migration); whitespace display name -> 400; B7 leftovers fixed; HDR10 BBB videoRange consistent',
      'Dev World has a season with >= 24 episodes; existing ids stable; OpenAPI frozen, contract check, e2e and the full server suite green; client/web types regenerated if the contract changed',
    ],
  },
  'T1': {
    title: 'Client: tests and code health (no devices, own git worktree)',
    track: 'Client',
    deps: ['F7'],
    maxFixes: 1,
    guide: [
      '- Part of round I. Runs beside a device audit in the main tree, so you work ONLY in the git worktree given in your prompt (never edit /Users/til/Development/streamarr itself) and never start Metro, a simulator, an emulator or Chromium. jest with --maxWorkers=2.',
      '- Test gaps from docs/client/BACKLOG.md: engine-error -> /switch fallback of an in-session audio switch and NAME-first track matching in audio-renditions.ts (both missing per the F5 mutation run; add tests that fail when the logic is broken — prove it by a temporary mutation, then revert it); focus-clearance screen tests per primitive (action row, chip row) asserting the gap; url-cache test beyond grepping the source if feasible in jest.',
      '- Code health: controller.audioSwitches bounded or behind __DEV__; no remembered audio language sent for single-audio titles; PHONE_HEADER_HEIGHT duplicate and stray import in phone-detail.tsx; multi-line doc comments -> one line (project rule); dead code and unused exports (run a tool such as knip/ts-prune via npx without adding a dependency, judge each hit); unused i18n keys and a jest test that de.json and en.json have the same keys and that no user-visible string literal is hardcoded in src/ (reasonable heuristic, allowlist for technical strings).',
      '- Web multi-tab: each tab writes the whole account list to localStorage, so a second tab can overwrite an edited display name; write per account or merge on storage events; tests.',
      '- Brand PNGs (icon 554 KB, top shelf 2.2-2.6 MB): smaller without visible banding (noise-free re-render or a better encoder; compare crops before/after); do not change the look.',
    ].join('\n'),
    acceptance: [
      'the new tests fail on a deliberate mutation of the code they guard (evidence in the journal) and pass on the real code',
      'audioSwitches bounded, single-audio titles send no remembered language, duplicates/dead code removed with judgement, de/en key parity test and hardcoded-string test green',
      'web tabs no longer overwrite each other\'s account edits (test)',
      'brand PNGs smaller with no visible change (before/after crops)',
      'typecheck, lint, prettier and jest green in the worktree; nothing changed outside it',
    ],
  },
  'F8': {
    title: 'Client: TV polish (Google TV + Apple TV, JS level) incl. Q1 TV findings',
    track: 'Client',
    deps: ['Q1', 'B8'],
    maxFixes: 2,
    guide: [
      '- Part of round I. Fix every P1/P2 TV finding of docs/client/journal/Q1.md assigned to F8 by the orchestrator (list in your prompt) plus these BACKLOG items: sessions of anna end on the Google TV AVD between runs ("Signed out for your security" / "Your session has ended") — find out which side ends it (refresh rotation interrupted by an app kill -> refresh_token_reused -> sign-out would hit real users: reproduce with an app kill during and right after a refresh, fix at the root on client and/or report a server change to the orchestrator); TitleActions loading state that keeps the main button mounted (focus must not move) while an episode\'s versions load; stage pill "Season 3 · Episode" without number (Android text clipping); deep link from one detail to another keeps the previous page\'s focused slot (focus memory per route); genre scroller vs sort control gap from the focus rule; useFocusGap on non-focus platforms (decide and record); LogBox "state update on a component that hasn\'t mounted yet" at Google TV Home; long-season strip position live with the B8 long season.',
      '- Check every fix live on Google TV and Apple TV 4K (cached tvOS app, docs/client/tv-remote.sh), one device at a time; tests for each root cause.',
    ].join('\n'),
    acceptance: [
      'every assigned Q1 TV finding fixed (before/after screenshots) or moved to BACKLOG with a sound reason',
      'the Google TV sign-out cause found and fixed (or proven to be emulator-only with evidence)',
      'versions-loading state keeps focus, long-season strip checked live, deep-link focus memory per route',
      'no focus ring touches a neighbour; no regressions; typecheck, lint and tests green',
    ],
  },
  'I4': {
    title: 'Client: Apple TV native focus and Menu (tvOS rebuild)',
    track: 'Client',
    deps: ['F8'],
    maxFixes: 2,
    guide: [
      '- Part of round I. The tvOS items react-native-tvos cannot solve from JS (docs/client/BACKLOG.md "Needs Xcode" + Apple TV entries): initial focus inside presented sheets (Versions, About: native preferredFocusEnvironments on the presented controller or an equivalent native hook); Menu inside the Versions sheet and on library grid chips must step back one level, not pop the whole detail or exit; Menu from a non-Start tab goes to Start first (like Android TV); player: after Menu hides the overlay no hidden button keeps focus; the native top tab bar while Settings scrolls (content slides under it); "Zurück zu den Details" from a player started on Home must not focus the Start tab; the last Versions card glow cut at the panel bottom; deep link over an open detail pushes instead of replacing. Plus Q1 Apple TV findings assigned to I4.',
      '- Build: switch the prebuild to tvOS (cd client && node scripts/prebuild-ios.mjs tvos), xcodebuild for the Apple TV simulator, refresh ~/.cache/streamarr-tvos-app; at the end switch back to iOS (node scripts/prebuild-ios.mjs ios) and, if native code shared with iOS changed, rebuild the iPhone app once and refresh ~/.cache/streamarr-ios-app. Check free disk space before each build (stop and report if < 8 GB). Native code as an Expo module or config plugin under client/modules or client/plugins (never hand-edit generated ios/ files that a prebuild overwrites).',
      '- VLCKit on tvOS: verify once whether it plays; if yes enable VLC hints on tvOS, else record why it stays native-only.',
    ].join('\n'),
    acceptance: [
      'Versions and About sheets open with focus inside; Menu steps back exactly one level in sheets, grid chips and non-Start tabs',
      'player: no hidden focus after Menu; Settings content never slides under the tab bar; back-to-details focus correct; no glow cut',
      'tvOS build reproducible from the prebuild (documented), cached apps refreshed, iOS prebuild restored',
      'no regressions on iPhone/iPad (same native modules); typecheck, lint and tests green',
    ],
  },
  'F9': {
    title: 'Client: phones, tablets and web polish incl. Q1 findings',
    track: 'Client',
    deps: ['I4'],
    maxFixes: 2,
    guide: [
      '- Part of round I. Fix every P1/P2 phone/tablet/web finding of docs/client/journal/Q1.md assigned to F9 (list in your prompt) plus these BACKLOG items: web Escape / Alt+Left for the BackControl; iPad Safari stays in element fullscreen after closing the player; iPhone Safari pause from system controls not reflected; iOS sign-in deep link while signed in has no way back (offer "back to the app"); Android phone Sign in button half under the keyboard; iOS NativeTabs labels keep the old language after a live switch; large titles do not shrink on Search/Settings; first player close after a fresh boot stays landscape; Safari forced subtitle (kind "forced") missing in the subtitle panel; client trims and validates the display name (B8 answers 400 for blanks); Replay from the end card keeps a resume point with B8 (check live).',
      '- Check live on web Chrome (1280/390), Mobile Safari (iPhone, iPad), iPhone 18 Pro, iPad Pro 13 and the Android phone AVD; one device at a time; tests per root cause.',
    ].join('\n'),
    acceptance: [
      'every assigned Q1 finding fixed (before/after screenshots) or moved to BACKLOG with a sound reason',
      'listed BACKLOG items fixed or answered with evidence',
      'no regressions on TV (shared code paths: jest + one Google TV smoke); typecheck, lint and tests green',
    ],
  },
  'R1': {
    title: 'Client: release builds — start time, memory, dev-only crashes, bundle size',
    track: 'Client',
    deps: ['F9'],
    maxFixes: 1,
    guide: [
      '- Part of round I. Build release variants: Android (assembleRelease or an expo release build for the Google TV AVD and the phone AVD), iOS and tvOS Release for the simulators, web production export (expo export -p web). Disk is tight: check free space before each build, clean old build outputs you created, stop and report below 8 GB.',
      '- Measure and compare with the dev builds: cold start to Home, Home memory (Android dumpsys meminfo / iOS footprint), detail push/pop time on Google TV (dev: ~5 s on the AVD), first frame of a muted direct play; check whether the dev-only issues reproduce in release (Google TV deep-link crash "App react context shouldn\'t be created before", LogBox warnings, Android phone ANR at player start); web bundle size per route chunk and image weight.',
      '- Fix cheap release-only problems (proguard/hermes/asset issues) at the root; everything else to BACKLOG with numbers. Leave the dev builds installed afterwards (agents rely on them).',
    ].join('\n'),
    acceptance: [
      'release builds exist for Android TV/phone, iOS, tvOS and web, each launched and signed in once',
      'numbers table dev vs release (start, memory, pop time, first frame, bundle size) in the journal',
      'dev-only issues classified (gone in release / still there -> fixed or BACKLOG); dev builds restored',
    ],
  },
  'Q2': {
    title: 'Client: final walkthrough with the Q1 checklist on every device',
    track: 'Client',
    deps: ['R1'],
    maxFixes: 0,
    guide: [
      '- Part of round I. Repeat the Q1 checklist (docs/client/journal/Q1.md) on every target; re-check every Q1 finding (fixed / still open) and look for new defects. No code changes; findings table like Q1 in docs/client/journal/Q2.md, screenshots docs/client/screenshots/Q2/.',
    ].join('\n'),
    acceptance: [
      'every Q1 finding re-checked with status; every target and flow covered',
      'no P1/P2 open on any target, or each listed with repro for a follow-up fix round',
    ],
  },
  'B9': {
    title: 'Server: series next episode prefers an active replay, next-up without versions',
    track: 'Backend',
    deps: ['B8'],
    maxFixes: 1,
    guide: [
      '- Part of round I (server requests from F9 S1, docs/client/journal/F9.md "Server request"). (1) `SeriesWatchSummaryDto.nextEpisode` (ViewerCatalogService.NextEpisodeAsync) returns next-up before any resume point, so after a B8 replay of a watched episode the series still points at the following episode (Sherlock: hero continues S2E2, series says S3E1). Rule: the most recent in-progress episode (resume point, reason "resume") wins when its lastPlayedAt is newer than the latest completion in that series; otherwise next-up as today. Same rule wherever the server picks a series\' current episode (continue watching, hero, next-up), so all surfaces agree.',
      '- (2) `/watch/next-up` and continue/next rows offer episodes without any version (Sherlock S3E1): add `available` (bool, at least one playable release exists) to the next-up/continue item contracts (additive, OpenAPI re-frozen) and keep the order truthful: pick the next episode in order; if it has no version, still return it with available=false so the client can show "not available yet". Document the rule in docs/api.md.',
      '- Tests for both rules (unit + e2e on your own Dev World 39310 with anna-like data you create: replay of a watched episode -> nextEpisode = that episode; next episode without versions -> available=false). Regenerate web and client types at the very end; do not change client code otherwise.',
          '- (3) Refresh rotation after an app kill (server request from F8 S1, docs/client/journal/F8.md): when ViewerSessionService.RefreshAsync sees the PREVIOUS refresh token of a session whose rotated pair was never used (no request authenticated with the new access token and the new refresh token never presented), replay that rotation (hand out the same new pair) instead of revoking the session, as long as the old refresh token is within its lifetime. Once the new pair has been used, a reuse of the old token still revokes the session (theft detection unchanged). Track first use of the rotated pair (e.g. RotationConfirmedAt). Tests for: kill before persist -> replay works; reuse after the new pair was used -> revoked; reuse of an even older token -> revoked. Document it in docs/viewers.md.',
    ].join('\n'),
    acceptance: [
      'a refresh with the previous token is answered with the same rotated pair while that pair is unused; reuse after the pair was used still revokes (tests, docs)',
      'series nextEpisode/continue/hero agree: an active replay of a watched episode wins over next-up (tests)',
      'next-up and continue items carry available; an episode without versions is returned with available=false (tests, docs)',
      'OpenAPI re-frozen, contract check, e2e and the full server suite green; web and client types regenerated',
    ],
  },
  'B10': {
    title: 'Server: image sizes per use, tagline only in the viewer language, long-season artwork, alias cooldown',
    track: 'Backend',
    deps: ['B9'],
    maxFixes: 1,
    guide: [
      '- Part of round I (findings of R1 S1, F9 S2a and BACKLOG). (1) Image weight: R1 measured card images of ~130-156 KB (w780-class) for ~233 px web cards, about 1 MB of the ~1.6 MB on web Home (docs/client/journal/R1.md). Find where the server (and Dev World) chooses the artwork URLs/sizes for list items (home rows, library, search, next-up/continue, episodes/stills) vs detail/hero backdrops, and give the client size-appropriate images: either additive size-class URLs on the items (e.g. posterUrl small/medium, stillUrl small, backdrop for hero) or a documented `size` parameter on the image route; real TMDB paths must map to the TMDB size buckets (w92/w154/w185/w342/w500/w780/w1280/original), Dev World must serve the same classes (generate the smaller files once in the media cache). Keep current fields working (additive contract change, OpenAPI re-frozen). Measure bytes per card before/after on Dev World.',
      '- (2) Tagline language: the German About sheet shows an English tagline when TMDB has none in German. Rule: tagline only in the viewer language (null otherwise); overview keeps its current fallback. Tests.',
      '- (3) Dev World: generated artwork for "The Lighthouse Logs" (poster, backdrop, logo-less title is fine, episode stills) so it appears in Home rows and looks realistic on the Bühne; ids stay stable.',
      '- (4) BACKLOG: username and e-mail of one account share the sign-in code cooldown, so the 429 on the second alias reveals that both belong together: key the cooldown per (account, alias) or answer the second alias exactly like a first send without sending; pick the variant that does not leak and does not allow mail flooding; tests + docs.',
      '- Test on your own Dev World 39310; regenerate web and client types at the very end if the contract changed (client code otherwise untouched; the client switch to the new sizes is a client task).',
    ].join('\n'),
    acceptance: [
      'list items carry size-appropriate artwork (documented size classes; Dev World serves them); bytes per web Home card measured before/after',
      'tagline only in the viewer language (tests); Lighthouse Logs has artwork in Dev World with stable ids',
      'the sign-in code cooldown no longer reveals that two aliases belong to one account and still limits mail (tests, docs)',
      'OpenAPI re-frozen, contract check, e2e and the full server suite green; web and client types regenerated if the contract changed',
    ],
  },
  'B11': {
    title: 'Server: precise refresh failure codes, refresh failures logged, session tombstones',
    track: 'Backend',
    deps: ['B9'],
    maxFixes: 1,
    guide: [
      '- Part of round I (server request from F8 S6, docs/client/journal/F8.md "## Android session ended (S6)" -> "### Server request"). Today every non-reuse refresh 401 is `refresh_session_expired`, so the client can only say "Your session has ended". (1) Keep `refresh_token_reused`; answer `refresh_session_expired` only when the session exists and its refresh window is over; `refresh_session_revoked` with `params.reason` (signed_out / revoked_by_viewer / session_limit / admin / password_changed / account_disabled) when the session was ended on purpose; `refresh_token_unknown` when no session or tombstone matches (deleted, never issued here, or a device restored from an old backup/snapshot). Same 401 status, additive codes in the documented error list (OpenAPI re-frozen if the error code enum is part of the contract); docs/api.md + docs/viewers.md.',
      '- (2) Log every refresh failure at Information with the case and, when known, the session id and viewer id — never the token or its hash. (3) Tombstones: when a session is deleted or revoked, keep a small record (session id, viewer id, refresh-token hash prefix or the retired hashes, reason, time) for 30 days so an old token maps to "revoked: <reason>" instead of "unknown"; cleanup job; migration. Tests for every case incl. the B9 replay path and the 20-session limit eviction (session_limit).',
      '- Security: the new codes must not let someone without a valid token learn anything about an account (an unknown/garbage token must get `refresh_token_unknown` with no other detail; tombstone lookups by hash only). Test on your own Dev World 39310; regenerate web and client types at the very end if the contract changed; do not change client code otherwise.',
    ].join('\n'),
    acceptance: [
      'refresh 401s distinguish expired / revoked (with reason) / unknown / reused; tombstones map old tokens to their reason for 30 days (tests, docs)',
      'refresh failures are logged without token material; no account information leaks to a caller without a valid token',
      'OpenAPI frozen, contract check, e2e and the full server suite green; web and client types regenerated if the contract changed',
    ],
  },
  'B12': {
    title: 'Dev World: fault injection for the player (every delivery and session failure on demand)',
    track: 'Backend',
    deps: ['B11'],
    maxFixes: 1,
    guide: [
      '- Part of round I, user requirement 2026-10-05 00:50 (PLAN.md section 5 "I"): the player must catch and explain every state. Implement the spec docs/client/player/b12-fault-spec.md exactly (API /devworld/faults to arm faults per playback/work/global, once/always, list/clear; 38 faults + the real restart and the short-idle scenario; hooks on the segment/playlist/rendition/subtitle/direct-stream endpoints, the transcode session and auth). Dev World only: nothing under server/src changes unless the spec says so, and nothing reaches the product build.',
      '- Each fault verified on your own Dev World 39310 with a script (curl/python/ffprobe) that arms it, provokes it and shows the effect; a tools/faults_smoke.py the client agents can reuse; README section with one example per fault.',
    ].join('\n'),
    acceptance: [
      'every fault of the spec armable per playback and globally, listed and cleared via /devworld/faults; once/always honoured',
      'each fault demonstrated by tools/faults_smoke.py on a fresh Dev World; product server build unchanged',
      'contract check, e2e and the full server suite green; README documents every fault with an example',
    ],
  },
  'B13': {
    title: 'Server: playback robustness follow-ups found by F10a',
    track: 'Backend',
    deps: ['B12'],
    maxFixes: 1,
    guide: [
      '- Part of round I (docs/client/journal/F10.md "Server follow-ups", docs/client/player/state-matrix.md § 0 items 7-8 and § 2). (1) Seek back > 15 min inside one long transcode run waits on a run that never rewrites the retained-away segment -> 90 s hang -> 504 (TranscodeSessionManager.cs ~358-366, ~614-633): reproduce with B12 or a long fixture, fix so a seek outside the retained window restarts the run at that position. (2) Cap each segment wait at ~25 s and answer 504 with Retry-After (and Retry-After on 503 segment_evicted) so the server and the client timeouts agree. (3) A progress report for a dead playbackId answers 200 today: add an additive `playbackAlive` (or a documented 404 playback_not_found that old clients survive) so the client notices a lost server playback from its heartbeat. (4) Audio fallback for /switch: a flag to convert the selected audio track to AAC (ladder step A).',
      '- Tests for each, docs/api.md + docs/transcoding.md, OpenAPI re-frozen if the contract changes, web and client types regenerated at the very end.',
    ].join('\n'),
    acceptance: [
      'seek outside the retained window restarts the run (no 90 s hang), proven with a test/e2e',
      'segment waits capped with 504 + Retry-After; segment_evicted carries Retry-After',
      'heartbeat/progress tells a dead playback apart; /switch audio fallback flag; docs, contract, e2e and the full server suite green',
    ],
  },
  'F10': {
    title: 'Client: the player catches and explains every state (watchdog, taxonomy, recovery ladder, hints)',
    track: 'Client',
    deps: ['F8', 'F9', 'I4', 'B12'],
    maxFixes: 2,
    guide: [
      '- Part of round I, user requirement 2026-10-05 00:50 (PLAN.md section 5 "I"): the viewer never sees a generic error, a black screen or a frozen picture; every state is compensated or explained with a specific de/en hint and an action. The binding design is docs/client/player/state-matrix.md (§ 1 matrix of 148 rows, § 2 design: watchdog, taxonomy T1-T11, ladder W/R/N/Q/S/A/V/G with budgets, hint catalogue, timelines, test and live strategy, § 2 f slices S1-S9). Deviations only with a recorded reason in docs/client/journal/F10.md.',
      '- Every matrix row gets a jest test (fake engines / fake server, § 2 d) named by its row id; a coverage test fails when a row has no test. Native probes (S6 expo-video patch, S7 libVLC/VLCKit) and live fault runs on every engine with Dev World fault injection (B12) follow the design; one device and one native build at a time.',
    ].join('\n'),
    acceptance: [
      'every matrix row has a passing jest test with its id, and the row coverage test is green',
      'no path shows a generic error, a black or frozen picture without a hint inside the budget (live fault runs per engine: hls.js, Safari native, ExoPlayer, AVPlayer iOS/tvOS, VLC)',
      'network-class failures never step down the playback method; the position survives every recovery; hints de/en complete',
      'no regressions on TV/phone/web; typecheck, lint and tests green',
    ],
  },
  'B14': {
    title: 'Server: backlog sweep from the round I verifiers (rate limit, races, flaky tests, Dev World nits)',
    track: 'Backend',
    deps: ['B13'],
    maxFixes: 1,
    guide: [
      '- Part of round I. Close the server items the round-I verifiers left in docs/client/BACKLOG.md (sections B9 verify, B10 verify, B11 verify, B12 verify, B13 verify, B13b verify, Server tests). In order of value: (1) rate limit for POST /viewer/auth/refresh per client IP and per presented token hash (generous for real apps that refresh every few minutes, tight for floods; 429 with Retry-After; refusal log lines aggregated so an anonymous flood cannot fill the log feed), tests incl. that a normal app refresh cadence never hits it. (2) Superseded start: when a start is replaced, the old start\'s late remux session must be closed as soon as it registers (not when the playback ends) and must not hold a remux slot; make the wait inside StartJobLockedAsync cancellable or check the revision after it; test with the B12 start_hang fault. (3) Account deletion writes tombstones under the same session lock as refresh (no racing refresh answering unknown); a previous-token replay checks IsDisabled; the unknown-token path does the tombstone PK lookup before any LIKE scan over retired hashes (or index the retired hashes). (4) Flaky tests: ReleaseContainerStoreTests.Store_EvictsTheLeastRecentlyUsed_AndSurvivesARestart, RepairConcurrencyTests, HealthCheckerTests.Concurrency_UsesConfiguredProviderBudget, IndexerSearchServiceTests.CancelledWaiter_DoesNotCancelSharedFanOut, SpecWarmupTests — find each timing assumption and make the test deterministic (no sleeps racing background writers; await the condition with a bound) without weakening what it proves; run each 20x under load. (5) Automated tests for Retry-After on 503 segment_evicted, the WebVTT wait cap and the 25 s budget across ffmpeg restarts. (6) Dev World nits: POST /devworld/faults answers 400 (not 500) for a numeric params.mode or fractional ttlSeconds; spent once/count faults leave the list; transcode_kill smoke checks the next-segment 500 + restart; transcode_slow also slows remux runs; playback_robustness_check switch_under_fault passes params.mode; README start_hang wording; the StartTimeout() doc comment. (7) Docs: a progress stop with a live id answers playbackAlive true although the call ends the playback.',
      '- Test on your own Dev World 39310; contract check, e2e and the full server suite once at the end; OpenAPI unchanged unless a documented 429 needs adding (then re-freeze, regenerate web and client types once at the very end).',
    ].join('\n'),
    acceptance: [
      'refresh rate limit with tests (normal cadence never limited, floods 429 + Retry-After, log aggregated); superseded start closes its late session at once (test)',
      'tombstone/refresh race closed, IsDisabled on replay, tombstone lookup before any scan; the five flaky tests deterministic (20x green under load)',
      'Retry-After/WebVTT/cross-restart budget tests; Dev World nits fixed; contract, e2e and full suite green',
    ],
  },
  'B16': {
    title: 'Server: ffmpeg throttle without SIGSTOP (Process.Start blocks), repair-race 500, competing transcode requests',
    track: 'Backend',
    deps: ['B14'],
    maxFixes: 1,
    guide: [
      '- Part of round I (findings of B14, docs/client/journal/B14.md "Open issues" and docs/client/BACKLOG.md). (1) HIGH: on macOS/.NET 8 `Process.Start` blocks while any child process is SIGSTOPped; the transcode throttle pauses ffmpeg with SIGSTOP, so while one session is paused every new ffmpeg/ffprobe spawn (any title, any viewer) waits until that run resumes or is killed (a unit probe blocked 586 s; live a second start sat in planning/resolving 40 s+). This is very likely the long unexplained `starting` the client sees. Find the exact mechanism (read the .NET Process/SIGCHLD code path for the installed runtime), then remove the dependency: throttle without SIGSTOP (e.g. ffmpeg -readrate / segment-ahead window enforced by not requesting/serving further and letting ffmpeg block on a bounded output, or a stop-and-resume of the run at the throttle point) — keep the B5/B13 behaviour (segment retention, seek restarts, wait budgets, renditions) and the CPU/disk benefits of throttling; prove with a test that a new start is not delayed while another session is throttled (the old probe must pass in < 2 s), on macOS. Check Linux too if a container runtime is available (docker/colima/podman — do not install one; if none, reason from the .NET source and record it).',
      '- (2) Repair race: RepairConcurrencyTests fails ~1 in 5: one of 56 concurrent readers that hit a new Usenet hole gets 500 UsenetArticleNotFoundException because RepairAwareStream rethrows the original error after a failed hole wait/admission instead of joining the shared repair job; fix the product race (every concurrent reader of the same hole joins the one job and gets its result), make the test pass 50/50 under load.',
      '- (3) Two live requests competing on one transcode session ping-pong restarts until one runs out of attempts (503): two players / an hls.js retry and a seek asking for far-apart segments of the same session. Decide the rule (e.g. the most recent request position wins and the other gets a fast 409/redirect or waits for the window; never a restart storm), implement and test with the robustness check.',
      '- Test on your own Dev World 39310 (B12 faults help), full server suite once at the end; no contract change expected.',
    ].join('\n'),
    acceptance: [
      'a throttled session never delays another start or ffprobe (test: new start < 2 s while another run is throttled), throttling still saves CPU/disk, Linux reasoning or check recorded',
      'RepairConcurrencyTests 50/50 under load with the product race fixed (no 500 for a reader that hits a hole under repair)',
      'two competing requests on one transcode session no longer cause a restart storm (rule documented and tested); contract, e2e and the full server suite green',
    ],
  },
  'B17': {
    title: 'Server: B14-B16 verify follow-ups (parked run keeps playing, same-IP refresh fairness, own seek back, resume overlap, nits)',
    track: 'Backend',
    deps: ['B14', 'B15', 'B16'],
    maxFixes: 1,
    guide: [
      '- Part of round I (docs/client/BACKLOG.md "B14-B16 verify (non-blocking)" and the "Verification (round 1)" sections of docs/client/journal/B14.md, B15.md, B16.md). The player must never see an error the server could avoid. In order of value: (1) a parked (throttled) run gives up its remux/transcode slot, so with all slots taken its resume answers 503 remux_capacity mid-playback: a playback that is already playing must always be able to resume (keep a reserved slot, or let the resume take precedence over a new start that would otherwise queue/refuse); test with all slots taken. (2) A refresh flooder behind the same IP as real viewers keeps their refreshes at 429: a valid, live refresh token must never be limited by the per-IP budget (count only failed/unknown refreshes per IP, or let a valid token bypass it); keep the flood protection and the per-token limit; tests for both. (3) One player that jumps far ahead and straight back within 3 s now waits 3.4-4 s for the first segment (was 0.3-0.5 s): requests from the same playback are never "competing" with themselves - the latest request of one playback wins at once; the 3 s rule applies only between different requesters; test. (4) A transcode resume overlaps by one video frame and ~37 ms of audio: make the resumed segment start exactly where the previous one ended (timestamps continuous, no duplicate frame, no audio overlap), check with ffprobe over the boundary; test. (5) Error answers on the transcode routes scan all playbacks issue gates: skip unknown sessions (O(1) lookup). (6) Nits: leftover doc comment ProcessRunner.cs:157; Dev World logs the refresh limiter Information lines (category-level override, not global); fault:7 answers a clear 400 message naming the bad field; faults_smoke usenet_hole restores the releases it breaks (or the e2e doc says to run on a fresh instance - prefer restoring).',
      '- Test on your own Dev World 39310; never restart or republish 39300. Contract check, e2e and the full server suite once at the end; no contract change expected (if one is unavoidable, re-freeze and regenerate web and client types once at the very end).',
    ].join('\n'),
    acceptance: [
      'a playing (parked) run always resumes with all slots taken (no 503 remux_capacity mid-playback; test); a valid live refresh token is never limited by the per-IP budget while floods stay limited (tests)',
      'one playback seeking far and back within 3 s gets its first segment as fast as before B16 (test); a transcode resume has continuous timestamps without a duplicate frame or audio overlap (ffprobe evidence + test)',
      'error answers skip unknown sessions; nits fixed (doc comment, limiter log level in Dev World, fault 400 message, usenet_hole restores); contract, e2e and the full server suite green',
    ],
  },
  'B18': {
    title: 'Server: live repair state during play (progress GET), plus B17 verify follow-ups',
    track: 'Backend',
    deps: ['B17'],
    maxFixes: 1,
    guide: [
      '- Part of round I (F10 code review 7, P2-4, docs/client/runs/driver/F10-code-review-7.md). `ViewerPlaybackService` sets `Playback.Repair` only in ResolveAsync/RepairAsync (repair-while-streaming starts and the repair wait); `Snapshot`/GET returns that value unchanged for the rest of the playback. So a player that polls the playback during a stall sees a stale `downloadingRecovery` with an old ETA forever, and a repair that fails or is cancelled during play is never reported. Fix: while the playback is ready and its `Repair` is not terminal, the GET (and the progress/heartbeat answer if it carries playback state) refreshes `Repair` from `resolver.RepairStatus(ResolvedReleaseId)` (cheap, no lock held across I/O; throttle per playback if the status read is not O(1)); once terminal it stays at the terminal state (ready/failed/cancelled/evicted) for the client to read, then clears on a release change. Tests (unit + e2e on your own Dev World 39310 with a `usenet_stall`/repair fault during play: the GET shows the state moving and finally `ready`, and a failed repair shows `failed`). No contract change expected (the field exists); if the docs describe it as a start-time snapshot, fix the docs (docs/api.md, docs/viewers.md).',
      '- Then the non-blocking findings of the B17 verifier (docs/client/journal/B17.md "Verification (round 1)") that a viewer can feel; record the rest in docs/client/BACKLOG.md.',
      '- Own Dev World 39310 only; never restart or republish 39300. Contract check, faults_smoke + e2e and the full server suite once at the end (nice -n 10).',
    ].join('\n'),
    acceptance: [
      'during play the playback GET reports the live repair state (moving states, final ready/failed) instead of the start-time snapshot (unit + e2e)',
      'B17 verifier follow-ups that a viewer can feel are fixed or recorded; contract, e2e and the full server suite green',
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
