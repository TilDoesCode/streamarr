# Streamarr Client — backlog

Consolidated from the journals (M1.5 … B1). Triaged in F1 (2026-09-30): every earlier entry is either still open below
(with the reason it stays) or listed under "Fixed" with the task that fixed it. The journals hold the evidence.

## Decisions for the user

- None open. Decided 2026-10-02: forced subtitles follow the audio language; phones resume the last played version
  (PLAN.md section 5, implemented in F7 S4). Round G decisions are in PLAN.md section 2.

## Needs Xcode (pending-ios)

- Apple TV (I4): VLCKit works on tvOS (H.264 MKV direct over VLC, AC3 5.1 + forced ASS tracks, remote keys, release;
  sim), but tvOS versions stay native-only (no VLC hints): HEVC/AV1/MPEG-2 software decoding through VLC on a real
  Apple TV is unchecked. Check on hardware, then add `tvos` to `VLC_HINT_PLATFORMS` (player/device-profile.ts).
- Apple TV (I4): a JS-initiated pop inside a tab stack (`navigation.goBack()`/`POP`/`POP_TO`) leaves the native stack
  at its root when a page below was pushed by a deep link (react-native-screens skips its controller as removed); Menu
  (a native pop) is fine. Deep links now pop natively (tv-native `popToScreen`); any future JS back in a tvOS tab stack
  must use the same path or be checked live.
- Apple TV dev builds (I4 S4): a Metro reload can crash in expo-modules-core `ExpoFabricView.injectInitializer`
  (AppContextLost) while a TVFocusHost view mounts during the reload; dev-only, seen once. A deep link to a new title
  while the player is open still closes the player through the router.
- HeroFade has no fallback when the masked-view native module is missing (check after the first iOS pod install).

## Needs real hardware (Android TV, ideally a 2 GB device; a real phone)

- F5: Android phone pass of the in-session audio switch not done: the dev build ANRs right after the player starts on
  the 2 GB `Streamarr_Phone` AVD (Google TV covered ExoPlayer). Run it on a real phone or a release build.

- HEVC Main10 / HDR10 / Dolby Vision decode and HDR display modes; AC-3 / E-AC-3 / DTS / TrueHD passthrough; 4K on a TV SoC.
- VLC: direct rendering (zero copy, black on emulators), first-seek latency in MKV (2.7–7.3 s on emulators), HDR output
  (the TextureView cannot carry HDR), stall watchdog on a real stall.
- Hold-scrub tiers 30/60/120 s on a real remote (emulator sends one repeat; unit-tested).
- Memory: home screen uses ~520 MB native in the dev build; measure a release build (the 2 GB emulator had one player ANR
  at ~290 MB free after many bundle reloads in F1).
- Phone blur cost: the software-GL AVD shows RenderThread ~84 % with the blurred ambient; re-measure on a real phone.
- TV: returning to Home from the profile picker shows a 1–2 s frame of lifted rows over the hero copy (slow emulator).
- TLS failure message against a real self-signed server; TV keyboards other than Gboard.
- iPhone/iPad (I1/I2): HEVC/HDR/Dolby Vision media caps, PiP start, AirPlay picker, iPad pointer hover
  (`modules/pointer-events` -> `Focusable` onPointerEnter) and hardware-key hold-repeat (unit-tested only).
- iPadOS window controls: the inset in a resized window is a fixed 30 pt (iPadOS 27 simulator); a native layout-region
  read would be exact.
- Apple TV (I3): Siri Remote touch surface (swipe scrubbing, clickpad), AVPlayer HDR10/Dolby Vision output and HEVC
  hardware decode (the simulator reports H.264-only SDR), top shelf, audio passthrough.

## Player

- F5: the native engines' in-session error path (rendition 404/500 -> `/switch`, 8 s timeout) is unit-tested only;
  ExoPlayer/AVPlayer report no per-rendition HTTP error. Force it live once on a fast host (JS hook that alters the
  rendition URL is not possible natively; needs a server-side test switch).
