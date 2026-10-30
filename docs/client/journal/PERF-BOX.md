# PERF-BOX — Streamarr on the Streamybox: held keys, detail, cold start

Status: done (box-measured incl. verified focus moves; overlay regression fixed on the emulator, box re-test pending, see "Box re-test")

Owner (2026-10-29, translated): on the box Streamarr is "acceptable, not good" in performance mode and worse without it;
SmartTube on the same box is smoother and reacts better. Target: Radxa ROCK 4D (RK3576, 4×A72 + 4×A53, Mali-G52, Android
14, passive cooling), TV remote over HDMI-CEC (held key = repeat). Branch `perf/streamarr-box` from 24110fe6 (0.20.0).
Part of a four-agent deep dive (BASE harness/baseline, LA launcher, SYS kernel/system); coordination board
`$SB_WORK/perf-2026-10-29/COORD.md`, raw runs `$SB_WORK/perf-2026-10-29/streamarr/runs/`, baselines `…/baseline/`.

## Result on the box

0.20.0 (AOT `speed-profile`, BASE baselines `20261029-base`/`-full`/`-start2`) vs. the final build (HEAD of this branch,
installed as APK + `.dm`, ART `speed-profile [install-dm]`; run `streamarr/runs/h2-2108`). BASE harness `scripts/perf/run.sh`,
3 runs each, medians, perf mode set per scenario, no power actions. Row = 20×Right + 20×Left held (CEC repeat timing),
vert = 6×Down/6×Up, detail = OK → detail → Back ×3.

| scenario | jank % | frame p95 ms | frame p99 ms | gaps >20 ms % | key→present p50 ms | key→present p95 ms |
|---|---|---|---|---|---|---|
| sa-lite-row | 6.7 → **3.5** | 37 → **35** | 51 → **37** | 6.8 → **3.3** | 59 → **57** | 78 → **73** |
| sa-lite-vert | 17.5 → **9.3** | 58 → **37** | 300 → **314** | 14.4 → **4.9** | 53 → **58** | 69 → **70** |
| sa-lite-detail | 14.5 → **10.4** | 66 → **50** | 112 → **74** | 9.3 → **5.3** | 347 → **214** | 646 → **364** |
| sa-full-row | 37 → **6.3** | 159 → **42** | 211 → **54** | 30 → **6.0** | 120 → **75** | 273 → **87** |
| sa-full-vert | 20 → **6.7** | 97 → **43** | 154 → **56** | 16.7 → **6.9** | 70 → **60** | 488 → **468** |
| sa-full-detail | 15.3 → **16.9** | 94 → **63** | 133 → **121** | 10.8 → **10.1** | 387 → **232** | 719 → **412** |

| start | 0.20.0 | final |
|---|---|---|
| cold, lite | 2.72 s | **2.35 s** |
| cold, full | 3.72 s | **3.29 s** |
| hot, lite | 102 ms | **94 ms** |
| hot, full | 143 ms | **146 ms** |

- Full mode on a held row was 37 % jank with p99 frames of 211 ms; it is now 6.3 % / 54 ms, about lite level. SmartTube on
  the same scenario (BASE 19:21): jank 1.2 %, gaps >20 ms 1.5 %.
- Opening a detail page is 35–40 % faster in both modes (p95 646 → 364 ms lite, 719 → 412 ms full). full-detail jank % is
  higher only because the page is ready sooner (fewer frames in the window; missed frames 36 → 23).
- lite-vert p99 ~300 ms (one frame per row change, a large commit of the next row) and key→present p50 (+5 ms, within run
  noise) are unchanged — open.
- Cold start 2.72 → 2.35 s (lite) / 3.72 → 3.29 s (full). SmartTube shows its native shell after 0.5 s; Streamarr's start
  is JS-bound (below).

## What changed (and what each did)

