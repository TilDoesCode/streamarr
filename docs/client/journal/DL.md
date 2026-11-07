# DL — offline downloads (orchestrator journal)

Status: in-progress

Integration branch `fb/downloads` (off `main` ed8e104e). Spec: PLAN.md § "DL — offline downloads"; human plan
`docs/client/downloads-plan.html`. Packages DL-S, DL-N, DL-C1, DL-C2, DL-Q (journals `journal/DL-*.md`).

## Log

- 2026-11-06: exploration (server versions/packs/similarity/stream; client shell/detail/player/offline), plan, user
  decisions (devices incl. Android TV, phone Library tab, VLC counts, allowDownloads default on) recorded in PLAN.md.
- Machine now has 48 GB RAM (PLAN §3's 8 GB note is outdated); still one native build per lane at a time.
- Worktrees: `../streamarr-worktrees/dl-server` (fb/dl-server), `../streamarr-worktrees/dl-native` (fb/dl-native), both off
  fb/downloads be6f1978. Spawned Codecraft subagents DL-S (request fc7fda8a-c902-42d6-80f7-9c87ec2135f4) and DL-N
  (request aea478c8-7d07-4b8c-bf54-979dbd8ba8b5). DL-C1 starts after the DL-S contract freeze + DL-N interface.
- DL-S contract frozen: fb/dl-server c029ac09 (OpenAPI, client+web schema.d.ts, docs/api.md § 14; services 501 until
  implemented). Routes: viewer/downloads candidates, candidates/season, plan, POST/GET/list/renew/complete/DELETE;
  file capability GET|HEAD /api/v1/offline/{capability}; admin list/revoke; allowDownloads/maxConcurrentDownloads.
- DL-N spike findings: kesha-antonov library resumes without If-Range (silent corruption on changed files), MMKV clash
  risk, no waiting/disk-full kinds; expo-file-system has no Android background/re-attach → own module likely.
  Streamybox mpv renderer runs in another UID and cannot open app-private files → core must route local files
  (FileProvider grant or in-app ExoPlayer/VLC). Asked DL-N to commit the TS interface + fake as an interface freeze
  so DL-C1 can start in parallel.
- DL-N interface freeze: fb/dl-native 18e76428 (types/index/fake) + journal c1a5af94 (Streamybox: never use the
  Streamybox engine for local files; expo-video/VLC from the saved engine; `contentUriFor` exists for a later player v2).
  Engine decision trending to own module `modules/offline-downloads`.
- Worktree `../streamarr-worktrees/dl-core` (fb/dl-core) = fb/downloads + merges of c029ac09 and c1a5af94. Spawned DL-C1
  (request dad5d9d1-1b97-438b-87f0-e10bebca90c0): store/manager/connectivity/offline shell/DownloadsLibrary component/
  player local mode/progress sync/account removal; slice 1 freezes the JS API, then DL-C2 starts. Device phase B only
  after DL-S + DL-N are integrated into fb/downloads. Ports: DL-C1 Metro 8082, web 39302.
- DL-C1 JS API freeze: fb/dl-core 9fa5d2a3 (+ c3be8766 connectivity/progress sync, 31632f88 error codes); summary in
  journal/DL-C1.md "API freeze". DL-C1 owns DownloadsLibrary content component + offline shell; i18n: DL-C1 owns
  `downloads.state|error|notification` and `errors.codes.*`, DL-C2 adds other `downloads.*` sub-objects.
- Worktree `../streamarr-worktrees/dl-ui` (fb/dl-ui) off fb/dl-core 9fa5d2a3 for DL-C2 (Metro 8083, web 39303).
- DL-C2 spawned (request 880fcb8c-553c-4d19-8d96-9bc53e474581; first attempt 51eff9a9 failed with start_timeout, retried).
- Check-in: DL-S at 5d54f4fc (implementation + Dev World fixtures committed); DL-N at 48925381 (native module, Android
  phone verified: background, kill/swipe, If-Range restart, 503/404, notification permission, expo-video/VLC local play;
  iOS next).
- DL-S done (fb/dl-server 9898774a: c029ac09 contract, 9cb3a872 impl, 5d54f4fc Dev World, 96d3e1cd web, f64fcef7 docs,
  883c43b4, 9898774a journal). Server.Tests 1882/1895 (13 known ffmpeg), Usenet 256/256, Core 535/535, DevWorld 94/94,
  web 329/329, live downloads_check 27/27. Merged into fb/downloads (a58d41b7).
  NOTE: published Dev World snapshot (releases/20261106T204652Z-8060) points at the dl-server worktree's cache dir —
  keep `../streamarr-worktrees/dl-server` until DL lands on main and the snapshot is re-published from main.
  `devworld.sh start` (nohup) fails in agent sandboxes; run the snapshot dll directly with DEVWORLD_PORT/CACHE_DIR.
- Independent verify of DL-S: worktree `../streamarr-worktrees/dl-verify` (fb/dl-verify off a58d41b7), Codex verifier.
- Check-in DL-C1 (1 h): c78103e1 local playback (expo-video/VLC, never Streamybox; local tracks; offline up-next),
  e7bf22a9 DownloadsLibrary + storage summary + account prompt, b7ff939d offline shell. DL-C2 fast-forwarded to the
  pre-amend 86eec76b (amend only touched local-mode.test.ts) → told DL-C2 to take fb/dl-core's file on the next merge,
  told DL-C1 not to amend/rebase anymore.
- DL-N heads-up: 18e76428 tripped `no-literal-text` (fake.ts diagnostics). Two independent fixes, both compatible (no
  merge conflict): DL-N 1663fc1e rewrites fake.ts; DL-C1 31632f88 lists fake.ts in CONTENT_FILES. DL-N also at 613f5783
  (iOS listener registry, reconcile after force quit); Android phone + Google TV 13 + iOS simulator verified per DL-N.
- DL-C1 phase A done (fb/dl-core e6cbdb70; typecheck 0, lint clean, jest 246/2502). Phase B (devices) held until DL-N
  is integrated: DL-N is the only lane installing dev.streamarr.app on emulators/simulators for now (same package id
  would collide). DL-C1 told to merge fb/downloads, finish with `partial`; resume later with device assignment.
  Forwarded DL-C1 → DL-N requests (retryAfterMs, http fail-fast vs retry semantics, iOS backup exclusion on the root dir
  incl. art/, recursive deletePath) and asked DL-N for reusable dev-client builds (APK, iOS sim .app) + device list.
- DL-C1 turn ended `partial` (phase A done, fb/dl-core a6215b6d, jest 246/2504; phase B pending DL-N). Forwarded its
  DL-C2 notes (wrap DownloadsLibrary, playHref without releaseId for local, error.actions retry/otherVersion, Settings
  Downloads section on /offline). DL-C2 progress: 231baaed sheet + Downloads screen + settings, 87f1fbf6 nav (phone
  Library tab, Downloads tab/rail + badge), 10643f9c detail integration.
- DL-S verify 1 (Codex, fb/dl-verify fd867464): **fail** — 0 blockers, 10 majors, 7 minors (13 reproduced, 4 code
  reading). Majors: capability logged unredacted (V1-01); permission-off/disable/age-tightening/session revoke don't stop
  file access (V1-02/03/04, V1-14 race); prepare idempotency race (V1-05); similarity plan can pass over the viewer's
  language (V1-06); transfer admission can evict a live session (V1-07), pin-vs-LRU race (V1-15), preparation bypasses
  the download resource policy (V1-16). Normal path, ranges, limits, RAR pack, restart/resume all passed.
- Decision V1-04 (orchestrator, reversible): explicit security actions (sign out all sessions, admin password reset)
  rotate the viewer's download capabilities → old URL `410 download_revoked`, record stays, renew after re-login gives a
  new URL, resume on the same ETag. Ordinary token expiry never affects capabilities. Permission off / age tightening:
  open transfers cancelled; completed device files stay (out of server scope).
- DL-S fix round 1 started (same builder session, turn 2), all 17 findings with regression tests.
- DL-C2 phase A done (fb/dl-ui e2d395e4, merged fb/dl-core a6215b6d; typecheck 0, lint clean, jest 251/2561): sheet route
  `download/[workId]` (iOS formSheet, TV glass side panel, tablet drawer, phone bottom sheet), season pack / rest similar /
  each, fit verdicts, phone Library tab + Downloads tab/rail + badge, detail defaults + markers, settings (+ offline
  shell). Phase B held until DL-N is integrated; DL-C2 ends `partial`.
- Client code review (Codex) started on worktree `../streamarr-worktrees/dl-verify-client` (fb/dl-verify-client off
  e2d395e4) — JS-only (jest/typecheck), devices come in phase B.
- DL-N done (fb/dl-native 68faebb4; own module `modules/offline-downloads`; retryAfterMs + shared HTTP policy TS/Kotlin/
  Swift; iOS HEAD probe before reusing resume data; backup exclusion on the engine root). Merged into fb/downloads
  (a38c1ffe, JOURNAL.md conflict = both lines kept). Dev clients: /Volumes/DevSSD/Caches/streamarr-builds/
  dl-native-b1b3a8f4/ (arm64 debug APK phone+TV, no embedded server; iOS sim .app iPhone+iPad). No native/package changes
  on fb/dl-core or fb/dl-ui → these builds serve both lanes.
- Device assignment for phase B (do not touch: emulator-5566 sbx_tv_flows, emulator-5570 sbx_tv_ui,
  100.117.41.108:5555, iPhone 17 Pro 7ADF9325…, iPhone SE DE test 086BF8A7… — other sessions):
  DL-C1 → emulator-5554 Streamarr_Phone (API 34), emulator-5558 Streamarr_GoogleTV13_1080p (API 33), iPhone Air
  137E4593…; Metro 8082, Dev World 39300.
  DL-C2 → emulator-5556 Streamarr_GoogleTV_1080p (API 34) + own new AVD Streamarr_Phone_DL2 + own sims "DL-C2 iPhone",
  "DL-C2 iPad"; Metro 8083, Dev World 39305 (own instance: per-viewer download limits/lists stay separate).
- Native code review (Codex) on `../streamarr-worktrees/dl-verify-native` (fb/dl-verify-native off a38c1ffe), no devices.
- DL-S fix round 1 contract settled (fb/dl-server f76055ed, additive): `fileUrlRevoked` on DownloadResponse/admin item;
  `renew?deviceId=` issues a new capability when revoked (same ETag/bytes → resume); file URL `410 download_revoked`,
  `403 age_restricted`, `412`/`304` preconditions; open transfers end ≤ 2 s on revoke/expiry/permission/disable/age;
  security sign-out list defined (admin sign-out/password/2FA reset, disable, e-mail reset, viewer's own sign-out-others/
  password change); prepare idempotency key viewer+deviceId+clientRef (unique). Forwarded to DL-C1 (manager) and DL-C2
  (UI copy: waiting for re-login is not an error; not-allowed/age → failed with reason, only "Remove").
- DL-C verify 1 (Codex, fb/dl-verify-client 806adaf1): **fail** — 0 blockers, 15 majors, 10 minors, 1 nit; 17 repro tests
  in `client/src/__verify__/` (it.failing; `DL_VERIFY_EXPECT_FIXED=1` for real assertions). C1-22 ("58 jest failures") is
  an environment artifact: the verifier ran Node 26.11.1, outside the repo's `>=22 <25`; with Node 24.14.0
  detail-downloads passes 9/9 (orchestrator re-run). Fixers must report full jest under Node 24.
  Split: DL-C1 ← C1-01..08, 12..15, 17..19, 21, 24, 26 (core files), 06 core part; DL-C2 ← C1-09, 10, 11, 16, 20, 25,
  06 UI part, 23 sheet part, 26 (UI files). Decisions: C1-12 disambiguate 4xx by GET of the server record
  (fileUrlRevoked/state/error), never parse diagnostics; C1-21 persist last-known viewer policy (maxAge, blockUnrated,
  allowDownloads) per account, offline/online lock (not delete) downloads above it; profile PIN does not exist → documented
  as unsupported, same as online; C1-06 validate exists+size at play start, online fall back to streaming at the saved
  position, offline a specific "file missing" card.
- DL-C2 fix round 1 started (devices parked: emulator-5556, Streamarr_Phone_DL2 = emulator-5560; Metro 8083, Dev World
  39305 up; Node 24.14). Additive change in DL-C1's `downloads-library.tsx` (`onOtherVersion` prop, failed-row actions
  honour `error.actions`) → told DL-C1 to leave that block alone this round and to emit `file_missing` with
  actions retry+remove. DL-C2 device finding: a title deep link from the Settings tab landed in the Downloads stack
  (route group order) — fixed in C1-25.
