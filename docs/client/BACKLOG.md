# Streamarr Client — backlog

Consolidated from the journals (M1.5 … B1). Triaged in F1 (2026-09-30) and again in F11 (2026-10-06): every earlier
entry is either still open below (with the reason it stays) or listed under "Fixed" with the task that fixed it. The
journals hold the evidence.

## Decisions for the user

- None open. Decided 2026-10-02: forced subtitles follow the audio language; phones resume the last played version
  (PLAN.md section 5, implemented in F7 S4). Round G decisions are in PLAN.md section 2. F11 recorded one design
  decision itself (focus gaps on web/tablet, see Fixed).

## Needs Xcode (pending-ios)

- Apple TV (I4): VLCKit works on tvOS (H.264 MKV direct over VLC, AC3 5.1 + forced ASS tracks, remote keys, release;
  sim), but tvOS versions stay native-only (no VLC hints): HEVC/AV1/MPEG-2 software decoding through VLC on a real
  Apple TV is unchecked. Check on hardware, then add `tvos` to `VLC_HINT_PLATFORMS` (player/device-profile.ts; still
  absent in F11).
- Apple TV (I4), standing rule rather than a bug: a JS-initiated pop inside a tab stack (`navigation.goBack()`/`POP`/
  `POP_TO`) leaves the native stack at its root when a page below was pushed by a deep link (react-native-screens skips
  its controller as removed); Menu (a native pop) is fine. Deep links now pop natively (tv-native `popToScreen`); any
  future JS back in a tvOS tab stack must use the same path or be checked live.
- Apple TV dev builds (I4 S4): a Metro reload can crash in expo-modules-core `ExpoFabricView.injectInitializer`
  (AppContextLost) while a TVFocusHost view mounts during the reload; dev-only, seen once. (The "deep link while the
  player is open closes the player" half was handled in I4.)
- F5: the Apple HLS validator (`mediastreamvalidator`) was still not run on the audio-rendition master (needs Apple's
  HLS tools; also listed under Server for the server-side group).
- iPadOS window controls: the inset in a resized window is a fixed 30 pt (iPadOS 27 simulator); a native layout-region
  read would be exact.

## Needs real hardware

Grouped by device. None of these can be closed from code or an emulator.

**Android phone (a real one, or a release build)**
- P3 (reopened in F12 follow-up, verify F11-1): a keyboard that comes up late (slow device, IME switch) leaves "Sign in"
  half covered; the screen scrolls only partly (F9.md:474). `auth-scaffold.tsx` is unchanged since F9. Check on a real
  phone with a slow IME.
- F5: in-session audio switch on the phone not done: the dev build ANRs right after the player starts on the 2 GB
  `Streamarr_Phone` AVD (Google TV covered ExoPlayer); R1 played on a release phone build but did not switch audio.
- Phone blur cost: the software-GL AVD shows RenderThread ~84 % with the blurred ambient (R1 still an AVD number).
- Accounts (F4 slice 2): ANRs on the two-step setup screen (QR + secret) under host memory pressure; likely dev-only
  (R1 release builds had no ANR at ⅓ of the memory) — re-run the QR/Glass screen once on a release build.

**Android TV (ideally a 2 GB device)**
- HEVC Main10 / HDR10 / Dolby Vision decode and HDR display modes; AC-3 / E-AC-3 / DTS / TrueHD passthrough; 4K on a TV SoC.
- VLC: direct rendering (zero copy, black on emulators), first-seek latency in MKV (2.7–7.3 s on emulators), HDR output
  (the TextureView cannot carry HDR), stall watchdog on a real stall (F10 S7 added the DR black check and the shared
  watchdog for VLC; jest-only so far).
- Hold-scrub tiers 30/60/120 s on a real remote (emulator sends one repeat; unit-tested).
- TV: returning to Home from the profile picker shows a 1–2 s frame of lifted rows over the hero copy (slow emulator;
  not re-checked).
- TLS failure message against a real self-signed server (F10 classifies it as T1 `tls_error`); TV keyboards other
  than Gboard.

**iPhone / iPad**
- P3 (reopened in F12 follow-up, verify F11-1): the large title on Search shrinking on scroll was never shown live; F9
  showed it on Settings only and called Search "same structure" (F9.md:293). Check on an iPhone with a real library.
- HEVC/HDR/Dolby Vision media caps, PiP start, AirPlay picker, iPad pointer hover (`modules/pointer-events` ->
  `Focusable` onPointerEnter) and hardware-key hold-repeat (unit-tested only).
- iPhone (I1 verify): BBB WEB-DL direct play showed frame 0 for ~45 s while the clock ran until a seek (loaded host);
  not reproduced since I2's StartSeek fix (F10's start cover may now hide it); watch for it on hardware.