| Commit | Change | Measured effect |
|---|---|---|
| d619816a | Worklets 0.10.1 requested a native frame every vsync forever and Reanimated 4.5.1 re-ran its mappers every frame (also in the background). Patched (patch-package): frames only while callbacks wait, mappers run on input changes | emulator, app in background: 588 → 0 Choreographer callbacks / 10 s (LA saw 2.6 s main-thread CPU per 100 s on the box while Streamarr was hidden) |
| 080ed753 | NativeWind's per-element JSX wrapper only on the web; native Text sets its tone colour inline | part of the row/detail gains, not isolated |
| 41f84fb8 | TV focus ring/lift start in a UI-thread worklet (Reanimated `useEvent` on focus/blur), JS keeps memory/callbacks | ring starts without a JS round trip |
| 8ea454d1 | Android cards round their artwork (expo-image outline) instead of an `overflow: hidden` rounded clip (`clipPath` per card and frame) | pixel-identical; small RenderThread saving |
| d824baa7 | expo-router's getStateFromPath fork rebuilt every route config (regexes, localeCompare sort) per call; cached per options + segments | emulator, 10 detail opens: JS samples 134 → 103 |
| b8ebc918 | Intl formatters / DisplayNames cached, Text spec regex constant | – |
| **309c6c77** | react-native-tvos `ReactViewManager.onAfterUpdateTransaction` called `AccessibilityManager.getEnabledAccessibilityServiceList()` (sync binder into system_server) after **every view update**; the box always has an a11y service on. AGP class transform routes it to `A11yServiceCache` (host-system), cleared by a11y listeners | emulator: main-thread binder calls 58 → 4 per held row, UPDATE_PROPS mount cost 697 → 61 ms; box (BASE): 3.3 s blocked per 14 s full hold before |
| 4db41b73 | performance mode: one MMKV listener + cached value instead of one native listener and read per card | – |
| c69084f4 | About shows the release version (was hard-coded 0.1.0) | bug fix |
| 44aac654 | Home hero waits while a key is held (move within 600 ms → 500 ms rest) instead of re-rendering on every CEC repeat | full-row frame p95 85 → 42 ms together with b0c351c9 |
| b0c351c9 | card titles fade the bright title over the muted one (opacity, synchronous on Android) instead of animating `color` (a shadow-tree commit per frame) | emulator full mode: commit batches 345 → 240 |
| f9db44ed | ART baseline profile of the TV paths (`profiles/baseline-prof.txt`, `scripts/collect-baseline-profile.sh`, plugin `with-baseline-profile`); before, `baseline.prof` held only androidx/Compose | with `.dm`: speed-profile at install; without AOT the cold start was 0.2–0.8 s slower after every update |
| 7662f3f7 | release workflow publishes `streamarr-android-tv-X.Y.Z.dm` next to the APK (checked, attested, in SHA256SUMS) | installers that pass it get AOT at once |
| **9f10ae9c** | Shell hero backdrop crossfade used Reanimated entering/exiting layout animations; while they run Reanimated flushes the shadow tree every frame and mounts every pending commit on the UI thread. expo-image `transition` does the same dissolve natively | emulator full mode: UPDATE_PROPS batches 194 → 16 per 32 held moves; box full-vert jank 20 → 6.7 % |
| ef33090d | intl-messageformat resolved its locale (`supportedLocalesOf` via ICU/JNI) for every translated key; memoized | box cold start lite 2.56 → 2.35 s, full 3.39 → 3.29 s |

## Measured and dropped

- Metro `inlineRequires` (Expo turns it off): box cold start 2.60 s without vs 2.61 s with (alternating, Hermes-profiled builds) — no gain, not kept.
- Lazy view managers (`ViewManagerOnDemandReactPackage` for RNScreens/Expo): BASE's cold trace shows `CreateUIManagerConstants`
  26 ms + 47 × `getConstantsForViewManager` 75 ms on the box. The ~330 ms the Hermes sampler attributed to `getConstants` was
  profiler overhead. ≤ 0.1 s for patching autolinked packages — left as is.
- Starting the Home requests earlier: Home renders its first frame from the MMKV-persisted queries, so the network is not on
  the critical path of the first frame.
- Release bundle: Hermes bytecode (HBC v98), no source map, no HMR/Refresh/DevTools hook in the APK — nothing to do.

