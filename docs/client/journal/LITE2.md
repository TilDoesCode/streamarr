# LITE2 — performance mode: cheap motion instead of no motion

Status: done

User request (2026-10-24, translated): the performance mode (Leistungsmodus) for weak player boxes switched the
animations off completely. That was not the intent: only Home lagged, when the rows swapped around and animated back and
forth. Lite mode should get a calmer Home with less movement; focus should still animate (cards grow a bit) so it still
looks nice, just cheaper. Target: Radxa ROCK 4D (RK3576, Mali-G52), where `auto` turns lite on (`WEAK_SOCS`).
Branch `feat/watchlist-diagnostics` (PR #48). Previous lite work: `feat/rock4d-lite-mode` (fdf5aeb, 518a931), merged
in fa2810c; it has no journal of its own (round-2 report missing, see `_manager/STATUS.md`).

## What lite mode did before / does now

| Effect | Before (v0.18 lite) | Now |
| --- | --- | --- |
| Reanimated reduced motion | `ReducedMotionConfig mode=Always` app-wide: every timing, spring and layout animation jumped to its end | only when the system's animations are off (`animatorScale 0`, reason `animationsOff`) — then everything is reduced as before |
| Card focus | ring on/off (step), no lift | timed lift 160 ms ease-out, no spring overshoot, scale ≤ 1.06 (1.04 with the Streamybox theme); UI-thread transform only |
| Button / chip focus | no lift | timed lift (same clamp) |
| Focus ring | step at focus 0.5 | fades in with the lift, leaves the card at once (only the focused card ever shows one) |
| Focus glow (blurred box-shadow) | off | off (expensive on Mali) |
| Press feedback | off | on (pressed scale) |
| Sheets, dialogs, toasts, screen transitions, player overlay fades, Bühne copy fade | jumped | animate normally |
| Ambient / blurred backdrop | plain room colour | plain room colour |
| Skeleton pulse | static | static |
| Card artwork fade-in | none | none |
| Home banner | static lead title, never followed focus | follows focus only after it rested 400 ms; the backdrop fades in (250 ms, one image view), the copy fades 0.4 → 1 |
| Home rows | virtualized FlatList, row jumps (no scroll animation) | same list and order, one native smooth scroll per vertical move; no stage, no row lift, no reordering |
| Row (horizontal) scroll | jump | smooth (measured: no difference beyond noise, see below) |
| Phone / tablet with lite forced on | lite cards, static backdrop | lite cards (phone card scale is 1, so ring only), static backdrop; LiteHome stays TV-only |

Implementation: `client/src/performance/motion-policy.ts` (`motionPolicy(lite, systemReduced)`, `useMotionPolicy()`,
`LITE_CARD_SCALE`, `LITE_HERO_REST_MS`) decides per effect; `motion-config.tsx` (`MotionConfig`, was `LiteMotion`)
mounts `ReducedMotionConfig Always` only for removed system animations. Consumers: `FocusLift` (focusable.tsx),
`LiteCard` (now uses `FocusLift`), `Shelf` (lite focus room for the 1.06 lift, `scrollAnimationEnabled`), `Skeleton`,
`Artwork` (`transition` prop), `AmbientBackdrop`, `LiteHome`/`LiteHero`, `FeaturedStore.restDelay()` (replaces
`freeze()`).

## Stale ring after quick moves (the "duration 0" workaround in 518a931)

- Not reproducible on the emulator: with the old lite code, the global reduced motion removed and real 160 ms timings
  restored, eight rapid 8-key bursts never left a second ring (frames there are cheap enough). The previous agent's
  stash (`stash@{0}` "unfinished switch away from global ReducedMotionConfig") shows it saw the stale ring exactly in
  that combination and then forced duration 0.
- Mechanism (from the code): the lite ring was a step function of the eased focus value (`focus > 0.5 ? 1 : 0`,
  `LiteRing`). On blur the value fades 1 → 0 over 160 ms, so the card being left keeps a full ring until the fade passes
  its midpoint. On a box that drops frames this shows as several frames with two rings — and with quick presses one
  trailing ring per press. Duration 0 hid it by removing the fade, together with every focus animation.
- Fix: `Focusable` now publishes two values: `focus` (eased, `withTiming` from the current value — a new press cancels
  the running animation) and `focused` (0/1, set without animation on focus/blur, hidden under overlays like `focus`).
  In lite, `ringStrength(focus, focused, hover, instantOut)` draws the ring only while `focused` is 1 (fading in with
  `focus`) and drops it the moment focus leaves; the lift is `timedLift(focus, …)`, a pure function of the eased value,
  so it cannot overshoot or keep a stale target. The full UI keeps its fade-out and spring unchanged.
- Test: `src/components/__tests__/focus-lite.test.tsx` runs Focusable/FocusLift against a clocked Reanimated stand-in
  (persistent shared values, linear `withTiming` in time): four presses 40 ms apart against 160 ms fades → exactly one
  lit ring at every sampled frame, the lift is mid-way after 80 ms and settles at 1.06, no glow. Mutation
  `ringInstantOut: false` fails it (trailing rings).

## Measurements (Android TV emulator, relative only)

Setup: `emulator-5562` (`sdk_google_atv64_arm64`, API 34, 1920×1080, AVD sbx_tv_apps), installed debug dev-client
(2026-10-23) loading a Metro bundle with `--no-dev --minify` (JS dev=false; no new native build needed — no native
changes). Backend: Dev World from this tree on 41650 (`adb reverse tcp:41600 tcp:41650` because the app's account
points at 127.0.0.1:41600; restored afterwards). Per run: force-stop, launch, 16 s settle, `dumpsys gfxinfo reset`,
D-pad 20× RIGHT, 6× DOWN, 20× RIGHT, 8× UP (120 ms between presses, ≈ 30 effective moves), `dumpsys gfxinfo`.
Old lite vs new lite vs new lite without row-scroll animation were interleaved over 3 rounds × 2 runs (old code via
`git show HEAD` copy of `src`). Host load average ≈ 12 (other emulators/agents): single runs vary a lot, medians below.
Scripts: `/tmp/lite2/run.sh`, `rounds.sh`, `summ.py` (not committed).

| Config | runs | frames | janky frames | p50 | p90 | p95 | p99 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| old lite (no motion) | 6 | 30 | 16 (53 %) | 17 ms | 19 ms | 22 ms | 32 ms |
| new lite | 6 | 206 | 43 (22 %) | 28 ms | 50 ms | 61 ms | 97 ms |
| new lite, rows jump (`rowScroll` off) | 6 | 194 | 32 (17 %) | 28 ms | 48 ms | 57 ms | 67 ms |
| full mode (old code) | 3 | 132 | 131 (99 %) | 150 ms | 250 ms | 300 ms | 300 ms |
| full mode (new code, later, lower load) | 3 | 171 | 133 (77 %) | 65 ms | 101 ms | 113 ms | 133 ms |

Reading: old lite drew about one frame per press because nothing moved; its low percentiles are "nothing animated", not
"smooth animation". New lite animates (~7× the frames) and keeps ~80 % of them on time on this emulator; the full Home
misses nearly every frame here (stage moves, hero crossfades, blur, glow). The row-scroll animation made no difference
beyond run-to-run noise (p90 range 34–85 vs 34–113 ms), so it stays on. The emulator's GPU is emulated and the host was
loaded: absolute numbers say nothing about the ROCK 4D; only the ordering (full ≫ new lite > old lite in cost) is solid.

## Verification

- `npm run typecheck` clean; `npm run lint` clean.
- Full jest: 200 suites, 2218 tests — 2216 passed, 2 failed (`src/player/__tests__/tab-guard.test.tsx`, the two known
  pre-existing failures on origin/main).
- New tests: `src/performance/__tests__/motion-policy.test.tsx` (effects per mode, system-reduced wins, MotionConfig
  renders nothing while animations run), `motion-config-off.test.tsx` (animatorScale 0 → `ReducedMotionConfig
  always`), `src/components/__tests__/focus-lite.test.tsx` (rapid moves, lift, no glow; full mode spring + glow),
  `src/screens/home/__tests__/lite-home.test.tsx` (TV + lite: row order unchanged, banner keeps the lead title through
  quick presses and changes 400 ms after focus rests — mutation 150 ms fails it; service status banner and My List tab
  on LiteHome), `src/screens/settings/__tests__/performance-strings.test.ts` (de/en texts).
- Emulator: lite Home with a lifted card, a lower row, rapid-move sheet (one ring per frame), D-pad recording, full Home
  and the Settings section with the new texts (`docs/client/screenshots/LITE2/`):
  `tv-lite-home-focus.jpg`, `tv-lite-home-row3-focus.jpg`, `tv-lite-rapid-moves-sheet.jpg`,
  `tv-lite-home-dpad.mp4` (8.8 s, 960 px) + `tv-lite-home-dpad.gif` (480 px), `tv-full-home-focus.jpg`,
  `tv-settings-performance-de.jpg`.

## Texts

`settings.performance.hint` de "Ruhigere Startseite und sparsamere Effekte für langsamere TV-Boxen. Fokus- und
Menüanimationen bleiben." / en "A calmer Home and lighter effects for slower TV boxes. Focus and menu animations stay.";
`stateOn` "An: ruhige Startseite, sparsame Effekte" / "On: calm Home, light effects"; `stateOff` "Aus: volle Startseite
mit allen Effekten" / "Off: full Home with all effects".

## Only verifiable on the ROCK 4D

- Frame pacing of the timed lift, ring fade, banner fade and smooth row scroll on the Mali-G52 (`adb shell dumpsys
  gfxinfo dev.streamarr.app reset`, same D-pad script, lite vs. Aus). If row scrolling janks there, set `rowScroll` to
  `!systemReduced && !lite` in `motion-policy.ts` (one line, rows jump again).
- Rapid D-pad presses: never a second ring (the original stale-ring report came from the box).
- Sheets, dialogs, page transitions and the player overlay animate again in lite: check they stay smooth with a video
  decoding (HEVC/4K) behind the overlay.
- The banner fade (expo-image `transition` with `recyclingKey`: the new backdrop fades in from the surface colour)
  feels calm, and the 400 ms rest is right for the remote's key repeat.
- System animations off on the box → everything reduced (Settings shows "Automatisch: an (Systemanimationen sind aus)").

## Notes for the next task

- `useMotionPolicy()` is the one place for new lite decisions; avoid `useLiteMode()` for motion.
- `useFocusState()` now also returns `focused` (0/1 without animation).
- Emulator 5562 is left with lite "An", logged in as anna on the (now stopped) 41650 Dev World; the reverse for 41600
  points back at 41600.

## Follow-up: cards showing through the rail

- Report (coordinator): in `tv-lite-home-row3-focus.jpg` the card scrolled past the left edge (Big Buck Bunny) was
  drawn under the semi-transparent rail, its title fragment over the rail.
- Cause: TV rows are full-bleed (`Shelf`'s horizontal FlatList spans the screen, `paddingLeft` = gutter incl. the
  rail inset); the rail is translucent glass on top, so whatever scrolled left of the gutter showed through it. Not
  lite-specific: full mode and the old lite showed the same (emulator, full mode before the fix).
- Fix (`client/src/components/media/shelf.tsx`): on TV under the rail (`design.inset > 0`) the list gets
  `marginLeft = gutter − min(focus room, card gap)` and the padding/`getItemLayout`/`snapToItemPadding` shrink by the
  same amount, so the ScrollView's own clip ends just before the first card. Cards stay where they were, the first
  card's lift/ring/glow keep their room, the peeking card on the right is unchanged. No extra views, no blur.
- Test: `tv-focus.test.tsx` "under the rail the row is clipped just before the first card". Emulator: full and lite
  row screenshots clean; `tv-lite-home-row3-focus.jpg` retaken. typecheck/lint clean; affected suites 39/432 passed.