- F5: Safari lists the forced subtitle with `kind: "forced"`, the web engine skips that kind, so the subtitle panel on
  Safari misses the forced track (pre-existing; audio no longer depends on the count).
- F5: the Apple HLS validator (`mediastreamvalidator`) was still not run on the audio-rendition master.

- Decoder and dropped-frame figures are "—" for expo-video on Android; VLC decoder labels are best effort (needs an
  expo-video API for decoder stats).

- Google TV (F8 S4b): a Back pressed within ~0.5 s after a side panel closed is dropped natively: neither the RN
  Modal's onRequestClose nor BackHandler sees it (Android dialog dismissal; also with an immediate unmount). The JS
  stale-closure cases are fixed (overlay `hiddenByBack`, Sheet `closeRequested`). Lead: ReactModalHostView key
  handling during dismiss, or a non-Modal side panel on TV. Back, pause, Back works; Apple TV Menu Menu works.
- Player (F8 S4b, iPhone Safari): the up-next countdown keeps running while the player is paused (P3).
- Web/Safari (F8 S4b): two tabs playing the same title on one browser run two playbacks of one device (seen as a
  test artifact: a background tab kept playing); no guard today (P3).

## Browse, navigation and UX

- TV (F7 verify): while an episode's versions load, the stage shows Play + Versions and flips to "No versions yet"
  once they arrive (~15 s on the Google TV AVD). A neutral main button would need the same Focusable to stay mounted
  across the swap (TV focus must not move) — give TitleActions a loading state that keeps the main button's identity.
- Google TV (F7 verify): the stage pill once showed "Season 3 · Episode" without the number after an in-place update
  (Android text clipping on a width change?); seen once on the 1080p AVD.

- Google TV dev client (F7 verify 2): crashed once on the first deep link after a snapshot boot ("App react context
  shouldn't be created before"); fine after restart-app. Dev client only; check whether a release build is affected.
- Android TV emulator (F7): a detail page pop takes ~5 s and deep links land seconds late on the 2 GB Google TV AVD
  (it swaps ~580 MB); check on hardware. The emulator's anna session also ends between runs ("Signed out for your
  security" / "Your session has ended") — find out which side ends it (refresh reuse after an emulator kill?).
- TV (F7): the long-season strip position (focused card at x = 552 from the second card on) is unit-tested only; Dev
  World seasons have 3 episodes. Check with a long season (seed one or use a real library).
- iPad (F7): Split View / Stage Manager widths not checked live (needs Mac UI input in the simulator); the narrow rule is
  covered by web 1024×900 and a jest test at 820 pt.

- TV (F6): a detail deep link opened from another detail page keeps the previous page's focused slot (Sintel opened on
  the watched toggle after Wing It!); deep-link-only, focus memory keyed per route.
- Web (F6): Escape / Alt+Left for the detail BackControl (Tab + Enter and browser Back work).
- iPhone (I1 verify): BBB WEB-DL direct play showed frame 0 for ~45 s while the clock ran until a seek (loaded host);
  not reproduced in I2 after the StartSeek fix; watch for it on hardware.
- iPad Safari (I2 verify): closing the player leaves the page in element fullscreen, so Safari's X covers the rail logo.
- iPhone Safari (I2): a pause from the system fullscreen controls is not reflected in our Pause button until the next tap.
- Android phone (I1 verify): the Sign in button sits half under the keyboard/autofill strip (reachable via the IME Go
  key or a short scroll); the logo hides only on iOS while typing. Not re-checked in F4: Streamarr_Phone shows no soft
  keyboard on a cold boot (hardware keyboard) and the dev build hit ANRs under host load.
- Google TV dev build (I1 verify): LogBox "Can't perform a React state update on a component that hasn't mounted yet"
  at Home start, no stack.
- iOS: NativeTabs accessibility labels keep the old language after a live language switch; large titles do not shrink
  on scroll on Search/Settings (I1).
