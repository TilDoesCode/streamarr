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
}

const TRACK_PATHS = {
  Backend: ['server', 'web', 'scripts', 'docs/api.md', 'docs/viewers.md', 'docs/transcoding.md', 'docs/setup.md', 'docs/README.md', 'docs/architecture.md', 'docs/configuration.md', '.codecraft/actions.json'],
  Client: ['client', '.codecraft/actions.json'],
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