## Held keys: every repeat moves one card (BASE 21:43 check)

BASE saw R20/L20 end in the side rail with SA builds and on card 1 with 0.20.0. Box, uiautomator focus dump after each
hold (KeyInjector `hold`, 250 ms CEC-style repeat), 21:48–21:57: "Filme im Trend" had 20 cards then, so R20 from card 1
is 19 moves + 1 press at the row end and L20 is 19 moves + 1 into the rail — ending in the rail is correct.

| hold | final lite | final full | 0.20.0 lite | 0.20.0 full |
|---|---|---|---|---|
| R10 from card 1 | card 11 | card 11 | card 11 | card 11 |
| L10 | card 1 | card 1 | card 1 | card 1 |
| R20 | card 20 | card 20 | card 20 | card 20 |
| L20 | rail | rail | rail | **card 1 (one press lost)** |
| Right from the rail | card 1 | card 1 | card 1 | – |

0.20.0 full is exact on short holds (R5/L6); the press is lost only on the long hold under load.

Verified row measurement (22:15–22:35): BASE harness c362b71d with R19/L19 (no edge presses on the 20-card row), its
input check "focused view after = before" **ok in all 12 runs**; final build (APK + `.dm`) and 0.20.0 code (24110fe6 as
20001, `speed-profile`), 3 runs each (`streamarr/runs/head-2231`, `final-2215`):

| scenario | jank % | frame p95 / p99 ms | gaps >20 ms % | key→present p50 / p95 ms |
|---|---|---|---|---|
| lite row, 0.20.0 | 7.5 | 36 / 60 | 8.0 | 60 / 79 |
| lite row, final | **3.5** | **34 / 39** | **3.6** | **58 / 68** |
| full row, 0.20.0 | 49.6 | 193 / 249 | 40.3 | 139 / 352 |
| full row, final | **6.2** | **41 / 54** | **6.1** | **68 / 81** |

## Regression fixed after the box run: player overlay did not hide (owner, 2026-10-30)

Owner on the box (build 20001 'final'): the player overlay no longer hid by itself; Back left the player at once.
Emulator: 0.20.0 code hides after 5 s, every SA build from `abl-loop` on (only d619816a) keeps it drawn.

Cause: d619816a runs Reanimated's mappers only when an input changes (stock: every frame). Prop updates are flushed as a
finalizer of the next mapper run (`__requestMapperRunFinalizer`, updateProps.ts). The overlay fade is a `withTiming` the
`useAnimatedStyle` updater returns itself (`opacity: withTiming(visible ? 1 : 0)`): it steps in its own frame callback,
outside any mapper run, so none of its updates reached the view. `visible` was already false (the overlay counted as
hidden, the clock went coarse), so the overlay's Back returned false and the screen left the player. Shared-value
animations (focus lift, ring) start mapper runs themselves and were not affected.

Fix 79b6fd60 (patches/react-native-reanimated, mappers.ts): a finalizer requested outside a mapper run requests one; each
request also asks for a frame, because event handlers do not drain the UI microtask queue. Idle nothing is requested
(emulator, backgrounded: 0 `animation` callbacks per 10 s, unchanged). `src/performance/__tests__/reanimated-frames.test.ts`
runs the patched registry as on native and fails without the fix.

The Back order was already right in code (picker → panel → up next/end card → overlay → leave); it failed only because
the overlay looked shown while it counted as hidden. Tests 2ee2f165: PlayScreen Back with an open panel (panel, overlay,
then leave), PlayerOverlay on TV (hides after 5 s; Back hides it first). Emulator, build `final-fix` (2ee2f165, APK + .dm):
full and lite, de and en — overlay hides 5 s after the last key, Back closes the Info panel, then the overlay, then the
player; screenshots `$SB_WORK/perf-2026-10-29/screens/streamarr/sheet-autohide.png`, `sheet-back-order.png`. The Streamybox
engine shares the overlay and Back path (play-screen), but runs only on the box: box check pending.

## How it was measured