- DL-N verify 1 (Codex, fb/dl-verify-native f5f6c1a5): **fail** — 3 blockers, 11 majors, 3 minors. Blockers (Android,
  reproduced with the real Kotlin Transfer in a JVM harness): N1-01 206 append without strong-ETag/full Content-Range
  check (mixed bytes published as completed), N1-02 new ETag persisted before truncating the old prefix (process death →
  mixed file), N1-03 no path ownership (two writers, one path). Majors: early completion/416 parity, iOS stale delegate
  callbacks + task identity, iOS reattach/finalization skip validation, cancel/move/delete races, unbounded Retry-After
  loop, Kotlin Retry-After overflow → 0, iOS HEAD/resume-data handling, fake fidelity, cross-origin redirect forwards
  headers, Android Task-Manager stop not detected, unstable removable volume ids.
- DL-N fix round 1 started (same builder, turn 2). Decisions: strong-ETag + full Content-Range for append, no
  Last-Modified fallback; pinned etag mismatch → failed validator_changed, unpinned → restart from 0; path ownership →
  invalid_state; every 416 fails + drops partial; Retry-After keeps not consuming the 8 attempts but gets a 12 h
  no-progress budget, min delay 2 s, cooldown survives network changes; redirects: strip caller headers on origin change,
  header allowlist in the entry; Android: exit-reason detection of user stop → paused, Pause/Cancel notification actions,
  tap → streamarr://downloads; volume id = StorageVolume UUID, missing volume never reassigned; fsync checkpoints;
  active-task space reservation. Fake must match native; DL-N lists core/UI tests broken by the stricter fake (scratch
  worktree merge of fb/dl-ui). Own devices: AVD Streamarr_Phone_DLN + sim "DL-N iPhone". New dev clients at the end →
  client lanes reinstall. Core uses per-download paths (`filePathOf(accountKey, id, fileName)`), so N1-03 is a guard,
  not an expected user path.
