# Streamarr Client — backlog

Consolidated from the journals (M1.5 … B1). Triaged in F1 (2026-09-30): every earlier entry is either still open below
(with the reason it stays) or listed under "Fixed" with the task that fixed it. The journals hold the evidence.

## Decisions for the user

- Forced subtitles and audio switches (F5): today an audio switch never changes the subtitle (every engine; AVPlayer's own
  "forced follows the audio language" is overridden), so German forced subtitles stay on after switching to English.
  Alternative: a forced subtitle follows the audio language (forced track of the new language, else off), on the
  client for in-session switches and in the `/switch` request. Round G decisions are in PLAN.md section 2.

## Needs Xcode (pending-ios)

- Apple TV (I3 follow-up, native): Menu inside the Versions panel pops the whole detail and the library grid -> chip
  Menu step never reaches JS (the native tab bar consumes it); react-native-tvos tag-based focus APIs (`destinations`,
  `nextFocusUp`, `requestTVFocus`) do not act under RNSTabsHost. Needs native focus/Menu support and a rebuild.
- Apple TV: VLCKit playback on tvOS unverified, so tvOS versions stay native-only (no VLC hints) (I3).
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

## Browse, navigation and UX

- TV (F6): a detail deep link opened from another detail page keeps the previous page's focused slot (Sintel opened on
  the watched toggle after Wing It!); deep-link-only, focus memory keyed per route.
- Web (F6): Escape / Alt+Left for the detail BackControl (Tab + Enter and browser Back work).
- iPhone (I1 verify): BBB WEB-DL direct play showed frame 0 for ~45 s while the clock ran until a seek (loaded host);
  not reproduced in I2 after the StartSeek fix; watch for it on hardware.
- iPad Safari (I2 verify): closing the player leaves the page in element fullscreen, so Safari's X covers the rail logo.
- iPhone Safari (I2): a pause from the system fullscreen controls is not reflected in our Pause button until the next tap.
- Replay from the end card, then stop at 1:44, keeps no resume point (detail shows "Erneut ansehen"; predates I2).
  Root cause (F4 slice 4): `controller.replay()` keeps the same playbackId, and the server's WatchProgressRules ignore
  later reports of the playback that completed the work (`CompletedBy`, against post-credits reports). Fix either on
  the server (a report of the same playback after it went back to the start counts as a new play) or in the client
  (replay starts a new playback via the play route). Needs a decision with the backend track.
- Android phone (I1 verify): the Sign in button sits half under the keyboard/autofill strip (reachable via the IME Go
  key or a short scroll); the logo hides only on iOS while typing. Not re-checked in F4: Streamarr_Phone shows no soft
  keyboard on a cold boot (hardware keyboard) and the dev build hit ANRs under host load.
- Google TV dev build (I1 verify): LogBox "Can't perform a React state update on a component that hasn't mounted yet"
  at Home start, no stack.
- iOS: NativeTabs accessibility labels keep the old language after a live language switch; large titles do not shrink
  on scroll on Search/Settings (I1).
- Brand PNGs are large (icon 554 KB, top shelf 2.2–2.6 MB) because of dithered gradients; pngquant bands them. Revisit
  with a noise-free render if bundle size matters.

- tvOS (I3): the native top tab bar stays visible while Settings scrolls (first device row slides under it); "Zurück zu
  den Details" from a player started on Home focuses the Start tab; the last Versions card's glow is cut at the panel
  bottom; Menu from a non-Start tab exits the app (Android TV goes Home first).