- iPhone simulator (F9 S2b, Q1-48): first launch after a simulator boot drew the picker sideways once (1 of 3 cold
  starts; splash already rotated, so native/UIKit before JS). Not reproducible on demand; re-check on hardware.

**Apple TV**
- Siri Remote touch surface (swipe scrubbing, clickpad), AVPlayer HDR10/Dolby Vision output and HEVC hardware decode
  (the simulator reports H.264-only SDR), top shelf, audio passthrough (I3).

## Player

- F5/F10: the native engines' in-session error path (rendition 404/500 -> `/switch`, 8 s timeout) is unit-tested only.
  The missing pieces now exist: B12 fault switches (`split_abort`/`seg_status` on an audio rendition) and F10 S6s
  native `loadError {uri, trackType, status}`; force it live once on Exo and AVPlayer (F10 S9 live audit).
- expo-video on Android shows "—" for decoder and dropped frames in Info: the F10 S6 probe already returns
  `droppedBufferCount` (watchdog only); map it into `stats.droppedFrames` in `expo-video-engine.tsx` (native builder's
  file). Decoder names stay unexposed; AVPlayer has no drop counts.
- Google TV (F8 S4b): a Back pressed within ~0.5 s after a side panel closed is dropped natively (RN Modal dismissal).
  F8 V2 item 5 passed with Back + Back 200 ms later, so re-run it once on the AVD to close it or reproduce it.

- F13 (Q2-02): subtitles are not lifted above the control bar on native players while the overlay shows (Google TV,
  Apple TV, phones). expo-video has no subtitle position API in JS; libVLC reads its subtitle margin only at media
  open (changing it would reload). Needs a native inset in the expo-video patch (AVPlayerLayer/PlayerView subtitle
  view padding) and a libVLC renderer option; web is fixed (cues lifted while the controls show).

## Browse, navigation and UX

- Android phone (F8 S4b): on a genre switch that has to fetch, the grid was seen blank (no skeleton) until data or the
  error card arrived (~4 s offline). F11: the JS already renders `library-loading` on such a switch (screen test
  "Android phone: a genre switch that has to fetch shows the skeleton grid" passes on the unchanged code), so the blank
  is Android layout (FlatList offset/ListEmptyComponent after the old rows unmount?). Re-check live on the phone AVD.
- iPad (F7): Split View / Stage Manager widths not checked live (needs Mac UI input in the simulator); the narrow rule
  is covered by web 1024×900 and a jest test at 820 pt.
- Apple TV (F8 verify V2): once, Up right after Down kept focus on the player's seek bar (not reproduced). The other
  half of this entry (focus on the "Start" tab after the played title left Home) is fixed in F12.

## Accounts