- DL-C2 fix round 1 done (fb/dl-ui 53cb8734 sheet fixes, d7a5f4ab nav, ac6a73a8 regression tests, 15c490a2 journal;
  Node 24.14: typecheck 0, lint 0, jest 255/2622). C1-09/10/11/16/20/25 + UI parts of 06/23/26 fixed; repro promoted
  to `sheet-regressions.test.tsx`. Only DL-C1 file touched: `downloads-library.tsx` (+22/−2, additive `onOtherVersion`).
  Not yet merged: fb/dl-core 32417219/965ac80f (waiting for DL-C1's fix-round announcement). DL-C2 resumed phase B.
- DL-N fix-round interface/fake settled (fb/dl-native 220a0ded, TS only, additive): header allowlist, path ownership,
  cancel resolves after cleanup, shared retry corpus (floor 2 s, cap 1 h, 12 h no-progress budget), completed → one
  final progress, `volume-<uuid>` ids + `volume_unavailable`, Android notification Pause/Cancel + streamarr://downloads,
  Task-Manager stop → paused, unknown errors → `io`; fake follows native. Conformance 220a0ded + fb/dl-ui: jest
  2706/2706 (Node 24). Decisions forwarded to DL-C1: unsolicited `cancelled` = user cancel (remove record + server
  DELETE); unsolicited `paused` and Task-Manager stop stay paused (no auto-resume); 12 h exhaustion → waiting_server.
- DL-S fix round 1 done (f76055ed, 0857ebb7, 2052ea31, c6c4ff9d, 1e9ffd3a, e1e93fae): all V1-01..17; 34 new tests fail
  on pre-fix code; server 1933/1947 (13 ffmpeg + 1 tunnel timeout under load, passes alone), Usenet/Core/DevWorld green,
  web 329/329; live 27/27 + security 16/16; snapshot re-published from 1e9ffd3a. Merged into fb/downloads (cdd6a6b8).
  Accepted builder decision: account disable → 403 downloads_not_allowed, re-enable restores the same URLs (no rotation).
- DL-C2 device finding → DL-S fix round 1b. Decision (orchestrator, reversible): the similarity plan follows the
  anchor's language (the viewer's explicit pick), untagged anchor = class "untagged", language still beats picture,
  best_available off-language gets note `language_differs`; `recommended` keeps the viewer-language rule (V1-06).
- Decision: transfer refused with downloads_not_allowed/age_restricted → record failed with actions ['remove'],
  automatic re-check + resume (same bytes) when permission/age policy allows again; no retry button while blocked.
- DL-S verify 2 started (same Codex verifier, turn 2, Node 24), V1-06 plan part deferred to 1b.
- DL-C1 fix round 1 done (fb/dl-core 87d38df7: 9bd3c386 connectivity, ab23c423 core, d9520b0d player; typecheck 0,
  lint 0, jest 2573/2574 under Node 24 — 1 load timeout in capabilities, passes alone). All core C1-xx fixed; repros
  promoted. Extra finds: offline Play from the shell bounced back; cancelled engine tasks stuck. Additive API:
  SpaceVerdict.unknown, DownloadForWork.locked, useDownloadRecord/store.subscribeTo, error.actions 'remove',
  checkLocalPlayTarget/verifyLocalFile/holdFile. schema.d.ts identical to fb/downloads. Forwarded to DL-C2 (merge
  87d38df7; UI for unknown space / locked / file_missing). DL-C1 still has to merge fb/downloads cdd6a6b8 (queued note).
  DL-C2 meanwhile: 3bbe0036/382d7083 phone sheet keeps confirm button on screen.
- DL-C2 check-in (2 h): merged fb/dl-core 87d38df7 (2b314591), adapting UI to SpaceVerdict.unknown/locked/file_missing;
  12 phone screenshots (DE). Orchestrator review notes sent: VLC reason line reads like an error → "Spielt mit VLC";
  blocked pre-selected pack must not look ready; retake "Rest ähnlich" after DL-S 1b; final set incl. TV panel, iPad
  landscape, offline shell, EN variants, failed/blocked row.
- DL-C1 check-in (1 h into turn 2): 6fa75ef7 (prepare finished in the long-poll frees its slot) + 11 phone screenshots
  (offline shell server-down vs. no-network, local native + VLC play, RAR pack done, 429 waiting, progress synced).
  Not yet merged fb/downloads cdd6a6b8 (reminded). Nits sent: Play button on finished movie rows; "no network" card
  copy says device, not server.
- DL-S verify 2 (Codex, fb/dl-verify 1fa83667): **fail** — 14/17 V1 fixed (32 regressions independently fail on
  9898774a; live 57/57, 27/27, 16/16; 108/108 download tests); V1-04/05/12 partial; new V2-01 (preparing downloads escape
  security sign-out), V2-02 (renew not atomic vs. sign-out/concurrent renew: 7/20 race, 10 URLs/9 dead), V2-03
  (`|`-joined idempotency key collides; hardening migration fails on legal distinct tuples), V2-04 (throttle starvation of
  large requests), V2-05 (accounting write blocks expiry cancel). Pre-existing timing failure
  TranscodingIntegrationTests.OnePlayerSeekingFarAndStraightBack… (also on 9898774a) → not DL.