- tvOS player (I3 verify 2, re-checked in F4 slice 4): after Menu hides the overlay, focus stays on the hidden button
  (forward30/Audio/Play-Pause), so Right moves hidden focus and Select presses the hidden button (Audio opens its
  panel). The auto-hide path parks on the seek bar correctly. Tried without success: a deferred second
  `requestTVFocus` (150/500 ms), `focusable={false}` on the hidden button row (focus left, but Up could not re-enter),
  switching to the progress zone before hiding, and a press guard (the remote-key handler shows the overlay before the
  button's onPress arrives). Needs a native look at react-native-tvos Menu handling / focus updates after Menu.
- Deep link to /movie/<id> over an open movie detail replaces it instead of pushing; once closing the player then
  landed on the older detail (I3 verify).

- iPhone (F4 verify): the first player close after a fresh simulator boot + sign-in stayed landscape (1 of 3 closes;
  later closes and the first close after an app restart restored portrait); cause not isolated, the orientation test
  cannot catch it.

- TV Filme (F6 verify): the genre scroller ends 8 pt before the sort control, so a focused last chip's ring comes within
  ~10 pt of the sort track (the neighbouring sort pill stays ~17 pt clear); derive that gap from the focus rule too.
- Focus spacing (F6 verify): `useFocusGap` also raises some web/tablet gaps (genre chips 8 -> 12 px, side-panel options
  4 -> 9 px); looks fine, record it as a decision or limit the rule to focus platforms.

## Accounts

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

- Dev only: after a JS reload nothing is focused on TV until the first D-pad press; the dev client can start with a
  cached bundle.

## Server (backend track)

- Audio renditions (F5): the delivered rendition codec differs between start and `/switch` for the same device and
  title (Safari: AC-3 2.0 at revision 0, AAC 2.0 after `/switch`; iPhone/Apple TV: AAC 2.0 at start, AC-3 2.0 after some
  `/switch`es and at a start with `audioLanguage: en`), so the panel label changes ("AAC 2.0" vs "Dolby Digital 2.0");
  the rendition of Sintel's German AC-3 5.1 source is labelled 2.0.

- Viewer sessions store the English literal "Unknown device" when the finishing request (second-factor, e-mail code
  verify) carries no deviceName, so a German device list shows English text (F4 slice 3). Store null (or carry the
  name from the first step) and let clients show their translated fallback.
- Audio renditions: `mediastreamvalidator` never run (Apple HLS tools not installed; ffprobe + hlssim instead); rendition
  segments ignore byte ranges like video; a group stays mixed when the default rendition is copied FLAC/Opus/MP3 (B6).
- Dev World has no HLG or Dolby Vision source and its ffmpeg has no zscale: HLG/DV tagging is covered by unit tests only,
  and the Dev World HDR10 -> SDR transcode is untone-mapped (washed out, tagged BT.709) (B6).
- Dev World stream info for the HDR10 4K BBB source probably carries `videoRange` SDR next to `hdr` hdr10 (the client
  label preferred videoRange; fixed in F4 to name the `hdr` format). Not confirmed by a playback request; check the
  stream tags of the generated file (I3, F4).
- B6 verify: the SDR tag chain after `hwupload` on VAAPI/QSV is untested on real hardware; one Core test flaked once
  in a full run.
- B7 verify: docs/api.md versions section does not list `predictedMethod: vlc` and that VLC predictions carry VLC
  reasons; the route-walk test asserts Cache-Control + Pragma but not `Expires: 0` and does not walk HEAD/OPTIONS (live
  OK); verify_devworld.py leaves its probe viewer behind if it crashes mid-run; `NoStoreApiResponses` XML summary spans
  two lines.
- Art highlight is measured over the whole backdrop; add per-region values (right panel, left rail) if the client finds
  the whole-image value too strict.
- A display name of only spaces resets to the username (200) instead of 400; documented, the client should trim and
  validate first (B4 verify).
- Username and e-mail of one account share the sign-in code cooldown, so someone who knows both can link them (429 on
  the second alias within 30 s); documented, low impact (B4 verify).
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

- F5 verify (mutation run, 7 of 9 caught): no test covers the engine-error -> `/switch` fallback of an in-session
  switch, and none covers NAME-first track matching (`audio-renditions.ts`); add both.
- F5 verify: `controller.audioSwitches` (measurement samples) is unbounded and ships in production; cap it or keep it
  behind `__DEV__`. `audio-renditions.ts` has a three-line doc comment (convention: one line).
- F5 verify: the remembered audio language is also sent for single-audio titles (harmless; skip it when there is one
  track).
- Google TV AVD (F5 verify): with the Metro debugger attached the dev build's JS stalls (~980 MB of 2 GB); one Fabric
  SIGSEGV at sign-in, probably from an "rr" dev reload during adb text input. Prefer argent paste for passwords.

## Tests and tooling (more)
- TV sign-in: adb text input into the TV sign-in field does not arrive (test tooling; real keyboards untested).
- Headless Chrome for Testing 131 draws bands through glass in screenshots; use --disable-gpu for captures (F3).

## Fixed

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