- Auth residual (F8 S6, P3): if the Keystore *write* of a rotated pair fails, the app uses the pair from memory
  (S3), which confirms the rotation on the server; if the app is then killed before the throttled retry stores it,
  the next launch presents the previous token and B9 revokes the session for reuse ("Signed out for your
  security"). Needs a failed write plus a kill within the retry window; no client-only fix without the vault.

## Tests and tooling

- **R1 release builds (2026-10-05):**
  - Android release startup abort, 1 of 13 phone cold starts (not reproduced in 10 more): SIGABRT on mqt_v_js,
    `[runtime not ready]: Exception in HostFunction: The current activity is no longer available` at the first native call
    (`expo-modules-core NativeModulesProxy` ← `expo/src/Expo.fx`). Library-level startup race → watch on real hardware;
    upstream issue if it repeats. Stack in journal/R1.md.
  - Reanimated `synchronouslyUpdateUIProps … Unable to find SurfaceMountingManager`: fixed in code in F12 (see Fixed);
    confirm in Q2 on a release build that the log is gone at player close (Google TV) and on the phone R8 build.
  - R8 + resource shrinking: APK 105.1 → 94.3 MB, dex 49.6 → 18.3 MB, smoke (start, session, Home, detail, play) passes, but
    detail push measured 25 s vs 3.4 s → re-measure with a non-polling timer before enabling it in app.config.
  - Release APK is 105 MB for arm64 alone (libvlc.so 52.5 MB): consider VLC as a separate download or ABI splits.
- Dev only: after a JS reload nothing is focused on TV until the first D-pad press; the dev client can start with a
  cached bundle.
- Android TV and phone AVD boot snapshots hold an ended anna session (cause proven in F8 S6: a snapshot boot restores
  the app storage of 2026-10-01, the server deleted that session since -> 401 `refresh_session_expired`). Tooling
  action left: re-save `default_boot` after a fresh sign-in, or always cold-boot (`-no-snapshot-load`).
- Google TV AVD (F5 verify): with the Metro debugger attached the dev build's JS stalls (~980 MB of 2 GB); one Fabric
  SIGSEGV at sign-in, probably from an "rr" dev reload during adb text input. Prefer argent paste for passwords.
- F4 verify: `url-cache-module.test.ts` only greps the Objective-C source (T1: not feasible in jest); a native
  smoke/Cache.db check in CI would be real coverage. The F4 slice 3 note "the cached tvOS app lacks url-cache" was
  never re-checked against the I4 tvOS build.
- T1 verify: a failing controller test can leave an open handle so jest hangs after the failure (needs --forceExit);
  one failure also cascades into later tests of controller.test.ts.
- T1 verify: `audioTracks?.length ?? 2` (unknown track count) is still repeated three times in controller.ts (left
  alone in F11: the native builder owns controller.ts this round); the single-audio release set
  (`audio-preference.ts`) is module-global with no reset (test hygiene only).
- T1: assets/brand/render.sh needs python3 + Pillow (denoise.py); not checked by any script.
- TV sign-in: adb text input into the TV sign-in field does not arrive (test tooling; real keyboards untested).
- Headless Chrome for Testing 131 draws bands through glass in screenshots; use --disable-gpu for captures (F3).
- ProviderSpeedTesterTests.SpeedTest_AutomaticallyDiscoversAndTransfersARecentArticle failed again under full-suite
  load in the B18 follow-up (Assert.True; 3/3 alone), second sighting after B14.
- B17 full run: ArtworkPaletteServiceTests.AFullQueue_OverflowsWithoutLosingOrDuplicatingImages failed once under
  full-suite load, 6/6 alone (artwork queue timing).

## Server (backend track)

- B19 verify (non-blocking): `release_not_found` `reason: otherTitle` vs `unknown` tells a viewer whether an id they
  already hold belongs to some title, also an age-blocked one (not exploitable: SHA-256 ids, title unnamed, nothing
  plays; answer `unknown` when the owning work is gated for that viewer); Dev World PlaybackMap never clears
  `error`/`errorReleaseId` after a later error-free answer; the "same release minutes later" test is a regression guard
  only; the B17 own-seek test has ~0.6 s margin above its 3 s limit.
- B17 verify leftovers (not felt by a viewer, recorded by B18): requests over the per-IP refresh budget each cost one
  indexed read-only DB query; a disabled account's live session passes the address gate and then gets 401 (per-token
  limit still applies); restart pacing is per session (two players seeking at once share the burst of 2);
  `transcode_slow` with `mode: always` never writes a segment after a seek restart (`-readrate` + input seek inside the
  fault fixture, not the product); contract_check reports 67 checks on some instances and 73 on others (instance
  content, 0 failures everywhere).
- B18: progressive (repair-while-streaming) admission needs the repair plan's first damaged byte at resolve time, so a
  release's very first playback always waits in `repairing`; only a playback started while that repair runs plays at
  once. A repair started by a hole met *during* play is not reproducible on Dev World (its small files are read ahead
  or materialized at start). The server keeps articles it read in its segment cache, so a Dev World release repairs
  once per instance.

- Audio renditions: `mediastreamvalidator` never run (Apple HLS tools not installed; ffprobe + hlssim instead); rendition
  segments ignore byte ranges like video; a group stays mixed only when every rendition is copied FLAC/Opus/MP3
  (B6, narrowed in B8).
- Dev World has no HLG or Dolby Vision source and its ffmpeg has no zscale: HLG/DV tagging is covered by unit tests only,
  and the Dev World HDR10 -> SDR transcode is untone-mapped (washed out, tagged BT.709) (B6).
- B6 verify: the SDR tag chain after `hwupload` on VAAPI/QSV is untested on real hardware; one Core test flaked once
  in a full run.
- Art highlight is measured over the whole backdrop; add per-region values (right panel, left rail) if the client finds
  the whole-image value too strict.