- DL-S fix round 2 queued after 1b. Decisions: security generation on records, publish-ready re-check → revoked;
  capability responses re-check the session after waits; per-download lock + DB CAS, concurrent renewals return the
  winning URL; compound unique index (ViewerId, DeviceKey, ClientRef), fix the unshipped hardening migration; stable
  bucket capacity + FIFO reservations; accounting decoupled from cancellation (≤ 2 s).
- DL-C1 phase B: phone + Google TV done (device-found bugs fixed: 6fa75ef7, 7053e0bb, afb3c335, 495eb14d), iOS running.
  Device-hygiene incident: the iOS dev launcher lists every LAN Metro; "DL-C2 iPhone" attached to DL-C1's Metro 8082
  (wrong bundle). DL-C2 told to reconnect via explicit URL (127.0.0.1:8083), verify by the phone Library tab, re-take
  affected iPhone/iPad screenshots, always open Metro explicitly. Foreign sim "iPhone SE DE test" also on 8082 — left alone.
- DL-N fix round 1 progressing: 8aa2cfa6 Android integrity/ownership/lifecycle, 5dc806ba iOS task identity/validation/
  resume data (both after the 220a0ded interface commit); device verification next.
- DL-C2 phase B: Android phone + Android TV verified (31 screenshots); device-found fixes: bottom-sheet footer
  off-screen, label truncation, KB/s speed + progress label, pause/resume pending state, title links landing in Downloads
  (final 1ba5e125: Downloads out of the shared title group). "DL-C2 iPhone" (B070AD6C…) now explicitly on Metro 8083
  (no iPhone/iPad screenshots had been taken before) → iPhone, then iPad.
- Product note (pre-existing since My List, not a DL regression): iPhone's UITabBarController shows max 5 items; 6 phone
  tabs → "Start · Bibliothek · Meine Liste · Downloads · Mehr" (Einstellungen + Suche under "Mehr"; the search-role tab
  is not pulled out on the simulator). Android shows all 6. Left as is, raised to the user as an option.