- Box: BASE harness (`perf-harness/scripts/perf/run.sh`, Perfetto FrameTimeline + gfxinfo + thread CPU), wrapped in
  `streamarr/scripts/box-ab.sh` (installs APK + `.dm`, awake check only, `boxq` slot). Every build after `pm install -r`
  without `.dm` runs `verify` (no AOT) until bg-dexopt: the first 'all' run was rerun after `cmd package compile -m
  speed-profile -f` (single package, no all-core load; SYS 18:59 supply brownout).
- Startup JS: profiling test builds (never committed: `streamarr/scripts/profiling-patch.py` makes the APK profileable and
  starts the Hermes sampling profiler from process start via `setprop debug.streamarr.profile_start 1`); symbolicated with
  the release source map (`streamarr/scripts/hprof.js`, `hcallers.js`).
- Per-key commits: emulator Perfetto (`IntBufferBatchMountItem::mountInstructions::*`), a Reanimated build with
  `enableReanimatedProfiling` and temporary C++/JS markers (local only) to find the layout-animation flush.
- Emulator: own AVD `streamarr_dv_tv` (emulator-5554) against Dev World 39320; screenshots in
  `$SB_WORK/perf-2026-10-29/screens/streamarr/` (lite/full Home, detail DE/EN, settings perf-mode chips, version 0.20.1,
  hero crossfade).

## Verification

- typecheck 0, lint 0, jest 213 suites / 2305 tests green (new: a11y plugin, baseline-profile plugin, perf-mode section,
  hero rest while moving, ICU locale memo).
- Emulator: TV focus (start focus, held keys, hero buttons, exit dialog layer), detail + return focus, playback start,
  perf-mode switch live (chips + status + full/lite swap), TalkBack on/off clears the a11y cache (one fresh query each).
- The a11y transform fails the build if `ReactViewManager` stops making the call (checked by renaming the target method).
- BASE 18:12 "perf-mode chip stays on An": the emulator showed the right chip with the old code too after the multi-second
  full re-render; BASE's capture was most likely taken mid re-render. Re-check on the box is part of the re-test.

## Open

- Cold start: ~1.5 s of Hermes evaluation + first Home render before content; SmartTube shows a native shell at 0.5 s.
  Next levers: a lighter first Home frame (defer ambient/hero/glass in full mode), fewer modules evaluated at start.
- lite-vert row change p99 ~300 ms (the next row's first mount).
- Focus ring overlaps the caption of lite cards slightly (unchanged from 0.20.0).
- Box store / box-update: install Streamarr with its `.dm` (install-multiple or one package session) — Streamybox side.

## Box re-test

Final candidate: APK + `.dm` from this branch's HEAD, versionCode 20001 (0.20.1; the release 0.20.1 is 20001 as well — equal
codes reinstall with `-r`). On the box: `adb install-multiple -r streamarr-…apk streamarr-….dm`, then
`dumpsys package dexopt` must show `[status=speed-profile] [reason=install-dm]` for `dev.streamarr.app`.

1. BASE harness (input check on; on a 20-card trending row use R19/L19) `run.sh --runs 3 sa-lite-row sa-lite-vert sa-lite-detail sa-full-row sa-full-vert sa-full-detail sa-lite-start sa-full-start`:
   expect the "final" column above (± run noise).
2. Settings ▸ Leistungsmodus: switch Aus/An/Automatisch — the selected chip and the status line follow within the re-render.
3. Settings ▸ Info: App-Version 0.20.1.
4. Hold Right in a full-mode row for 5 s: the hero backdrop changes once after the key is released (cross-dissolve), no
   stutter while held.
5. Player overlay (ExoPlayer title and a DV title in the Streamybox Player): it hides 5 s after the last key; with the Info
   panel open, Back closes the panel, then the overlay, then the player.
6. Embedded Streamybox Player (AVR muted and verified with cecq first): a Dolby Vision version starts inside Streamarr, Info panel
   "HDR: Dolby Vision · Streamybox Player".
7. Send Streamarr to the background (HOME) for 60 s: no `animation` Choreographer callbacks of `dev.streamarr.app` in a trace.