- B8 verify: a replay is only detected when a report of the completing playback lands below 5 %; ~~the client must send
  a report at position 0 when it replays (check `controller.replay()` in F8/F9).~~ → F8 S1: `replay()` reports 0 (F11 triage). The group conversion reuses the
  `audio_converted` reason code. ~~The long-season series (The Lighthouse Logs) has no artwork.~~ → B10: generated artwork.
- ~~Username and e-mail of one account share the sign-in code cooldown, so someone who knows both can link them (429 on
  the second alias within 30 s); documented, low impact (B4 verify).~~ → B10: the other alias answers 202 without a mail.
- Dev World artwork uses fixed per-language URLs; the real selection rule is covered by `TmdbDiscoverTests` only. No
  German logos in the Dev World (TMDB has none for the fixture titles).

## Server findings from client verifies

- B9 verify: on the very first fetch an episode whose versions were never looked up is `available: true` (optimistic,
  queued for the warm-up) while the series page may already know false; ~~a previous-token replay does not check
  `IsDisabled` (moot today: disabling revokes sessions); the retired-hash lookup scans ViewerSessions for unknown tokens~~
  → B14: replay checks IsDisabled, the tombstone PK lookup runs before the retired-hash scan;
  continue watching loads every resumable row of a viewer before the limit.
- ~~Server tests (B9): ReleaseContainerStoreTests.Store_EvictsTheLeastRecentlyUsed_AndSurvivesARestart and
  RepairConcurrencyTests flake under load (timing of background writers); green on reruns.~~ → B14: the store drains its
  queued writes on stop + `Loaded` (20/20 under load); repair success is counted before waiters resume. ~~RepairConcurrencyTests
  still fails ~1 in 5 for a product race (one of 56 readers gets 500 UsenetArticleNotFoundException)~~ → B16: a cancelled
  reader's article loss invalidated the shared capability session before the repair admission had registered the release;
  cancelled readers now end as cancelled and admissions in flight count as active repair (50/50 under load).

- B10 verify: sign-in code responses still differ by well under a millisecond on loopback (known first send ~1.0 ms,
  linked alias ~0.6 ms, unknown ~0.4 ms; status/body/headers identical, 5 tries per hour per login; the known/unknown
  gap predates B10); `logoUrl` and cast `profileUrl` have no size classes; generated `ArtworkSizesDto` fields are
  `string | null` although always set (repo-wide nullability convention).
- ~~Server tests (B10 verify): HealthCheckerTests.Concurrency_UsesConfiguredProviderBudget flakes under full-suite load.~~
  → B14: the fake holds STATs until the budget is reached (bounded), 20/20 under load.

- ~~B11 verify: `POST /viewer/auth/refresh` has no rate limit (predates B11) and every refusal now logs a line, so an
  anonymous caller can flood the in-memory log feed; an unknown token runs a LIKE scan over retired hashes before the
  tombstone lookup (B9 code); account deletion writes tombstones outside the session lock (a racing refresh can answer
  `unknown`)~~ → B14 (60/min per IP, 10/min per token, 429 + Retry-After, aggregated log lines); the hourly
  ViewerSessionCleanup job has no unit test of its own (verified live).

- B12 verify (Dev World only): ~~`POST /devworld/faults` answers 500 instead of 400 for a numeric `params.mode` or a
  fractional `ttlSeconds`; the `transcode_kill` smoke only checks the kill, not the next-segment 500 and restart; spent
  once/count faults stay listed until TTL or clear~~ → B14; with nothing armed playlists and API answers now carry
  `Content-Length` (bodies identical); the contract check runs 65-71 checks depending on server state.

- B13 verify: ~~no automated test for `Retry-After` on `segment_evicted`, the WebVTT wait cap or the 25 s budget across
  restarts~~ → B14 (TranscodeWaitTests; `segment_evicted` via the extracted response helper, the race stays live-only);
  ~~two requests competing on one transcode session keep restarting the run and the loser gets `503 segment_unavailable`~~
  → B16: the newer position keeps the run, the other waits (2 restarts instead of 50 live); ~~`stop` + `playbackAlive: true`
  undocumented; `transcode_slow` does not slow remux runs~~ → B14.

- ~~B13b verify: when a start is replaced, the old start's late remux session is closed only when the playback ends;
  doc comment on StartTimeout(); switch_under_fault params.how; README start_hang~~ → B14: switch/stop cancel the old
  start (no late session, no slot; robustness check `superseded_start`).