- DL-S fix round 1b done (6c6c7de6 plan follows the picked version's language; a48a0755 journal): 4 new tests fail on
  the pre-fix source; downloads_check gets the Sherlock case. Merged into fb/downloads. DL-S now in fix round 2.
- DL-C1 phase B (iOS): downloaded MP4 on AVPlayer crashed ~3 s in (controls hide → subtitle lift back to 0 →
  patched expo-video assigns `item.textStyleRules = nil` → MediaToolbox CFArrayGetCount(NULL); HLS items survive).
  JS mitigation fb/dl-core 0f8f1829 (no lift for file:// on iOS). Native fix (assign [] / skip unchanged) handed to DL-N
  for its fix round + rebuild (patch-package regeneration of expo-video+57.0.5.patch).
- DL-C1 465adf63: offline progress/positions stamped on the server clock (offset from the Date header) — the Google TV
  emulator runs 1 h behind and its offline report was dropped as "older"; boxes without NTP would hit the same.
  Also 2f206c08 (one failed request is enough to probe the server), 495eb14d (remote starts on "Try again" offline).
- DL-S verify 2b (Codex, fb/dl-verify 94a3bad7): **pass** — V1-06 fixed (anchor language incl. multi-language primary,
  packs as candidates, anchor outside the candidate list, unplayable-language anchor); 0 new findings. Remaining DL-S
  open items: V1-04/05/12 remainders + V2-01..05 → DL-S fix round 2 (running).
- DL-S fix round 2 client semantics (fb/dl-server 4cd9ea7d, no shape change): preparing download + security sign-out →
  ready + fileUrlRevoked (no URL) → renew after sign-in, then engine `start` (no bytes yet); capability-bearing answers
  re-check the session at response time → 401 = normal sign-in handling; concurrent renewals return the same URL;
  idempotency (viewer, device, clientRef) as columns, deviceId trimmed + ASCII case-insensitive. Forwarded to DL-C1.
  DL-S remaining: full tests, live re-runs, Dev World publish, journal.
- DL-C1 phase B done on all three devices (3861f61d evidence, 8d711196; 29 screenshots; device-found fixes 6fa75ef7,
  7053e0bb, afb3c335, 495eb14d, 2f206c08, 465adf63, 0f8f1829). Queued for its next turn: merge fb/downloads (DL-S fix1 +
  1b), fix-round-2 semantics, nits (movie Play button, "no network" copy).
- DL-S fix round 2 done (4cd9ea7d fix, 29cc913d live race checks, c3e8b14d comments, 591724de journal): V2-01..05 +
  remainders of V1-04/05/12. Security generation per viewer, per-download lock + row-revision CAS, tuple unique index
  (new migration ViewerDownloadsLifecycle; unshipped hardening migration edited), FIFO bucket (1 s burst), background
  byte accounting. 8 new tests fail on a48a0755; server 1956/1970 (13 ffmpeg + versions-latency 364 ms under load
  avg ~45, passes alone), Usenet/Core/DevWorld green; live race 9/9 + 28/28 + 16/16. Snapshot re-published c3e8b14d.
  Merged into fb/downloads. DL-S verify 3 started (same Codex verifier, turn 4).
- DL-N a36493d1: native fix for the AVPlayer file crash (`applySubtitleLift` assigns `[]` instead of nil; patch
  regenerated with patch-package). Sim: unfixed build reproduces the crash; fixed build survives 8 lift cycles on a
  file:// MP4 (tx3g), HLS/WebVTT still lifts. tx3g cues do not visibly move with the lift on the sim. Decision: keep
  DL-C1's JS guard (no lift for file:// on iOS) — no visible benefit, defends binaries with the old patch; follow-up
  "re-evaluate on a real iPhone".
- DL-S verify 3 (Codex, fb/dl-verify 3595a4e0): **fail** — V2-01..05 + V1-05/12 remainders fixed, latency 12/12 (no
  regression); open: V3-01 major (security sign-out cancelled after commit leaves the old URL usable — rotation dispatched
  with the request token), V3-02 minor (graceful shutdown drops queued accounting), V3-03 minor (device ownership/list use
  raw DeviceId vs. normalized key). DL-S fix round 3 started. Decision V3-01: capability retirement inside the security
  transaction (scoped to revoked sessions), post-commit work on host token, startup/periodic lease reconciliation.
- DL-N fix round 1 done (220a0ded … a36493d1, bec40ef2): N1-01..17 + expo-video nil crash. Devices: emulator-5562
  (1 GiB through kill -9, network drops, APK reinstall, Wi-Fi only, 429, ETag switch, Task Manager stop, notification
  actions, SD unmount, server reset, swipe) and "DL-N iPhone" (pause/resume stress, terminate, force quit at 177 MB →
  Range + If-Range resume, 429, ETag pinned/unpinned, reset); all sha256 = server. Fake conformance with fb/dl-ui:
  2764/2764. Builds: /Volumes/DevSSD/Caches/streamarr-builds/dl-native-a36493d1/. Merged into fb/downloads (97d36070).
- DL-C1 request → DL-N fix round 1c: notification cancel while JS is not running must leave a `cancelled` tombstone in
  `list()` until remove (else the manager restarts the download). DL-N verify 2 (Codex) started on 97d36070.
  Client lanes told to merge fb/downloads and reinstall the a36493d1 dev clients.
- DL-N fix round 1c TS/fake committed (fb/dl-native 2a6e65a1): user-cancelled tombstone in `list()` until remove;
  start with a tombstone's id returns it unchanged; remove idempotent (unknown id resolves); cancel on a tombstone only
  forgets; tombstone owns no path; fake `controls.userCancel(id)`. Engine jest 124/124, 3 conformance tests fail
  without the rule. Forwarded to DL-C1 (merge fb/dl-native now for the launch test; idempotent handling incl. live
  event + tombstone on next launch). Native part + device check + Android build pending.
- DL-N verify 2 (Codex, fb/dl-verify-native b207e786): **fail** — N1 fixed 9 (01,02,04,10,11,12,13,15,17), partial 8
  (03,05,06,07,08,09,14,16); new N2-01 blocker (`.part` alias: another task's bytes published), N2-02 blocker (remove of a
  failed/volume task frees a path a stopping worker still writes), majors N2-03 iOS stale resume-data closure, N2-04 wall
  clock drives cooldown/12 h budget, N2-05 legacy `external-<n>` ids, N2-06 cancel resolves after a 10 s timeout without
  cleanup, N2-07 iOS range start unchecked, N2-08 iOS final callback ignores pending failure/requeue; minors N2-09
  zero-padded Retry-After, N2-10 client errors test on fb/downloads lacks 15 codes — integration artifact: all 15 are
  already translated on fb/dl-core and arrive with the DL-C1 merge.
- DL-N fix round 2 queued after 1c (decisions: claim final + staging paths incl. ancestors, `.part` paths rejected;
  drain records own paths through every stop; generation-checked async completions on iOS; sleep-inclusive elapsed
  clock + boot identity for deadlines/budget; versioned legacy-id rebind by `/storage/<UUID>/` only; cancel force-closes
  and never resolves on timeout (`cancel_pending`); iOS range start == didResumeAtOffset + strong ETag; final callback
  honours intents; leading zeroes stripped).
- DL-S fix round 3 done (2621d4c8 fix, 6be29f29 live checks, f6af73fd journal): V3-01 capability retirement inside
  the security transaction (scoped to revoked sessions) + 0.5 s lease reconciliation (also disabled / not-allowed
  viewers) + post-commit follow-ups of password/2FA/disable/delete off the request token; V3-02 per-batch cursor,
  requeue on shutdown; V3-03 one device-identity helper + data migration ViewerDownloadsDeviceIdentity. 10 new tests fail
  on 591724de, 5 guards pass both; server 1970/1983 (13 ffmpeg only), Usenet/Core/DevWorld green; live race 11/11
  (25/25 committed aborted sign-outs → old URL 410), 28/28, 16/16. Snapshot 6be29f29. Merged into fb/downloads.
  DL-S verify 4 started (same Codex verifier, turn 5).
- DL-C2 check-in (4 h): 50 screenshots (phone, Android TV, iPhone, iPad), latest fixes 20014530 (age-locked in sheet,
  checking free space), 7dd63a9d (UI follows its own record), 908f7fec (held-back downloads never offer retry). Review:
  VLC candidates still render the shared `reasons.vlc_fallback` ("Der eingebaute Player kann … nicht abspielen") in the
  download sheet → hide it there (VLC chip suffices, optional positive line); iPhone home screenshot shows the dev-client
  update banner → avoid in final shots; fb/downloads 319cc2dc not merged yet.
- DL-C1 device finding (emulator-5554, a36493d1): resume of a 403-blocked task at app foreground → replaced UIDT host's
  late `hostStopped(CANCELLED_BY_APP)` clears engine host state while the new job stays active → task `queued` > 3 min
  until Pause/Resume. Forwarded to DL-N as **N2-11** (host token per start, stale callbacks ignored; no replace while a
  host is requested/active; 15 s self-heal watchdog; device repro 10×). DL-C1 client side of "allowed again → resume on
  kept bytes" verified on device (1,919,640 B kept, no re-download); blocked row no longer shows Pause.
- DL-N fix round 2 interface/fake committed (fb/dl-native af135dd5): `.part` paths → invalid_argument, claims cover
  final + `.part` incl. ancestors/descendants; cancel/remove resolve only after the transfer ended, else `io`
  `cancel_pending`/`remove_pending` after 30 s (retry); remove deletes a failed task's `.part`; deadlines on a
  sleep-inclusive elapsed clock, `retryAt` display only (`restoreWait()` corpus); zero-padded Retry-After; fake
  `stallDrain`/`releaseDrain`, `wallNow`. Engine jest 145/145; scratch with dl-core e4bc6659: 493/493 in downloads+screens.
  Forwarded to DL-C1 (pending-cancel/remove = "removing", retry, never a failure) and DL-C2 ("Wird entfernt…").
- DL-S verify 4 (Codex, fb/dl-verify a0f95ea2): **pass with findings** — all 25 earlier findings (V1-01..17,
  V2-01..05, V3-01..03) fixed; only V4-01 minor (reconciliation sweep / post-commit follow-up cancel by download id →
  truncate a valid renewed transfer; no access leak, retry works). DL-S fix round 4 started. Decision: cancellation
  targets lease instances by capability identity; follow-up carries retired capability ids; explicit "all leases" only
  for delete/complete/admin revoke.
- Device map update: serials move when AVDs restart. Now emulator-5560 = Streamarr_Phone_DLN (DL-N), emulator-5554 =
  Streamarr_Phone (DL-C1), emulator-5558 = Streamarr_GoogleTV13_1080p (DL-C1), emulator-5556 = Streamarr_GoogleTV_1080p
  (DL-C2); DL-C2's Streamarr_Phone_DL2 is shut down and gets a new serial on boot. Rule for all lanes: identify devices by
  `adb -s <serial> emu avd name` / simulator name, never by a remembered serial. DL-C2 handled it correctly (did not
  install on 5560; iOS deep link to 8083 only, no launcher tap).
- DL-N check-in (1 h into turn 3): fix round 1c done (2903f9e9 iOS symmetric tombstone path, 7ab0a379 journal: device
  check + builds); fix round 2 native committed (42a7317f Android: staging claims, drains for every stop, bounded cancel,
  elapsed clock; 8e2cdc39 iOS: identity-checked completions, resume offset, final-callback intents, continuous clock;
  1c044293 test server stall/shifted Content-Range/TLS). Pending: N2-11 host race, device checks, builds. fb/downloads
  waits for the final head (no partial merge).
- DL-S fix round 4 done (3c776497 fix: cancel lease instances/capabilities, never a download id alone; 464a7952 live
  check; d0c74a18 test timing under load; 3752e5ad journal). Both verifier schedules fail on f6af73fd and pass now;
  affected 286/286; server 1979/1992 (13 ffmpeg only); live 12/12 (renewed URL completes 1,000,000 B, old URL 410),
  28/28, 16/16. Snapshot 3752e5ad. Merged into fb/downloads (b5dab8df). Verify 4b (final server check) started.
- DL-S verify 4b (Codex, fb/dl-verify f8d0cd24): **fail** for the whole server lane — V4-01 fixed, all 26 earlier
  findings closed, but **V4b-01 major** regression from 3c776497: lease status read after the governor lock touches a
  disposed CancellationTokenSource → ObjectDisposedException; `ExpireDue` runs outside the sweep's recovery catch → the
  hosted service faults → default StopHost stops the server (56–182/2000 parallel trials; 0/2000 on f6af73fd).
  DL-S fix round 5 started. Decisions: disposal-safe leases (cached token, Interlocked flags, idempotent abort),
  per-lease isolation, the whole maintenance iteration inside one recovery catch (audit all download hosted services),
  no host-wide behaviour change; host-survival test with the real service under StopHost.
- Decision "removing" (DL-C2 question → DL-C1 spec): `OfflineDownloadState` gains `'removing'` + `isRemovingDownload`;
  set synchronously/persisted on every removal path (incl. unsolicited cancel + tombstone); not ACTIVE, no badge/counts/
  committed space; record keeps its fields. Order: state → engine cancel/remove (retry on *_pending) → media files →
  record → artwork → server DELETE via persisted outbox (local removal never waits for the server; works offline).
  Re-download of the same work refused while removing (`work_removing` → "Wird entfernt…"). UI: subdued row, no
  actions, label after ~600 ms. DL-C1 commits type/helper first for DL-C2.
- DL-C1 revoked-link device check (a36493d1, fb/dl-core + DL-S round 4; jest 2707/2707): Google TV 13 (D-pad) PASS and
  Android phone PASS — resumed request served exactly total − kept bytes, 0 restarts; sign-out-while-preparing PASS on
  the phone. **iPhone Air: bytes lost** — after the 410 the engine reports bytesWritten 166 (the 410 body), no partial;
  renew + resume re-downloads the whole file (correct result, wasted transfer). Forwarded to DL-N as **N2-12** (non-2xx
  body never becomes task content; keep the best resume state across failed retries; changed URL → Range + If-Range from
  the kept offset; same for 403; Android parity test). Side evidence from a DL-C1 helper artifact (session_limit
  sign-out): finished file stays, completion waits for sign-in. Helper fixed.
- DL-S fix round 5 done (02f77612, e5a94883): V4b-01 — disposal-safe leases, per-lease isolation, maintenance loops
  never stop the host (StopHost unchanged). 14 of 15 new tests fail on 3752e5ad; lease-probe 15/15, expiry-race 0/2000;
  server 1994/2007 (13 ffmpeg only); live 12/12, 28/28, 16/16. Snapshot e5a94883. Merged into fb/downloads (7aab396f).
  Verify 4c (final server check) started.
- DL-C1 check-in (4 h into turn 2): steady — 80a2adc6 (signed-out profile told its downloads continue after sign-in),
  revoked-link device evidence committed (c69f8447), merged DL-N 1c TS/fake (fbbffb92). Still queued for it: removing
  state (first commit for DL-C2), DL-N round-2 semantics (cancel/remove pending, retryAt display only), DL-S round 5
  merge (7aab396f), movie Play button + "no network" copy.
- DL-S verify 4c (Codex, fb/dl-verify 95bd831f): **pass with findings** for the whole server lane — V4b-01 fixed, all
  27 prior findings closed, 360/360; only V4c-01 minor (recoverable maintenance failures logged at Debug only, no
  escalation). DL-S fix round 6 (diagnostics): consecutive-failure counters per maintenance component, warning at 3 +
  every 5 min, recovery info, `degraded` state in the admin activity DTO + web warning line.
- Process correction: messages sent with `delivery: queue` wait until the subagent's turn ends — DL-C1 never received
  the removing spec / DL-N round-2 semantics mid-turn (it read DL.md instead), DL-N never got N2-12. From now on: steer
  for anything a running lane needs; re-sent N2-12 + device-serial note to DL-N with steer. DL-C1 answered: merge
  fb/dl-native at 3fc66a7d (TS unchanged since af135dd5), keep a36493d1 dev clients, match `io` +
  `cancel_pending`/`remove_pending` exactly. Correction to the 4 h check-in: movie Play button + "no network" copy
  were already done in 9da3fafa. DL-C2 already applied the VLC wording ("Spielt auf diesem Gerät mit VLC").
- DL-C1 a519c97b: `'removing'` state + `isRemovingDownload` + locale `downloads.state.removing` (type first). Forwarded to
  DL-C2 with steer (merge fb/dl-core, switch its predicate). DL-C1 next: merge fb/dl-native 3fc66a7d, removal order,
  `work_removing`, pending retries.
- DL-C2 turn ended (fb/dl-ui 238728f2; merged fb/dl-core b4a5e203 incl. a519c97b + DL-N round 2 TS, and fb/downloads
  7aab396f; typecheck/lint 0, jest 276/2854). Done: removing UI 8c37f4e4 (greyed in place, label after delay, sheet/
  detail blocked per work), VLC wording, notification screenshots (running/paused with Pause/Cancel). Waiting for:
  DL-C1 removal order (`work_removing`, pending retries) → end-to-end removing test; DL-N final dev clients → re-take
  device screenshots. Idle devices: emulator-5556. Argent 0.23 → 0.32 update needs the user's OK (not done).
- DL-N N2-12 root cause (device repro with a revoke-mid-body knob): not resume data — the iOS background session retries
  inside the same task (Range + If-Range, no engine callback); a 410/403/5xx answer makes the OS truncate its in-progress
  file in place to the error body. DL-N fixes: non-2xx never content; kept resume state across engine retries; changed URL
  → Range + If-Range from kept bytes; best-effort APFS clone of the OS partial while the app runs. Also fixing its own
  round-2 regression (in-task OS resume after a reset rejected by N2-07 → full re-download).
- Decision (orchestrator, reversible): **no server grace period** for revoked capabilities (security over bandwidth).
  Known limitation: iOS app suspended at the moment of a security sign-out → partial lost, restart from 0 after sign-in;
  Android keeps bytes. Clone guards: length = min(file size, last reported totalBytesWritten) (no preallocated zero tail),
  missing temp file → skip, owned/reserved/cleaned like the partial, sha256 device proof. Limitation goes into the user
  docs at integration.
- DL-S fix round 6 question (startup resume one-shot vs. retried): decided **A** — the resume retries on every sweep
  tick until it succeeds once (a DB down at startup no longer leaves preparations stuck); idempotent (each queued
  preparation starts exactly once, no conflict with request-started ones), never blocks the sweep's other work, own
  tracker (degraded at 3, one recovery info). Warning text changed → verifier filters on "(open transfer check)".
- DL-N check-in (2 h into turn 3): progressing — b1340937 (N2-11 Android host race), 3fc66a7d (iOS https→http);
  N2-12 work in the tree (iOS engine, Swift host check, test server revoke knob). Pending: N2-12 commit, Android parity
  test, device runs, final dev clients. No action needed.
- DL-C1 cbd37532 (+ journal 7f6b06aa): removal pipeline in order (removing → engine with exact *_pending retry →
  media → outbox + record → artwork → server DELETE via persisted outbox, flushed at launch and every wake),
  `work_removing` on re-download, `useDownloadFor` returns removing records, counts/badge/bytesOnDevice skip them,
  `isFinishedRow`; engine `retryAt` display-only. jest 269/2755. DL-C1 next: short phone check of the removal, then done.
- DL-C2 resumed (turn 2, jest only): merge fb/dl-core cbd37532, end-to-end removing tests (stallDrain/releaseDrain,
  re-download blocked/unblocked, no label flicker on removeAll). Final device/screenshot pass waits for DL-N's clients.
- DL-S fix round 6 done (50278ff4 escalation + admin `maintenance` state, 0a248051 web warning line, a0e2e1a6 docs,
  e2874df2 journal): per-component trackers (sweep, accounting, resume, failureRecord), warning at 3 + every 5 min,
  recovery info; startup resume per decision A. 7 new tests (equivalent probes fail on e5a94883); affected 367/367;
  server 2001/2014 (13 ffmpeg only); web 331/331; live 12/12, 28/28, 16/16. Snapshot e2874df2. Merged into fb/downloads
  (b06f4d91). Verify 4d (final server check) started. Builder turn finished; server lane done pending 4d.
- **DL-S verify 4d (Codex, fb/dl-verify 50b823bf): PASS — server lane done.** All 28 findings across rounds 1–4c
  closed (V1-01..17, V2-01..05, V3-01..03, V4-01, V4b-01, V4c-01), no new findings. Verifier reports merged into
  fb/downloads (3971d178; reports + `tools/dl-verify/` probes only — decide at the main merge whether the probes stay).
  Server builder (fc7fda8a) and server verifier (634a9e29) are idle; keep the dl-server worktree (Dev World snapshot
  cache) until the snapshot is re-published from main.
- DL-C1 removal checked on the Android phone (e6ee4164); 2aacbf45 (`filePathOf` never ends in `.part`); fa42dacb
  (pending cancel/remove retry backoff 1 s → 30 s; removing-spec tests: tombstone at launch via removing, offline DELETE
  drained on reconnect, 401 kept until sign-in / 404 done, useDownloadFor exposes removing while counts/badge skip it).
  Related suites 75/75 (554). DL-C2 steered to merge fa42dacb (advance fake timers past the first retry).
- **DL-C1 turn 2 done** (fb/dl-core fa42dacb, clean): removal pipeline + backoff + spec tests; removal checked on
  emulator-5554 (finished, in progress, simulated slow drain). Open for DL-C1 (final device pass, after DL-N's final
  clients): merge fb/downloads b06f4d91 (only schema.d.ts +25), iPhone revoked-link re-run for N2-12 (expect served =
  total − kept), real cancel_pending/remove_pending + removing row on phone and Google TV (D-pad).
- DL-N still in turn 3: N2-12 device follow-ups (799b4668 real resume-data key / unverified in-task continuations /
  faster clones, 1d77c7ca clone on resume data, 8574a70e no restart count for adopted tasks).
- **DL-C2 turn 2 done** (fb/dl-ui ba033aae, clean; merged fb/dl-core fa42dacb): one removing row implementation (DL-C1's
  in DownloadsLibrary, DL-C2's duplicate removed), sheet uses core `work_removing` text; 3 removing e2e tests through
  the core + fake engine (stalled drain row, re-download blocked/unblocked on detail + sheet, fast season removal without
  label), each fails when broken. Node 24: typecheck 0, lint 0, jest 278/2880. Note: expo-router `renderRouter` installs
  fresh fake timers per call → open the screen first, then advance timers.
- DL-N journal says fix rounds 1, 1c, 2 done (de2502ed incl. known limitations; e8729b14/f1b25ae7 N2-04 clock correction
  per steer). Waiting for its final report + build paths, then: merge fb/dl-native → fb/downloads, DL-N verify 3, client
  code verify 2, final device/screenshot passes for DL-C1 and DL-C2.
- DL-N turn 3 done (fix rounds 1c + 2 + N2-11 host race + N2-12 iOS in-task retry; error body logged ≤ 256 B, never
  content; flaky retryAt test fixed; JVM 66/66, Swift host 57/57, corpus 754/754). Dev clients:
  /Volumes/DevSSD/Caches/streamarr-builds/dl-native-86a52014/. Merged into fb/downloads (0144e7db). DL-N verify 3
  (Codex, same verifier) started. Next for downloads: client verify 2, final device passes DL-C1/DL-C2 on 86a52014.
- 2026-11-07 ~04:10 owner reported two box bugs while watching Spider-Man (separate from DL): (1) frame drops in motion
  scenes (orchestrator investigates; box log shows the display stayed at 60 Hz for the 23.976 fps film on the
  Streamybox render path), (2) box went to standby/screensaver after 10 min during playback → Streamybox session
  c3439475 (feat/video-keep-awake) + Streamarr side: the streamybox engine never keeps the screen on.
- Recovery after an expired token mid-turn (2026-11-07 ~05:00). State found: Streamybox keep-awake session c3439475
  **done** (streamybox `feat/video-keep-awake` cb53dfdd..154a9b87; host 443/443, emulator 15/15 + 13/13; box test
  waits for the owner's OK). Codex DL-N verify 3 (536fa310) **refused** by OpenAI's cyber filter mid-turn → restarted
  with Claude (4ccb1d05) on the same worktree (it left uncommitted harness edits, the new verifier reviews them).
- Frame drops (owner, Spider-Man DV P8 4K23.976, E-AC3 bitstream): display stayed 4K60 for the whole film on the
  Streamybox render path (client vote never took effect; docs/59 box check "client switches via setFrameRate" was never
  ticked), while the ExoPlayer path matched 4K24/4K25 (docs/74). Separately the BSP has no true 23.976/29.97/59.94
  modes (docs/04), so bitstream playback at 24.000 Hz repeats a frame every ~41.7 s. Spawned:
  **FR** (Streamarr, e10c9d0f, worktree `../streamarr-worktrees/fr-streamybox`, branch `fix/streamybox-frame-rate`
  off main, AVD sbx_player_embed :5580, Metro 8086) — client vote root cause + fix;
  **Streamybox fractional-refresh** (ff38462c, `feat/fractional-refresh`, sbx_tv_sys :5564) — true fractional modes
  in the same config group + render-path cadence at 24/23.976 Hz on the box. Box use only after the owner's OK
  (TV + AVR wake via CEC); one coordinated window for keep-awake + FR + fractional.
- Owner decision 2026-11-07 ~05:20: **box only when the owner says so** (agents prepare, then wait).
- **FR done offline (partial, e10c9d0f)** — fix/streamybox-frame-rate 3aa4a6a4, bf067fde, 72a1b90d, 03f69c63: on the
  emulator the vote lands on the SurfaceView BLAST layer (`23.98 Hz ExactOrMultiple OnlySeamless`) when mpv reports a
  rate. Client bugs fixed: no vote without container fps (now falls back to the server's ffprobe `mediaInfo.video.fps`),
  a rate-less tracks event zeroed the remembered rate (stale vote on the layer), never cleared on stop/end/error, silent
  failures (one log line per vote now). JVM 8/8, jest 234/2437. Box evidence: 11-07 HWC never attempted a mode change;
  11-05 one Streamybox session switched to 4K24 then fell back to 60 Hz 0.85 s later (bridge park + HDMI replug) → one
  live SF dump decides "vote missing" vs "vote lost". Prepared: `~/.cache/fr/streamarr-0.21.3-box-fr-21003.apk`
  (local branch `fr/box-build` = fix/box-playback-20261106 + FR, same signer), rollback APK pulled, capture script.
  Box plan A (diagnose current build 4 min) + B (install, verify 4K24/60 Hz return, 7 min). VLC renders into a
  TextureView → no layer to vote (follow-up).
- **Streamybox fractional-refresh done offline (ff38462c)** — feat/fractional-refresh 0e616820, 823ceb21: kernel and
  EDID already have 23.976/29.97/59.94/119.88; the RK HWC `DrmMode::v_refresh()` returns the rounded integer, so the
  fractional twins were deduped away. One-instruction HWC patch (precise clock×1000/(h·v)), twins stay in config group 0
  (seamless), composer 06521326 → a7ecdecc, overlay-only, rollback = push 06521326 + reboot. Tests: Unicorn 9/9, refresh
  policy 61/61, Settings DisplayModesTest. Box window ~15 min incl. a quiet cold restart (`reboot_quiet` / Settings
  › System › "Jetzt leise neu starten"), cadence measurement 23.976 vote vs 24.000 control (dclk 296703 vs 297000).
- **DL-N verify 3 (Claude, 4ccb1d05, fb/dl-verify-native d9d3a2fd): pass with findings** — N2-01/02 blockers and all
  round-2 majors fixed (revert spot checks confirm the regressions); new N3-01 major (iOS OS-file clone heuristic can
  take a neighbour's partial), N3-02..09 minors, N3-10/11 nits; N2-10 is DL-C1's (codes already on fb/dl-core).
  DL-N fix round 3 started (decisions: no clone without exact identity; registered tasks own their `.part`; reject
  trailing-dot/space segments; sync before durable; persisted dispose list; tombstone cancel awaits drain; redact error
  bodies; no API-33 call + lint NewApi; per-generation tails; honest v1 migration; connection/stop under writeLock).
- DL-N fix round 3 TS/fake committed (fb/dl-native acca869f; engine jest 148/148): N3-02 move/deletePath reject paths of
  registered non-completed tasks (completed final file + tombstone path stay the caller's); N3-03 `invalid_argument` for
  segments ending in `.`/space on every volume; N3-06 tombstone cancel waits like remove (`cancel_pending`). DL-N flagged
  that `safeFileName` keeps trailing dots → DL-C1 turn 3 started (merge acca869f, strip trailing dots/spaces, audit all
  deletePath/move call sites incl. the orphan sweep, tombstone cancel test). Native part of round 3 still running.
- DL-C1 turn 3 done (fb/dl-core f1c846dd merge acca869f + DL-S round 6, fafb35f8, 35e4ad46): N3-03 `safeFileName`
  strips trailing dots/spaces; N3-02 every deletePath only after the engine released the id (orphan sweep never
  touches a held paused/failed task); N3-06 found a real bug — reconcile awaited each removal/orphan stop in its loop,
  so one stalled drain held up re-attaching every other download → removals now run in the background. Node 24:
  typecheck 0, lint 0 errors, jest 269/2769.
- Decision (sign-out with "Delete downloads"): never wait for drains — mark removing + enqueue DELETEs, flush the
  account's outbox with the still-valid token (≤ 5 s, ≤ 4 parallel), then sign out; local removal continues in the
  background; leftovers wait for that account's next sign-in, never another account's token; account removal drops
  them. DL-C1 turn 4 started (jest only).
- DL-C1 turn 4 done (fb/dl-core b136ab5d, 564f784a): sign-out with "Delete downloads" marks removing + queues DELETEs,
  flushes that profile's outbox (≤ 4 parallel, ≤ 5 s) with the still-valid session, then signs out; local removal runs
  on in the background. Found by the new tests: a 401 now parks that profile's queue until its next sign-in (before:
  every finishing removal re-flushed with the dead session); a never-answering DELETE times out after 30 s and stays
  queued (before: blocked the queue for good); per-profile `reconcileServers` so one hanging server can't hold another.
  Profile removal drops leftovers. Node 24: typecheck 0, lint 0, jest 271/2775 (one unrelated worker SIGSEGV at load 19
  on the first run, green on rerun). DL-C2 needs to merge fb/dl-core b136ab5d before its final pass.
- DL-N check-in (1 h into turn 4, fix round 3): cb107891 Android (dispose list, path rules, sync, redacted diagnostics),
  87411d06 iOS (no guessed OS file, path rules, redacted diagnostics), a23bc812 iOS paused partial found by its
  resume-data name. Device checks + builds pending. No action needed.