- Brand PNGs are large (icon 554 KB, top shelf 2.2–2.6 MB) because of dithered gradients; pngquant bands them. Revisit
  with a noise-free render if bundle size matters.

- iPhone (F4 verify): the first player close after a fresh simulator boot + sign-in stayed landscape (1 of 3 closes;
  later closes and the first close after an app restart restored portrait); cause not isolated, the orientation test
  cannot catch it.

- TV Filme (F6 verify): the genre scroller ends 8 pt before the sort control, so a focused last chip's ring comes within
  ~10 pt of the sort track (the neighbouring sort pill stays ~17 pt clear); derive that gap from the focus rule too.
- Focus spacing (F6 verify): `useFocusGap` also raises some web/tablet gaps (genre chips 8 -> 12 px, side-panel options
  4 -> 9 px); looks fine, record it as a decision or limit the rule to focus platforms.

- iPhone simulator (F9 S2b, Q1-48): first launch after a simulator boot drew the picker sideways once (1 of 3 cold starts;
  splash already rotated, so native/UIKit before JS; orientation module reported portrait + unlocked). Not reproducible on
  demand; re-check on hardware. The cold-start `releaseLaunchOrientation` (S1b) does not affect it.
- Onboarding (F9 S2a, P3): the server step reached while a profile is signed in has no "Zurück zur App" (the sign-in step
  has one).

- Web (F8 S4a): each genre/sort change pushes a history entry and keeps the previous Library screen mounted (21 after
  21 clicks); consider replacing params when the previous entry is the same tab (F9 area).
- Android phone (F8 S4b): on a genre switch that has to fetch, the grid is blank (no skeleton) until data or the
  error card arrives (~4 s offline) (F9 area, P3).

## Accounts