- ~~**B14 finding (high, server, pre-existing): on macOS/.NET 8 `Process.Start` blocks while any child process is
  SIGSTOPped.**~~ → B16: the throttle parks runs (ends ffmpeg, resumes at the parked front) instead of SIGSTOP; mechanism
  (SIGCHLD handler spins on stopped children while holding the process-start lock) in journal/B16.md. The transcode throttle pauses ffmpeg with SIGSTOP, so while one session is paused every new ffmpeg/ffprobe
  spawn waits until that run is resumed or killed: a unit probe blocked 586 s; live on 39310 a second start (same or
  another title, another viewer) sat in `planning`/`resolving` for 40 s+ while a first remux was paused. This was the real
  cause of the B13b "late session" and very likely of the client's unexplained long `starting` on 39300. Fix idea:
  pause without SIGSTOP (stop reading / -readrate), or SIGCONT paused runs around each spawn; check Linux too.
- Server tests (B14 full run): ProviderSpeedTesterTests.SpeedTest_AutomaticallyDiscoversAndTransfersARecentArticle failed
  once under full-suite load (Assert.True), 3/3 alone.

## Next update (out of scope)

- Offline downloads of series and movies on phones and tablets.

## Fixed

- B17 (2026-10-06): B14-B16 verify follow-ups. A throttle-parked run keeps its slot while its player is active, so
  its resume never answers `503 remux_capacity`/`transcode_capacity` (new starts are refused instead); a live
  session's refresh token passes the per-IP refresh budget, which now counts only failed refreshes; players are told
  apart by a `?p=N` playlist tag (else address + User-Agent), so one player's own far seek and back answers at once
  (~0.4 s) while two players still do not ping-pong; a transcode resume continues the previous segment exactly (no
  repeated frame, no audio overlap); error answers on unknown transcode sessions skip the playback scan; nits
  (ProcessRunner doc comment, Dev World limiter log level, `fault` 400 messages, `usenet_hole` restores its releases).
  Fix round 1: a lapsed reservation never revives on later access (its resume competes like a new start); request
  restarts of a session are paced (burst of 2, then 1/s).

- B19 (2026-10-07): "release ids that played minutes ago answer release_not_found" was a client mix-up (the play
  screen sent the previous title's releaseId, see Player); ids stay resolvable (14 min live probe, catalog refresh).
  `release_not_found` now says why (`params.reason`: `otherTitle` | `unknown`); Dev World `/devworld/playbacks` lists a
  failed start's `error` and `errorReleaseId`.

- B18 (2026-10-06): during play the playback GET follows the release's live repair job (moving states, then a sticky
  ready/failed/cancelled/evicted) instead of the resolve-time snapshot (F10 code review 7, P2-4); a fallback to another
  release no longer carries the old release's repair. Dev World publishes real PAR2 recovery for three releases and
  runs progressive repair, so the repair path is testable live (robustness `live_repair`).

- B19 client half (2026-10-07, F10 S4z2): the play screen derives the requested version per route (workId +
  releaseId) instead of freezing the first params, so a deep link to another title no longer sends the previous
  title's releaseId; a `release_not_found` with `reason: otherTitle` restarts once without a version, silently.

- F12 (2026-10-06), each with a test that fails without the fix:
  - R1 release logs `synchronouslyUpdateUIProps failed … Unable to find SurfaceMountingManager` (90× at player close,
    640× for one tag on the phone R8 build): the only endless animations in the app are the Reanimated 4 CSS loops of
    `Spinner` (rotation) and `Skeleton` (pulse); nothing stopped them before their screen's surface went. Both now ask
    `useLoaderMotion()` (loader-motion.ts), which stops them at the screen's blur (a close starts with it); no
    `withRepeat`/frame callback exists. Guards: loader-motion.test (blur stops, focus resumes, unmount unsubscribes)
    and a static check that every `animationIterationCount: 'infinite'`/`withRepeat` in src goes through the hook or a
    `cancelAnimation`. Likely source of the 90×: the player's status/"Switching…" spinner; of the 640× for one tag: a
    poster `Skeleton` of a Library/Home grid left loading when its tab was detached (Q2 confirms on a release build).
  - Web/Safari two tabs playing on one browser (F8 S4b): `player/tab-guard.ts` — a start or resume in one tab tells the
    others (BroadcastChannel, else `storage` events), which pause with the notice "Wiedergabe in einem anderen Tab
    gestartet, deshalb hier pausiert …" (`notice.otherTab`, catalogue N20); no server change; tab-guard tests with a
    fake channel.
  - Apple TV focus on the "Start" tab after the player when the played title left Home: the I4 return now falls back
    to the screen's preferred target (`usePreferredFocus`, Home: the hero's main button) when the remembered card is
    gone, never to the bare guide; screen-focus.test "the played card left the screen …".

- F11 (2026-10-06), fixed in F11 with a test each:
  - Web Library: a genre/sort change pushed a history entry and kept the previous Library screen mounted (21 after 21
    clicks) → `applyLibraryFilter()` (library-back.ts) replaces the params on every platform (expo-router `setParams`:
    the URL keeps the filter for a reload, Back leaves the Library); library-filter.test.ts.
  - Onboarding: the server step reached while a profile is signed in had no "Zurück zur App" → `server-back-to-app`
    like the sign-in step (`enterApp`); onboarding-q1 "the server step reached while a profile is signed in …".
  - iPhone Safari video full screen (`webkitEnterFullscreen`) leave path untested (F8 verify V2) → two
    fullscreen-exit.test cases (close leaves the video full screen; after the system Done the close leaves it alone).
  - Decision: `useFocusGap` stays on web and tablets (keyboard `:focus-visible` on web and iPad keyboard/pointer focus
    draw the same, smaller ring; genre chips 8 → 12 px, panel options 4 → 9 px), phones keep their design gaps;
    pinned in focus-clearance.test.ts.
- F11 triage (2026-10-06): fixed earlier, evidence checked in code/tests/journals:
  - TV Filme genre scroller ended 8 pt before the sort control → F8 S1: `trailingGap = useFocusGap(space.md)`
    (genre-row.tsx), focus-gap-rows.test "genre scroller before the Apple TV sort control", live ~30 px (F8.md:140).
  - TV versions-loading flip (Play + Versions → "No versions yet") → F8 S1: Versions only after load, the main button
    keeps its Focusable (title-actions.tsx; F8.md:175, 196).
  - Google TV stage pill "Season 3 · Episode" without the number → F8 S1: `numberOfLines={1}` + key per label
    (F8.md:176, 197).
  - TV detail deep link kept the previous page's focused slot → F8 S1: detail routes keyed by id
    (`<MovieScreen key={id} />`, `<SeriesScreen key={id} />`); live on Apple TV (F8.md:140).
  - TV long-season strip position → F8 S2: live "Lighthouse strip, focused E21 card at x ≈ 552" (F8.md:177, 511).
  - Web Escape / Alt+Left for the detail BackControl → F9 S1: `isWebBackKey` (navigation/back-control.tsx:101),
    back-control.test; live "real Escape on ToS → Home" (Alt+Left on Windows/Linux Chrome untested, F9.md:436).
  - iPad Safari: closing the player left element full screen → F8 S3: `useEffect(() => exitPlayerFullscreen, [])`
    (play-screen.tsx:162), fullscreen-exit.test; live on iPad Safari (F8.md:411-416).
  - iPhone Safari: a pause from the system full-screen controls not reflected → F8 S3/S4b: `userPlayback` adoption
    (web-engine-player.test "reports a pause and a resume from the system full-screen controls"); live in F8 V2.
  - Android phone: Sign in button half under the keyboard → F9 (Q1-34): live V2 "'Sign in' fully above the keyboard".
    The late-keyboard residual was reopened in F12 follow-up (see "Needs real hardware: Android phone").
  - iOS NativeTabs accessibility labels kept the old language → F9: label passed explicitly (native-tabs-shell.tsx);
    S2b "AX labels follow EN/DE live"; Settings large title collapses (F9 V2). The Search half of the large-title
    entry was reopened in F12 follow-up (see "Needs real hardware: iPhone / iPad").
  - iOS: a sign-in deep link while signed in had no way back → F9 (Q1-09): `sign-in-back-to-app`
    (sign-in-screen.tsx, onboarding-q1 test); live on iPhone S2b.
  - Web: a second tab overwrote an edited display name → T1: `useEffectEvent` in use-profile-sync.ts,
    profile-sync.test "does not write a tab's older /viewer/me answer" (T1.md:50-58).
  - Brand PNGs large (icon 554 KB, top shelf 2.2–2.6 MB) → T1: `assets/brand/denoise.py`, icon 541 → 76 KB, top
    shelf 2204 → 224 KB, total 7.9 → 0.93 MB (T1.md:64-65).
  - iPhone: first player close after a fresh boot stayed landscape → F8 S2: `lockPlayerLandscape` waits for a portrait
    window before unlocking; orientation.test race cases (F8.md:237).
  - Player: up-next countdown ran while paused → F10 S3: `if (paused) return;` (up-next.tsx:76), matrix E row.
  - F5: Safari's forced subtitle (`kind: "forced"`) missing in the panel → F8 S3: accepted in web-engine.web.tsx;
    live on iPhone Safari (F8 S4b, V2).
  - F8 verify V2: Mobile Safari first tap toggled playback → F10 S3 (`player/surface-tap.ts`); the overlay stayed
    hidden after leaving the system full screen paused → F10 S3 (overlay shows on `paused`); signing out or in again
    while the vault read fails threw → F8 S7 (storage-failure-sign-out tests).
  - F5 verify: no test for the engine-error → `/switch` fallback nor NAME-first track matching → T1 (mutations M1/M2
    caught, T1.md:12-16); `controller.audioSwitches` unbounded → T1 `AUDIO_SWITCH_SAMPLES = 20`; three-line doc
    comment in audio-renditions.ts → T1; remembered language sent for single-audio titles → T1
    (audio-preference.ts; the first start of a release still sends it by decision, T1.md:88).
  - F6 verify: focus-clearance checked tokens only → T1 `src/__tests__/focus-gap-rows.test.tsx` per primitive (action
    row, season chips, genre chips, language chips); `PHONE_HEADER_HEIGHT` duplicate in phone-detail.tsx → T1 (imported
    from back-control).
  - T1 verify: testID `stage-actions` existed only for a test → moot: R1's uiautomator timing polls it too (R1.md:242).
  - HeroFade without a masked-view fallback → moot since I1: every iOS/tvOS build links RNCMaskedView (I1.md:23).
  - Memory: Home ~520 MB native in the dev build → R1: release Home PSS 263 MB on Google TV, 262–269 MB on the phone.
  - Google TV dev client crash on the first deep link after a snapshot boot, and the LogBox "state update on a
    component that hasn't mounted yet" at Home start → R1: dev-client only, release cold/warm links and 16 cold starts
    clean (R1.md:123, 329, 331).
  - Android TV: a detail pop took ~5 s and anna's session ended between runs → R1: release pop 3.4–3.7 s; the session
    loss is the AVD snapshot (F8 S6 proof); the snapshot tooling item stays under Tests and tooling.
  - B8 verify "the client must report position 0 on replay" → F8 S1: `replay()` reports progress 0 (controller.ts),
    mutation M15; live as Q1-47.
  - Accounts: the "DONE in I4 / F4 slice 2 / F4 slice 3" bullets that sat in the open Accounts section are history
    (I4: Apple TV sheets/Menu/focus and deep links; F4 slice 3: NSURLCache off on iOS; F4 slice 2: profile editing,
    translated sign-in methods, atomic sign-out of others, live e-mail cooldown) — the details are in I4.md and F4.md.