- DONE in I4 (Apple TV, native module client/modules/tv-native, tvOS-only): Versions/About sheets open with focus on
  their first card / Schließen; Menu goes one level (sheet, library grid/sort -> chip -> tab bar, non-Start tab -> Start,
  player overlay -> seek bar); "Zurück zu den Details" and player close return focus to the page; Settings starts below
  the floating tab bar (tvOS 27's bar ignores observed scroll views, so a layout clip instead); last Versions card glow
  clear of the panel edge; deep link to a title pushes it, a link to an open title returns to it (all platforms).
- DONE in F4 slice 3 (iPhone): API responses no longer reach NSURLCache. Native module client/modules/url-cache gives RN
  networking and expo/fetch a session without URLCache, purges the old shared cache and replaces it with a 0-byte cache
  (the dev client's network inspector re-sends requests through a default session). Cache.db before 96 rows / 63 /api/
  / 4 /viewer/auth, after 0. tvOS: the module (podspec ios + tvos) is in the next tvOS build; the cached tvOS app
  (~/.cache/streamarr-tvos-app) still lacks it.
- DONE in F4 slice 2 (Android phone + web; iPhone/iPad live pass in slice 3): profile editing (display name, avatar
  colour) in Settings; translated sign-in methods incl. `password+2fa`/`email_code+2fa`; the two-step panel closes
  after "Saved" and after turning it off; "Sign out all other devices" uses the atomic B4 endpoint; the e-mail code
  cooldown shows a live "Wait N s" on a disabled button (onboarding send/resend, Settings e-mail).
- Android phone dev build on the 8 GB Mac: ANRs ("isn't responding") under host memory pressure, once on the two-step
  setup screen (QR + secret; main thread busy in vsync/Choreographer, 78 s CPU). Re-check on a less loaded run; if it
  reproduces, profile the QR `Svg` path and the Glass panel animations (F4 slice 2). F4 slice 4: the live "I saved
  them" close on the phone was not reached again (cold-booted Streamarr_Phone: app ANR after the sign-in, then
  "Process system isn't responding"); it is screen-tested and was verified live on the iPhone (slice 3).

- iOS (F4 slice 3): a `streamarr:///sign-in?...` deep link opened while signed in shows the sign-in screen without a back
  button (AuthScaffold uses `router.canGoBack()`, false there); only another deep link leaves it. Offer "back to the
  app" (replace to the tabs) when a profile is active.

- Web (F4 verify): every tab writes the whole account list to localStorage, so a second open tab can overwrite an edited
  display name until `/viewer/me` resyncs; write per-account or merge on storage events.

## Tests and tooling

- **R1 release builds (2026-10-05):**
  - Android release startup abort, 1 of 13 phone cold starts (not reproduced in 10 more): SIGABRT on mqt_v_js,
    `[runtime not ready]: Exception in HostFunction: The current activity is no longer available` at the first native call
    (`expo-modules-core NativeModulesProxy` ← `expo/src/Expo.fx`). Library-level startup race → watch on real hardware;
    upstream issue if it repeats. Stack in journal/R1.md.
  - Reanimated `synchronouslyUpdateUIProps failed for tag …` (`Unable to find SurfaceMountingManager`) with a ~120-line
    stack each on the UI thread: 90× at player close (Google TV release), 640× for one tag on the phone R8 build — an
    animated view outlives its surface (player overlay / ambient candidates).
  - R8 + resource shrinking: APK 105.1 → 94.3 MB, dex 49.6 → 18.3 MB, smoke (start, session, Home, detail, play) passes, but
    detail push measured 25 s vs 3.4 s → re-measure with a non-polling timer before enabling it in app.config.
  - Release APK is 105 MB for arm64 alone (libvlc.so 52.5 MB): consider VLC as a separate download or ABI splits.

- Dev only: after a JS reload nothing is focused on TV until the first D-pad press; the dev client can start with a
  cached bundle.

## Server (backend track)


- Audio renditions: `mediastreamvalidator` never run (Apple HLS tools not installed; ffprobe + hlssim instead); rendition
  segments ignore byte ranges like video; a group stays mixed only when every rendition is copied FLAC/Opus/MP3
  (B6, narrowed in B8).
- Dev World has no HLG or Dolby Vision source and its ffmpeg has no zscale: HLG/DV tagging is covered by unit tests only,
  and the Dev World HDR10 -> SDR transcode is untone-mapped (washed out, tagged BT.709) (B6).
- B6 verify: the SDR tag chain after `hwupload` on VAAPI/QSV is untested on real hardware; one Core test flaked once
  in a full run.
- Art highlight is measured over the whole backdrop; add per-region values (right panel, left rail) if the client finds
  the whole-image value too strict.
- B8 verify: a replay is only detected when a report of the completing playback lands below 5 %; the client must send
  a report at position 0 when it replays (check `controller.replay()` in F8/F9). The group conversion reuses the
  `audio_converted` reason code. ~~The long-season series (The Lighthouse Logs) has no artwork.~~ → B10: generated artwork.
- ~~Username and e-mail of one account share the sign-in code cooldown, so someone who knows both can link them (429 on
  the second alias within 30 s); documented, low impact (B4 verify).~~ → B10: the other alias answers 202 without a mail.
- Dev World artwork uses fixed per-language URLs; the real selection rule is covered by `TmdbDiscoverTests` only. No
  German logos in the Dev World (TMDB has none for the fixture titles).

## Next update (out of scope)

- Offline downloads of series and movies on phones and tablets.

- F4 verify: `url-cache-module.test.ts` only greps the Objective-C source (a native smoke/Cache.db check in CI would be
  real coverage); `orientation.test.ts` cannot catch the first-close case.

- F6 verify: `focus-clearance.test.ts` checks the derived tokens only; a row that goes back to a fixed gap would not
  fail (only card rows are covered). Add a screen test per primitive (action row, chip row) asserting the gap.
- F6 verify: `PHONE_HEADER_HEIGHT` duplicates `HEADER_HEIGHT` in `phone-detail.tsx`; a stray blank import line.
- Android TV and phone AVD boot snapshots hold an ended anna session (re-signed in by each run); refresh the snapshots
  once with a fresh sign-in, or sign in through a deep link in the run scripts.
  F8 S6 proof (F9 V2 "Your session has ended" at 23:51): Streamarr_Phone `default_boot` RAM/disk snapshot is from
  2026-10-01 19:25 local; a snapshot boot restores the app storage to that day, so the app presents a refresh token
  of a session the server has since deleted -> 401 `refresh_session_expired`, no revoke. Cold boots
  (`-no-snapshot-load`) use the current disk and keep the live session. Emulator-only; re-save the snapshot after a
  fresh sign-in (or always cold-boot) to stop it.
- Auth residual (F8 S6, P3): if the Keystore *write* of a rotated pair fails, the app uses the pair from memory
  (S3), which confirms the rotation on the server; if the app is then killed before the throttled retry stores it,
  the next launch presents the previous token and B9 revokes the session for reuse ("Signed out for your
  security"). Needs a failed write plus a kill within the retry window; no client-only fix without the vault.

- F5 verify (mutation run, 7 of 9 caught): no test covers the engine-error -> `/switch` fallback of an in-session
  switch, and none covers NAME-first track matching (`audio-renditions.ts`); add both.
- F5 verify: `controller.audioSwitches` (measurement samples) is unbounded and ships in production; cap it or keep it
  behind `__DEV__`. `audio-renditions.ts` has a three-line doc comment (convention: one line).
- F5 verify: the remembered audio language is also sent for single-audio titles (harmless; skip it when there is one
  track).
- Google TV AVD (F5 verify): with the Metro debugger attached the dev build's JS stalls (~980 MB of 2 GB); one Fabric
  SIGSEGV at sign-in, probably from an "rr" dev reload during adb text input. Prefer argent paste for passwords.

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

- F8 verify V2: on Mobile Safari the first tap on a hidden player overlay toggles playback instead of only showing the
  controls (since M4.2); Apple TV focus lands on the "Start" tab after the player when the played title left Home;
  once, Up right after Down kept focus on the seek bar (not reproduced); while the secure storage keeps failing to read,
  signing out or signing the same account in again throws (S6, P3); the iPhone video full-screen leave path
  (`webkitEnterFullscreen`) is untested; after leaving the system full screen paused, the overlay stays hidden (P3).

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

- B14-B16 verify (non-blocking): a flooder behind the same IP as real viewers (home network, carrier NAT, an
  untrusted proxy) keeps their refreshes at 429 while the flood lasts — count only failed refreshes per IP or let a
  valid live token pass the IP limit; a parked (throttled) run gives up its slot, so with all slots taken its resume
  answers `503 remux_capacity` mid-playback (before B16 the paused run kept the slot; undocumented); one player that
  jumps far ahead and straight back within 3 s now waits 3.4-4 s for the first segment (was 0.3-0.5 s); a transcode
  resume overlaps by one video frame and ~37 ms of audio; every error answer on the transcode routes scans all
  playbacks' issue gates (skip unknown sessions); leftover doc comment ProcessRunner.cs:157; Dev World logs at Warning
  so the limiter's Information lines are invisible there; `fault:7` answers an unclear 400 message; faults_smoke's
  usenet_hole leaves releases dead, so run e2e on a fresh instance.

## Tests and tooling (more)
- T1 verify: a failing controller test can leave an open handle so jest hangs after the failure (needs --forceExit);
  one failure also cascades into later tests of controller.test.ts.
- T1 verify: `audioTracks?.length ?? 2` (unknown track count) is repeated three times in controller.ts; the
  single-audio release set is module-global with no reset; testID `stage-actions` exists only for a test.
- T1: assets/brand/render.sh now needs python3 + Pillow (denoise.py); not checked by any script.
- TV sign-in: adb text input into the TV sign-in field does not arrive (test tooling; real keyboards untested).
- Headless Chrome for Testing 131 draws bands through glass in screenshots; use --disable-gpu for captures (F3).

## Fixed

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