- B8 (2026-10-04): replay inside the completing playback keeps a resume point (report back below the minimum resume
  percentage = new viewing; later reports of the completing playback still ignored); one remux audio group codec per
  device and title (fewest conversions, ties to the lowest source index) at start, any audioLanguage and after
  `/switch`, labels = delivered channels (2-ch devices get a real AC-3 2.0 downmix); viewer sessions store null instead
  of "Unknown device" (migration clears old rows); display name of only spaces -> 400; B7 verify leftovers; HDR10 BBB
  videoRange checked (PQ when not transcoded, SDR transcode by contract; e2e guard); Dev World long season
  (The Lighthouse Logs, 26 episodes, tmdb-tv-990001).

- F5: in-session audio rendition switch on web, Safari, ExoPlayer and AVPlayer with `/switch` fallback; ExoPlayer kept
  old audio overrides across `/switch`; Safari/AVPlayer autoselect by system language overrode the server's and the
  remembered pick; AVPlayer changed subtitles on an audio pick; one audio label for chip/panel/Info; jest exit hang.

- F6: iPhone Home edge to edge, shared BackControl on detail pages (iPad/web/tablets/Android phones), season page under
  the rail, Versions panel close X, TV focus spacing rule (focus-clearance) across every focusable row, TV failed-start
  error actions unreachable (corner X).
- F4 (slices 2-4): accounts (profile editor with Cancel beside Save, translated sign-in methods, two-step panel closes,
  atomic sign-out of others, live e-mail cooldown in the info tone), toasts pass taps through and sit in the corner on
  desktop web/tablet, web 390 Settings without scrollbar, NSURLCache off for API traffic on iOS (modules/url-cache),
  Settings refetch on refocus, iPhone returns to portrait after the player, tvOS: inert "no versions" note takes the
  first focus, sort change keeps focus on the pill, Down from the pill reaches the first row's last poster, Left from a
  Versions card reaches the detail actions, next-episode title keeps the series, Search/Settings headings at the page
  top; slice-1 TV changes re-checked on Apple TV (release-name tone, neighbour focus); tests for the Glass ambient
  fallback and the ExpoVideoEngine start ordering; player Info names the HDR format (not SDR) for an HDR10 source; the
  audio chip shows the source layout like the audio panel.

- F4 (slice 1): Android TV sort -> genre chip (nextFocusDown), tab pages Back -> rail -> Home, device rows reachable
  again on Android TV + focus to the neighbouring row after a sign-out, glass buttons/chips sized per title (ambient
  highlight), release-name line 4.5:1 (muted tone on TV, in the contrast table), VLC reason lines, web 500 px detail
  without scrollbar, popping the active tab is a history pop on web (no duplicate entry); near-square Android rail
  checked (I2's insets). tvOS re-checked in slice 4 (release-name tone, neighbour focus).

- I3: tvOS build and run on the Apple TV 4K + 1080p simulators (prebuild switches documented), WebDriverAgent remote
  helper `docs/client/tv-remote.sh`; TV lists no longer collapse in the 1 pt TVFocusGuideView; hero/rows/tab-bar focus,
  Settings heading + Up to the tab bar, Versions panel clip and focusable cards, device-row focus; player remote events
  (card presentation on Apple TV, key-up taps, long press, hidden-overlay focus, Menu chain via usePreventRemove); sort
  pill reachable at the end of the genre line on Apple TV.

- I2: iPhone large title + Liquid Glass tab-bar minimise (tab roots are the ScrollView again, transparent tab-root
  header); iPad rail/Versions panel safe areas, shell headings on Settings/Search, hero on short windows, icon chips below
  960 pt, window-controls inset; iPad hardware keys (iOS PlayerKeys) and pointer-event wiring; resume point no longer
  lost on a dropped start seek (StartSeek + controller resume floor); Mobile Safari fullscreen (iPhone AVKit fallback,
  iPad close-button inset).

- B7: `/api` no-store rule centralised and enforced at response start (`NoStoreApiResponses`, OpenAPI route-walk test);
  VLC predictions explain the VLC engine instead of native conversions; `avatarKey` in admin viewer responses;
  `rendition_split_failed` integration test + docs (InvalidData/EndOfStream); verify_devworld.py watch checks on a
  fresh probe viewer (holds with --keep-data); one login validation on the code/reset paths.

- B6: HDR-sourced transcodes tagged BT.709 without mastering/CLL metadata (AVPlayer -12927 on iPhone), e2e colour guard;
  splitter errors -> InvalidDataException + 500 `rendition_split_failed`; rendition NAME = native language · delivered codec;
  one codec per remux audio group; fMP4 audio language; transcoding.md cost; sync Segment helper removed; admin plan lists
  audio renditions.

- Server, B5 (2026-10-01): multi-rendition audio in HLS (#4) — remux and transcode deliveries with two or more
  offered tracks carry one AUDIO group (up to 4 renditions, copy or per-device conversion), split per track from one
  ffmpeg process; `audioRenditions` + `inSessionAudioSwitch` in the playback response; `/switch` stays the fallback.
- Server, B4 (2026-10-01): e-mail code cooldown answered with 429 `email_code_cooldown` (no false
  `verificationSent`); viewer e-mails in German/English by request language; atomic
  `POST /viewer/me/sessions/sign-out-others`; `vlcHdrFormats=none`; posters and backdrops in the viewer language;
  `PATCH /viewer/me` partial with display name and `avatarKey`; palette overflow ordering; meaningful indexer-language
  test.
- Client, F3 (2026-10-01): one chip row on the library pages (title + sort in one line); TV glass sized per title
  from the art highlight under a per-text-style contrast rule; detail shows best available vs plays here; Accept-Language
  and German metadata; Settings account management (password, e-mail, two-step, devices; TV devices + hint); Android
  VLC caps on the versions request; near-square tablet detail. From F2 verify: Android square sort segment, Right from
  the rail after a genre deep link, deep link while the rail is focused, web chip ring after Back, tablet caption year.
  Resize/split screen was found to keep the tab stacks already (tests added; the old entry was wrong).
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
