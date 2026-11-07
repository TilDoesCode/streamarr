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
- **DL-N fix round 3 done** (acca869f, cb107891, 87411d06, a23bc812, efd0572a): N3-01..11 + iOS paused partial in
  `tmp/` + Android 7 NotificationChannel guard (lint NewApi now an error). JVM 76/76, Swift 767/767 + 67/67, engine
  jest 148/148. Known limitations added: SD unmount kills the app (vold SIGINT); iOS nsurlsessiond logs request URLs.
  Builds: dl-native-a23bc812. Merged into fb/downloads (8b01952e) together with fb/dl-core 564f784a (44fa38ad) →
  N2-10 closed (errors.test.ts passes), integration typecheck 0.
- Decision: **DL-N fix round 3b** — iOS early-identity cycle (once per task after the first validated MiB:
  cancelByProducingResumeData → record the temp-file identity → resume), so connection drops and mid-transfer
  revocations keep bytes again without guessing; fallback = strict restart; no event flicker; iOS build only.
- Started: DL-N verify 4 (Claude 4ccb1d05, on 44fa38ad); DL-C2 final pass (merge fb/downloads → report hash → final
  screenshot set on phone/TV/iPhone/iPad with a23bc812 builds); DL-C1 final pass part 1 (Android: removing with real
  drains, notification cancel/pause, sign-out with delete, N2-11 5×, offline play + sync). DL-C1 iPhone part waits for 3b.
- DL-C2 final pass step 1: fb/dl-ui c2cd2b4d (= ba033aae + fb/downloads 44fa38ad, clean). Merged into fb/downloads
  (100da883). Integration check (orchestrator, Node 24.14): typecheck 0, full jest 280 suites / 2895 tests, 0 failed.
  DL-C2 continues with devices (a23bc812 builds, final screenshot set). Client verify 2 started (same Codex verifier
  efbf1846, turn 2, on 100da883; fall back to Claude if the provider refuses).
- DL-C1 final Android pass found local-playback bugs (phone, a23bc812 client): (1) "Resume from X" starts at 0:00 on
  VLC (Elephants Dream) and at ~0:03 on native (Sprite Fright), and the playback then overwrote the stored local
  positions with 0; (2) later, records with engine 'native' loaded VlcEngine with startPosition null, reloaded 4× at
  0:00 and ended in "network_unreachable" while online with the file on disk; (3) one recovery reload at 0:00 on the
  first native offline start; (4) buffer poll every 5 s for local playbacks (404). Offline play itself + progress sync
  with real occurredAt OK. Decision: **fix in this turn** (core of the feature, position loss = data loss): failing
  tests first; resume within ±3 s before counting as started; no position save/report before the target is reached,
  recovery reload never at 0, no smaller overwrite in the first 10 s; saved engine first, one non-sticky fallback;
  no network error classes for local files, ≤ 2 reloads; no server calls for local playbacks; streaming unchanged,
  shared-code fixes in a separate commit for a cherry-pick to main; device re-check on phone + Google TV.
- **DL-N verify 4 (Claude 4ccb1d05, fb/dl-verify-native d93b329b): pass with findings** — every N1/N2/N3 finding
  fixed; revert spot checks (N3-01, N3-02 Android+iOS, N3-05 ×3, N3-06) all caught by the builder's tests; APK scan: 18
  calls above minSdk 24, all guarded; lock stress 450 ops no deadlock. New: N4-01 minor (1–3-char query replaced first
  → capability fragments leak, 558/1500 fuzz; Streamarr URLs have no query → not affected today), N4-02 minor (removal
  while the SD card is out leaves a stale progress notification with actions, also across relaunches), N4-03 nit
  (pre-round-3 dev records with dot/space-only segments own no path). Folded into DL-N fix round 3b (steer): long-token
  rule first + no global replace < 8 chars + shared fuzz corpus; disposals never drive the notification, 7-day expiry;
  legacy records → failed `invalid_legacy_path` owning their folder. Rebuild both dev clients at the end of 3b.
- **Client verify 2 (Codex efbf1846, fb/dl-verify-client d056c375): fail** — round 1: 23 fixed, C1-21/C1-24 partial,
  C1-26 regressed (multiline comments); new 7 majors + 3 minors, all reproduced: C2-01 orphan DELETE bypasses the
  outbox/401 park; C2-02 stale flush 401 parks the new session; C2-03 failed media/folder deletion drops the record →
  1 GiB file orphaned forever; C2-04 list reply racing a prepare deletes the live preparation; C2-05 revoked-link GET
  resumes a download the viewer paused meanwhile; C2-06 one global server-clock offset (server B's Date skews A);
  C2-07 wall-clock correction offline applies the old offset twice (−3599 s); C2-08 unknown age verdict stays playable
  under a restricted policy; C2-09 (UI) series Play on an all-locked series; C2-10 one hung profile list blocks
  another profile's queued start at launch. Baseline green (280/2895).
- Decisions → DL-C1 fix round 2 (queued after its current turn): all DELETEs via the outbox + session guard, launch
  pumps local work before housekeeping, per-profile independent scans; session generations for flushes; persisted
  cleanup jobs before dropping records; reconcile by (deviceId, clientRef) and never orphan an unresolved POST; intent
  generation re-checked after every await; server clock per serverKey, anchored to the engine's new `clock()`
  {elapsedMs, bootId} (asked DL-N, additive) with `clockEstimated` after reboot and a merge window; `accessVerified` +
  lock `age_unverified` under restricted policies, revalidation independent of snapshots; offline shell wins over a
  forced password change while the server is unreachable, queries pause offline; one-line comments. DL-C2 (steer):
  C2-09 + `age_unverified` UI.
- DL-N 3b progress: 567385fe iOS early-identity cycle; 35e07e7f engine `clock()` TS/fake (sync JSI, never throws;
  `processClock()` fallback with `process-…` bootId for builds without the native part; fake `advanceElapsed`/`reboot`).
  Accepted deviation: iOS bootId = `kern.bootsessionuuid` (kern.boottime shifts on wall-clock steps, i.e. exactly the
  C2-07 case). Forwarded to DL-C1 (queued with its fix round 2; `process-` bootId ⇒ treat each start as a new boot,
  stamps `clockEstimated`). Note: launch `sweepOrphan` removes native tasks without a core record (expected; device
  tests must go through the manager).
- DL-C1 e223a575 (local-gated, streaming unchanged, no shared-code root cause → no cherry-pick): corrected root cause —
  "resume ignored / positions zeroed" was **tooling**: Argent 0.23.0 taps on a rotated Android screen land at the
  rotated point, so "Resume" taps hit "From the start" (controller.chosenStart = 0); with adb taps both engines resume
  correctly online and offline (timecode screenshots). Genuine bugs fixed with failing tests first: local engine
  failures classified as network (4 reloads → "Can't reach the server") → ≤ 2 reloads 1 s/2 s, VLC once at the position,
  local card / download_file_missing; buffer poll + lost-playback check for local ids; an outside forced engine
  overrode a native record. Position rules per spec. Native→VLC trigger of the 16:00 run not reproducible (6 tries);
  the chain after it is fixed. jest 271/2785 (F10 matrix green). Device re-check + download scenarios continue.
  DL-C2 warned about the rotated-tap bug (adb taps / D-pad, verify after each tap, retake suspect shots). Argent
  0.23 → 0.32 now has a concrete reason (rotated taps) — still needs the owner's OK (shared tool; other sessions).
- DL-C1 c4a64a64 (streaming too): a resume started from the home Continue card while the screen rotated made
  expo-video's StartSeek judge stale readings, give up after two tries and keep the black start cover over the playing
  picture until the end; the cover now also goes once the clock is at the target (±3 s), a clock stuck at 0:00 keeps it
  (S9c seg_corrupt still green). Possibly the trigger of this morning's immediate-start failures. Device-verified with
  e223a575: native resume online 2:08 → 2:10, network cut mid local play doesn't interrupt, stop at 151.185 s → local =
  server = 151.185 (lastPlayedAt = the offline stop's occurredAt). DL-C2 steered to merge c4a64a64.
- Hotfix branch for main: `fix/player-start-cover` (worktree `../streamarr-worktrees/player-start-cover`, off main
  ed8e104e) = cherry-pick -x of c4a64a64 → c1321ed3. On it: typecheck 0, player + player-screen jest 78/1264. Not merged —
  the owner decides (also relevant for the box build branch fix/box-playback-20261106).
- DL-N check-in (1 h into turn 5): 3b code committed — 567385fe iOS identity cycle, 35e07e7f/e2520225 engine `clock()`
  TS + native, c71ce7fa N4-01 redaction order, 88b4da87 N4-02 stale notification / N4-03 legacy dot segments. Pending:
  device runs (identity cycle cut/revoke/neighbour, SD card notification), journal, rebuilt dev clients. No action.
- DL-C2 check-in (1 h into turn 3): merged fb/dl-core c4a64a64; C2-09 (083dfc2b) and C2-08 UI `age_unverified` lock
  (c82f08f9) done; detail card names its state once (dd1afc1c); final phone set committed (518226c3, de + en);
  45 final screenshots so far, TV set in progress (D-pad focus visible), then iPhone/iPad. No action needed.
- DL-C1 check-in (1 h into turn 5): after e223a575/c4a64a64 it is on the device re-check + remaining Android scenarios
  (14 files in progress, 23 final screenshots). Queued for it: fix round 2 (client verify 2) incl. engine `clock()`
  (fb/dl-native 35e07e7f). No action.
- DL-C1 device finding → **DL-N D-01 (fix round 3c, steer)**: a paused or user-stopped Android download loses its whole
  partial at the next launch (notification Pause at 685,360 B → force-stop → relaunch: persisted `paused,
  bytesWritten 0`, `.part` trimmed to 0; Task-Manager stop at 1,170,362 B → same). Cause: `SYNC_BYTES = 16 MiB`, no time
  bound, no sync on pause; `recoverPart` trims to the last checkpoint. Decisions: checkpoint (flush + fsync + persist)
  before every state change that stops the transfer; running cadence 8 MiB or 5 s; same-boot recovery adopts the actual
  partial length (bootId persisted with checkpoints; page cache survives process death), a different/unknown boot trims
  to the checkpoint; iOS parity check; device repro incl. `adb reboot`. Both dev clients rebuilt after 3c (replace 3b).
  DL-N had just committed its 3b journal (3f185a78).
- DL-C2 device finding → **DL-N D-02 (3c, steer)**: iOS a23bc812 client, Sintel throttled, `allowDownloads` off → body
  cut at 2,407,796 B, 403 → "Angehalten · 2 MB"; allowed again → renew + resume → `downloading` at 83,536 B with
  `restarts: 0` (started over). Most likely the N3-01 trade-off on a never-paused task in a pre-3b build (3b identity
  cycle should fix it); DL-N to verify the 403 path after/before the cycle on iOS and once on Android, and to fix the
  bookkeeping (`restarts + 1` whenever kept bytes are dropped). DL-N D-01 code is in (256f2c51); 3c device runs +
  builds pending. DL-C2 keeps its blocked-row shot, defers the iPhone "allowed again" step to the 3c build.
  DL-C2 extra fixes: dd1afc1c (detail card state once), 083dfc2b (C2-09), c82f08f9 (C2-08 UI), 23851f79 (movie title
  while preparing); full jest 282/2915 after the c4a64a64 merge.
- **DL-C1 fix round 2 done** (fb/dl-core b15e24bd core C2-01..08/10 + C1-21 + C1-26, 069e133c C1-24, journal 4f03406b;
  based on merge 722cf81c = fb/downloads bc6306ca). Node 24: typecheck 0, lint 0, jest 288/2938; verifier repros are
  regular tests. Notes: `lockOf()` → `'age_unverified'`; `LocalStart` locked has `reason`; `recordPosition(…, {at,
  restarted})`; `onPosition(s, d, restarted)`; C1-24 makes `['account', …]` queries `networkMode: 'online'` on native.
  C2-04 fixed via in-flight-POST guard + re-check after the list (DownloadResponse lacks clientRef/deviceId).
- Follow-ups sent: DL-C1 (steer) wire `setElapsedClock(() => downloadEngine.clock())` (35e07e7f) + tests, no
  change-password frame before reachability is known; DL-C2 (steer) merge 4f03406b, real `age_unverified`, API shape
  changes, port round2-library + round2-offline-link; **DL-S 7** (server builder turn 8): additive `clientRef` +
  `deviceId` on DownloadResponse and viewer list items (not in the admin DTO), schemas regenerated, snapshot
  re-published — lets the client adopt instead of orphan-delete after a crash between POST and persist.
- DL-C1 clock follow-up done (fb/dl-core e3d4628e merge fb/dl-native 5410255b, 9e60c20b server clock on
  `downloadEngine.clock()` — `process-` boot ids always estimates, 2df94d5a no change-password frame before the first
  probe answers, 434cf559 journal). Node 24: typecheck 0, lint 0, jest 290/2966. DL-C1 remaining: iPhone part of the
  final pass (needs DL-N 3c builds: revoked link N2-12/D-02, identity cycle), clientRef adoption test once DL-S 7 lands.
  Android final pass evidence in `screenshots/DL-C1/final/` (26).
- **DL-N fix rounds 3b + 3c done** (567385fe identity cycle, 35e07e7f/e2520225 clock, c71ce7fa N4-01, 88b4da87
  N4-02/03, d51d7b66, 256f2c51 D-01, 5410255b D-02, 08e10d6e journal). Devices: Android — pause → force-stop → resume
  `Range: bytes=786432-`, `am stop-app` kept all 1,310,720 B, `adb reboot` trims to checkpoint 4,983,616 and resumes,
  DL-C2's 403 cut resumes `Range: bytes=2407796-`; iOS — pause → force quit → resume at 4,980,736, 403 after the
  identity cycle keeps 20,338,776 B (`restarts` 0), 403 within 500 KB → clean restart (`restarts` 1); sha256 = server
  every time. Checks: tsc 0, engine jest 169/169, JVM 92/92, Swift 773/773 + 81/81, Android lint 0. Notification Pause
  driven via the engine API (shade not automatable). Builds: dl-native-5410255b (replace a23bc812/88b4da87).
- Integration: fb/dl-native → 7977908c, fb/dl-ui 0a4d85e7 → ddd27fd0... (order: dl-ui ddd27fd0, dl-core fa7064a3);
  orchestrator check: typecheck 0, full jest 293 suites / 2979 tests, 0 failed.
- Started: DL-C1 final pass part 2 (iPhone on 5410255b: revoked link, connection drop, pause/force quit, offline play
  with real bootId, sign-out delete; Android re-check of D-01/D-02 + local resume); DL-C2 steered to the new builds +
  the deferred iPhone "allowed again → continues" step; DL-N verify 5 (Claude 4ccb1d05) on 3b/3c (identity cycle,
  same-boot adoption, restart counting, clock, adapted older tests).
- **DL-S 7 done** (dd8835aa, 8b189781, 079de227): `DownloadResponse` gains nullable `deviceId` + `clientRef` as sent
  at prepare (trimmed) on prepare/retry/GET/list/renew/complete; new column `ClientDeviceId` (migration
  `ViewerDownloadsClientIdentity`, older rows return the lower-cased id → compare trimmed + ASCII case-insensitive);
  renew after a security sign-out updates the returned deviceId; admin DTO has neither. 2 API tests fail on 45e71f65;
  affected 370/370; server 2004/2017 (13 ffmpeg only); web 331/331; live 29/29 + 12/12 + 16/16. Snapshot 079de227.
  Merged into fb/downloads (f6cf1ba7; schema.d.ts +4); orchestrator check: typecheck 0, downloads + api jest 30/426.
  DL-C1 steered (C2-04 adoption by clientRef + deviceId, crash-between-POST-and-persist test); DL-C2 informed.
  Server lane: builder idle again, verifier 634a9e29 idle (DL-S 7 is additive, covered by builder tests + live check).
- DL-C2 check-in (2 h into turn 3, session briefly idle between tool calls): wrapping up — merged fb/downloads up to
  f6cf1ba7 (0b6ad3b8), iPhone "allowed again → continues from kept bytes" verified on 5410255b (f3f7efb3), journal with
  final screenshot index (98bcd682), 92 final screenshots. Final report pending. No action.
- **DL-C2 final pass done** (fb/dl-ui 98bcd682; 92 final screenshots phone/TV/iPhone/iPad, de + en): fixes dd1afc1c
  (detail card state once), 083dfc2b (C2-09), c82f08f9 + 07ddb405 (C2-08 `age_unverified` via real `lockOf`),
  23851f79 (movie title while preparing), 0a4d85e7 (offline-link test). iPhone on 5410255b: held download keeps its
  bytes (2,569,904 → resumes at 2,583,904 → 16,652,651, `restarts` 0). Gaps: no Dev World `language_differs` fixture
  (covered by server tests), Android "allowed again" byte count not recorded (DL-C1 re-check covers D-02), iPad
  removing-row shot missing, iOS shots at Argent's 0.25 scale. Merged into fb/downloads (4ea30682); orchestrator
  check: typecheck 0, full jest 293/2979. Orchestrator review: scrolled phone Downloads list runs under the status bar
  (storage line over the clock) → DL-C2 nits turn (scrim/inset consistent with other tabs + iPad removing shot).
- **DL-N verify 5 (Claude 4ccb1d05, fb/dl-verify-native 0c5b7535): pass with findings** — N4-01..03 fixed (redaction
  fuzz 0/3000 leaks, Kotlin = Swift output), the two adapted older tests confirmed not weakened, 6/6 D-01/D-02 guard
  reverts caught; identity cycle races (cancel + restart same id, finish first, URL replace, other ETag, 503) adopt no
  wrong file. Full client jest 293/2979, engine jest 198/198, JVM 92/92, Swift 773/773 + 81/81. New: N5-01 minor
  (Android removable card pulled/re-inserted without reboot → same-boot adoption publishes unsynced bytes; N1-15 partial
  again), N5-02 nit (vanished part not counted as restart on Android), N5-03 nit (iOS background-task hold not released
  when a download finishes inside the cycle window). → **DL-N fix round 3d**: same-boot adoption only on `internal`,
  removable volumes trim to the checkpoint (also on in-process remount); vanished part = one restart; end the
  background task on every terminal path; device runs (virtual SD unmount/remount, vanished part, small iOS file);
  both dev clients rebuilt.
- DL-C2 nits done (fb/dl-ui 8b67f878 shared `StatusBarScrimLayer` over Downloads, My List, Library and the offline
  shell on Android phones — none of these pages handled the edge-to-edge status bar before, only Home/detail did; iOS
  unchanged on purpose (lists must stay the first view for the tab bar's scroll-edge effect; iPhone tab pages not
  re-verified in this run); d2eeddf0 re-take phone-05b + iPad removing row). jest 294/2985. Merged into fb/downloads
  (52adb187); orchestrator check: typecheck 0, affected suites 62/495. DL-C2 lane done; devices: emulator-5556 idle.
- DL-C1 final pass 2 (iPhone, 5410255b): core finding fixed 99d4d769 (failing test first) — admin "sign out all
  sessions" mid-transfer: the API client's failed refresh signed the profile out first, the sign-out bumped the
  download's intent, the record GET's 401 came back stale and was dropped → download stuck `downloading` on a failed
  task until relaunch. Now a sign-out bump parks queued/preparing/downloading records as waiting_server/signed_out;
  device re-run: parked with 1,657,150 B kept, sign-in → renew → `Range: bytes=1657150-`, served = total − kept,
  restarts 0. Also eaa218fd (merge fb/downloads f6cf1ba7) + 51b5beae (C2-04 adoption by clientRef/deviceId; jest
  293/2985, tsc 0, lint 0).
- DL-C1 engine finding → **DL-N D-03 (3d, steer)**: iOS reset in the **first** response (unthrottled, 2 MB before the
  identity cycle's 1 MiB + 2 s) → the OS's in-task Range retry is invisible in `task.currentRequest` → offset unknown →
  "unverifiable" → no engine copy yet → restart from 0. Decision: accept the in-task 206 when same task + strong ETag
  equal + consistent Content-Range + start == last reported `totalBytesWritten` exactly; identity cycle after the first
  validated 256 KiB without the 2 s minimum; device repro at 2 MB (continue, restarts 0) and 100 KB (clean restart).
  DL-N meanwhile committed e01adde6 (N5-01..03).
- DL-C1 pass 2 finding 3 (player recovery, shared with streaming): on Streamarr_Phone (5410255b) 3 of 5 local starts at
  0:00 showed "Playback stopped. Resuming at 0:00…" for ~1 s — expo-video's playToEnd during a source load hit the empty
  check in `player/recovery/early-end.ts:68` (`blank` with engineDuration 0) before the load-artefact guard (:74) → T8
  empty_media → local ladder R. Decision (steer): ended counts as empty only after the engine proved a load
  (engineDuration > 0 or ready/first frame); T8 rows of the F10 matrix and S9c stay green; separate commit for a
  cherry-pick onto `fix/player-start-cover`.
- Tears of Steel online `played: true` / no resume: server Jellyfin rules (`MinResumeDurationSeconds` default 300 s →
  no resume point for 3-min Dev World files; fixture artefact). Consistency decision: local positions apply the same
  thresholds from the cached viewer settings (no offline resume below the minimum duration, played at playedPercent);
  DL-C1 to check why played was set at ~50 % (stored DurationTicks / anna's playedPercent).
- **DL-N fix round 3d done** (e01adde6 N5-01..03, bd8911dc D-03, b8109a6e journal): same-boot adoption only on
  `internal`, removable volumes trim to the checkpoint (SD unmount at 11.27 MB → `Range: bytes=11014368-`); vanished part
  → `restarts` 1; iOS cycle assertions 5/5 ended; D-03 in-task 206 accepted when start == the task's last reported
  `totalBytesWritten` + strong ETag + consistent range, identity cycle after 256 KiB (reset at 2,000,000 ×3 → resumes,
  `restarts` 0; reset at 100 KB → accepted too). Deviation accepted: 206 with another ETag stays invalid (bytes
  dropped). tsc 0, engine jest 169/169, full jest 2979/2979, JVM 96/96, Swift 773/773 + 83/83, lint 0; 13 guards
  mutation-checked. Builds: dl-native-bd8911dc (APK built at e01adde6, no Android change after). Merged into
  fb/downloads (ad8cccb8; typecheck 0, downloads jest 24/332). DL-C1 steered to the new builds + D-03 device re-run;
  DL-N verify 6 started (focus: D-03 widens trust, N5-01 trim races).
- DL-C1 check-in (1 h into turn 6): e359cabd early-end fix (a playToEnd while a source still loads is no empty file;
  F10 matrix C + weak-v1 rows updated, streaming + local), fd5b4bfc local resume points follow the server's resume
  rules, merged fb/downloads 110470b4 (48328ce3); remaining iPhone/Android steps in progress (45 final screenshots).
- Hotfix branch `fix/player-start-cover` now c1321ed3 (start cover) + df9ca3d0 (cherry-pick -x of e359cabd); on it:
  typecheck 0, player + player-screen jest 78/1266. Still not merged — owner decides.
- DL-C1 pass 2 update: e359cabd (early-end, cherry-picked to fix/player-start-cover as df9ca3d0; matrix C31 rescripted
  to the real engine order readyToPlay → ended without a picture, still T8 empty_media; new row for the load artefact;
  player suites 66/1176); fd5b4bfc local resume points follow the server rules (played ≥ 90 %, no resume < 300 s or
  before 5 %/2 min; applied to stored records too). Root cause of "no resume online" for Tears of Steel: not a server
  bug — sticky `played` from a complete watch (playCount 1) plus a stored 126 s point; the client's local-source mapped
  `played ? 0` and dropped it → now uses positionTicks like streaming. Dev World runs minResumeDurationSeconds 60, the
  client uses the defaults (thresholds only on the admin endpoint) → **DL-S 8**: read-only `resume` thresholds on
  `/viewer/me`, DL-C1 caches them per server afterwards. Also 99d4d769, 51b5beae, merges eaa218fd/48328ce3; full check
  on 48328ce3: tsc 0, lint 0, jest 295/2998.
- D-03 on bd8911dc (iPhone Air): the engine now ends its first response itself at the 786,432 B checkpoint and
  continues with Range (the once-fault was consumed there, restarts 0); with the fault on the continuation: reset after
  2,000,000 → `Range: bytes=2786432-`, served = total − 2,786,432, restarts 0, sha256 = the media file.
- **DL-N verify 6 (Claude 4ccb1d05, fb/dl-verify-native 1a09bb38): pass with findings** — N5-01..03 fixed, N1-15 fixed
  again, no way found to make D-03 accept wrong bytes (report ahead of the OS file, in-task reset, rewound retry, other
  generation, pre-pause report all rejected/caught; same start + same strong ETag + different body is the decided trust
  model); adoptable storage cannot be misclassified as `internal`. Full client jest 294/2985. New, bandwidth only:
  N6-01 minor (iOS: a file finishing before any progress report of its in-task retry is "unverifiable" → full
  re-download), N6-02 minor (iOS: no identity cycle after an accepted in-task 206 → later in-task 4xx restarts from 0),
  N6-03 nit (Android: a new task inheriting a queued disposal's partial counts a restart). → **DL-N fix round 3e**:
  snapshot the last report before clearing tracking; cycle after a D-03-proven 206 of a validated 200; count only the
  task's own bytes, run path disposals before the first attempt; promote the verifier's generation guard.
- **DL-C1 final pass 2 done** (99d4d769, eaa218fd, 51b5beae, e359cabd, fd5b4bfc, 48328ce3, 238d407e; 28 screenshots
  ios-*/phone-19…27/tv-6…8): iPhone revoked link resumes from kept bytes; D-03 on bd8911dc correct; pause/force quit/
  resume; offline resume native 1:13 / VLC 0:50 with sync not estimated; sign-out delete 2.3 s; Android D-01/D-02 resume
  exactly at kept bytes (TV paused offset 2,018,580; D-02 served = total − kept); phone 5/5 local starts + 1 stream start
  without the spurious "Resuming at 0:00" card. Merged into fb/downloads (092a2fba); orchestrator check: typecheck 0,
  full jest 295/2998. Open UI point from DL-C1: on the TV Downloads row, after Resume the D-pad focus lands on Delete
  → DL-C2 TV-focus turn (stable primary action, never Delete by a state change).
- **Client verify 3** (Codex efbf1846, turn 3) started on 092a2fba — final client check before the main merge.
- **DL-S 8 done** (643e20f5, da3e5950, d901a61d): required read-only `resume { playedPercent, minResumePercent,
  minResumeDurationSeconds }` on the shared viewer profile (`GET/PATCH /viewer/me`, email verify, sign-in `viewer`);
  server-wide values (no per-viewer override exists); PATCH ignores it. 2 new tests fail on bd89ab32; affected 938/938;
  server 2006/2019 (13 ffmpeg only); web 331/331; live 30/30. Snapshot d901a61d. Merged into fb/downloads (4bd0ab74,
  schema.d.ts +20); orchestrator typecheck 0. DL-C1 turn 7 started: cache the thresholds per serverKey (persisted,
  offline) and use them in `resumePointOf`, local position save and the played mark; defaults only for servers that
  never sent them. Server builder idle again.
- **DL-C1 turn 7 done** (28f5e05f): resume/played thresholds cached per serverKey next to the account list (from the
  sign-in answer and every `/viewer/me`, persisted for offline cold starts; an answer without the field keeps known
  values; defaults 90/5/300 only for servers that never sent them); applied to the local position save, the played
  mark (delete watched, watched label, offline up-next) and the local resume offer; rules moved to `lib/resume-rules.ts`.
  Node 24: tsc 0, lint 0, jest 296/3002; 3 of 4 new tests fail with the manager forced to defaults. Merged into
  fb/downloads (f1fe5610); orchestrator check: typecheck 0, downloads + lib + accounts jest 39/434. DL-C1 lane done.
- DL-N 3e progress: N6-01..03 committed (cedc06e2; JVM 98, Swift 86, 8 mutations caught). Device finding N6-04: a task
  resumed from a blob keeps the blob's original Range on `task.currentRequest`, so an in-task 206 at exactly the
  reported bytes was judged "unverifiable" (outcome still correct: own Range continuation, extra 2 s + 64 KiB).
  Decision (A): accept in the later-response branch when same task + generation, start == report, visible Range ≤
  report, strong ETag and consistent range; negative cases + mutation check; device re-run.
- **Client verify 3 (Codex efbf1846, fb/dl-verify-client 2c0e4c67): fail** — 32 earlier findings fixed, C1-21/C2-03/
  C2-05/C2-08 partial via new ones; new 4 majors + 1 minor (all reproduced): C3-01 intent lost across awaits
  (sign-out during enqueue's storage wait still starts + overwrites parking; Pause during a pending engine Resume →
  downloading; Pause during validator-restart wait replaced), C3-02 concurrent failed removals erase a cleanup job
  (stale snapshot write → a 1 GiB file loses durable ownership), C3-03 minor (age-verdict backoff never scheduled →
  "checking" never resolves without reconnect), C3-04 `rating_unavailable` (allowed=false) treated as verified → file
  playable offline for a restricted profile, C3-05 local start/seek gate one-sided (pre-seek 400 accepted for target
  100; seek 50 → transient 0 → stop saves 0). Baseline green 295/2998, round-2 repros 14/14.
- → **DL-C1 fix round 3** (turn 8): intent + session generation re-checked after every await with compensation (stop/
  pause stale native start/resume, engine events never flip paused/removing), serialized cleanup-job mutations, online
  timers for due age verdicts, `rating_unavailable` → age_unverified for restricted profiles + every documented /access
  reason pinned, symmetric local landing check before any report/save (shared-path fix as a separate cherry-pick).
- **DL-N fix round 3e done** (cedc06e2 N6-01..03 + promoted generation guard, f60e3bc0 N6-04, eccbfc04 journal): D-03
  proof data survives the finish; identity cycle after a proven in-task 206; disposals before a new task's first
  attempt, restart counted only for own bytes; N6-04 (device finding, decision A) stale blob Range ≤ report → the
  report decides. tsc 0, engine jest 169/169, full jest 2998/2998, JVM 98/98, Swift 773/773 + 87/87, lint 0; 10 guards
  mutation-checked. Devices: deterministic reset at 20,905,984 after cycle/pause/resume → one 206 accepted, no retrying;
  reset at 100,000 + in-task 410 → bytes kept, renewed URL continues; Android foreign `.part` truncated, restarts 0.
  Builds: dl-native-f60e3bc0 (APK at cedc06e2). Merged into fb/downloads (e73d6c48; typecheck 0, downloads jest 26/347).
  DL-N verify 7 (final engine check, Claude 4ccb1d05) started; DL-C2 pointed at the new builds.
- **DL-C1 fix round 3 done** (dff49e02 C3-01 intent + session after every await / C3-02 cleanup jobs from the current
  list, fd3c9a63 C3-03 per-profile age-check timer online / C3-04 `rating_unavailable` unverified → age_unverified lock,
  934a0489 C3-05 local start/seek landing ±3 s, 2dd8ea30 journal). Verifier round-3 files unchanged with
  `DL_VERIFY_EXPECT_FIXED=1`: 13/13. New persisted field `restartReason`; rating_unavailable backoff capped at 24 h.
  No cherry-pick (all local-gated). Merged into fb/downloads (b9cd151b); orchestrator check: typecheck 0, full jest
  296 suites / 3037 tests.
- DL-C1 turn 9: symmetric **streaming** start gate (a stale far-above reading must not set a stream's resume point;
  the c4a64a64 uncover stays one-sided) as one cherry-pickable commit for `fix/player-start-cover`.
- Waiting for: DL-C2 TV focus (Resume → Delete), DL-N verify 7 (final engine check). Then client verify 4 (final).
- **DL-N verify 7 (Claude 4ccb1d05, fb/dl-verify-native fa635203): pass with findings — final engine verdict "fit for
  the main merge"**. N6-01..04 fixed (8/8 round-3e guards caught by the builder's tests); N6-04 could not be broken with
  a conforming server (smaller blob, two blobs, stale visible Range, other ETag, finish after 206); only a
  non-conforming server answering another start than asked could misalign before the final size check (outside the
  decided trust model). Full client jest 296/3002, engine jest 198/198, JVM 98/98, Swift 773/773 + 87/87. Remaining:
  N7-01 minor (iOS: the engine's own Range continuation — every renewal after 410 expired/revoked — has no D-03/N6-04
  proof, no snapshots, no identity cycle → an in-task reset falls back to the kept bytes), N7-02 nit (Android: empty
  directory after a disposal blocks a later download at that path; unreachable with Streamarr's layout).
- Decision: one more small engine round **3f** (N7-01: same proof with base K + snapshots + identity cycle on own Range
  continuations; N7-02: refuse a directory target in `start`, prune emptied parents) — runs in parallel with the open
  client items; a short verify 8 afterwards. Not a blocker for the main merge decision.
- DL-C1 turn 9 done: symmetric **streaming** start gate fa964b35 (cherry-pickable; merge-tree clean against
  fix/player-start-cover; exported tree typecheck 0, player suites 79/1280 incl. F10), plus dl-core-only 61e5c5c6 (main's
  start-floor lines back), 912fb0ef (dead download floor restore removed), cd0eda6a journal; jest 297/3051. No reports
  before the landing (server idle limit 600 s, HLS fetches count → normal start unaffected).
- Decision: **gate fallback** (DL-C1 turn 10) — the gate also opens when playback demonstrably advances at normal speed
  (≥ 5 s wall, delta = wall × rate ± 1 s, ≥ target − 3, after the engine's own start seek finished), logged once; a
  stale reading cannot pass. Reason: libVLC on MKV/HLS can land on a keyframe several seconds past the target, and a
  session that never reports would lose all its progress. Cherry-pick fa964b35 + the fallback together onto
  fix/player-start-cover; merge fb/dl-core into fb/downloads after the fallback.
- DL-C2 check-in (1 h into turn 5, TV focus): working tree in progress — shared `focus-handoff.ts`, `icon-button`,
  download row/library, detail card, sheet rows (anchor/review/item) + tests; not committed yet. No action.
- 2026-11-07 20:49: the owner approved **only** the keep-awake box test (≤ 10 min, "Ja lass den Test jetzt machen",
  given directly in the Streamybox child session c28872eb). That agent runs it now under the device lock (read-only
  pre-check first, no overwriting newer builds, preferences restored, TV/AVR back to standby) and asked for no other box
  changes during the window. FR (Streamarr frame-rate vote, ~12 min) and fractional-refresh (HWC a7ecdecc + quiet
  reboot, ~15 min) stay unapproved and idle.
- DL-C1 turn 10 done: gate fallback 71d7582c (cherry-pickable; start counts once playback advances ≥ 5 s at wall speed
  ± 1 s after the engine's start seek settled, ≥ target − 3; new optional engine `startSettled()`; log line
  `[player] start gate opened by playback …`), f6f1d8a1 (same rule for download starts, dl-core only), ee9409c2.
  jest 297/3074. **Hotfix branch `fix/player-start-cover`** now c1321ed3 + df9ca3d0 + c89a7f34 (fa964b35) + 7c376f4e
  (71d7582c); orchestrator check on it: typecheck 0, player lint 0, **full jest 234 suites / 2468 tests**. Not merged.
- **DL-N fix round 3f done** (ca88b62e, 6ed69002, 4c149297): N7-01 own Range continuations get the D-03 proof with base
  K, identity cycle after 256 KiB and `kept/<id>.snap` snapshots (host experiment + sim: nsurlsessiond resumes at
  K + r; 410 at 1 MiB → renew → two resets → in-task 206 accepted; later in-task 410 keeps 5,242,880 B → renew
  continues; sha256 = server, restarts 0); N7-02 directory target refused, emptied parents pruned. JVM 101/101, Swift
  773/773 + 93/93, 19 guards mutation-checked, 5 untestable guards removed. Builds: dl-native-6ed69002.
- Integration: fb/dl-native → 356a8a16, fb/dl-core → 77bd17ef; orchestrator check: typecheck 0, full jest 297 suites /
  3074 tests. Started DL-N verify 8 (last engine check). Pending: DL-C2 TV focus, then client verify 4 (final).
- **Streamybox keep-awake box test done** (c3439475, owner OK 20:49; window 20:54–21:01 CET, < 10 min): final run
  20:59:20–21:01:18 26/26 checks — ~38 s real H.264 SDR via the Binder RenderService stayed awake despite a 15 s test
  timeout (MPP +846 jobs / 35.21 s); pause → player hold released at once, root hold after 3.41 s, real dream after
  17.3 s; resume/stop correct; quiet_hold and CEC switch refused with `video_playing`; bridge CPU 2.04 % idle /
  2.16 % playing of one core. Two earlier fixture starts failed (SD access, MP4 index/HTTP without Range) → same clip
  faststart-remuxed, no product change. **Rolled back as planned**: all 3 test APKs back to the saved originals, test
  client removed, adb reverse closed, all 8 preferences restored; 21:02:11 box dozing, TV + AVR standby, CEC on, same
  boot id, Streamarr unchanged. **Fix not installed** (needs merge + deploy approval). Not tested: DV/Streamarr/
  SmartTube/Jellyfin long run. Leftover: one 9.2 MiB test clip on the SD card. Doc commit 2366fc0e on
  feat/video-keep-awake; evidence `$SB_WORK/round-2026-11-07/video-keep-awake/box-test-2100/`.
- **DL-N verify 8 (Claude 4ccb1d05, fb/dl-verify-native e592e711): pass with findings** — N7-01/02 fixed; pruning held
  (shared folders, card-only disposals, symlinks never followed, 360 random ops from 3 threads); full client jest
  297/3074. But **N8-01 major (iOS silent corruption, rare)**: a renewed continuation's tail snapshot survives a failed
  publish/relaunch, a later fresh GET makes it look valid, an in-task 4xx folds "new bytes + old tail" → a *completed*
  file with right size + ETag but wrong bytes. Cause: one of the guards DL-N removed in 3f as "untestable" (tail reset
  after assembly) was not redundant. N8-02 minor (crash mid fold drops all kept bytes), N8-03 nit (iOS publish replaces
  a directory, e.g. a media file named `art` = the core's artwork folder).
- → **DL-N fix round 3g** (must land before main): tail snapshots bound to `{baseOffset, etag, generation}` and folded
  only when the base equals `keptBytes`; plus cloneKept clear + restored resets after assembly and at load, each
  mutation-checked; load truncates an over-long kept file back to `keptBytes`; iOS refuses a directory target and never
  replaces a directory. **DL-C1** tiny task: reserve sibling names (`art`, …) in `safeFileName`. Verify 9 afterwards.
- DL-C1 turn 11 done (bfd6f240): reserved sibling names in `keys.ts` (today `art`, the artwork folder; the artwork
  writer reads the same constant), a cleaned media name equal to one (full lowercase, trailing dots/spaces ignored) gets
  `_media`; existing records keep their path; no media subfolder (orphan sweep derives the folder from the media path).
  5 tests fail on the old code; jest 297/3081 (one known worker SIGSEGV flake, green on rerun). Merged into
  fb/downloads (7f855440); orchestrator check: typecheck 0, downloads jest 26/379. DL-C1 idle.
- **DL-N fix round 3g done** (21328fcc N8-01/02, 31409153 N8-03, e33c2b20 merge, 1de432de + a56ba9a8 journal): tail
  snapshots bound to `{keptLength, etag, generation}` + five defence guards (binding, clone reset, assembly reset incl.
  failed publish, load prune, request-start prune; each caught alone, all five removed → corruption back); over-long
  kept file cut back at load; iOS refuses a directory target, publish/move never replace a directory. Swift host 117/117
  (was 93), JVM 101/101, full jest 3081/3081; device 3f scenarios + directory refusal, sha256 = server. Builds:
  dl-native-e33c2b20. Merged into fb/downloads (4f0ea1c1; typecheck 0, downloads jest 26/379). DL-N verify 9 started.
  Open doc nit: `types.ts` says move "replaces the target" (iOS: file yes, directory no; Android: refuses any existing
  target) — verifier checks whether any core path relies on it.
- 21:50: DL-C2 turn 5 (TV focus) hung after ~20:06 (last action: detail + sheet tests 41/41 green; no output after the
  queued steer messages). Stopped and resumed as turn 6 on the same session with the uncommitted work intact
  (focus-handoff + stable primary action in row/card/sheet rows): commit → merge fb/downloads cb6423e9 → full jest →
  device check on emulator-5556 with dl-native-e33c2b20 (skip after ~15 min if blocked).
- 2026-11-07 21:51: the owner ordered the **permanent installation** of the tested keep-awake fix (given directly in
  the Streamybox child session c28872eb). That agent checks the current APK hashes and parallel work, installs only the
  three tested product APKs (Player, Remote, Settings from `feat/video-keep-awake`, not merged into Streamybox main),
  verifies briefly under the device lock, then restores normal preferences and box/TV/AVR standby. Follow-up for later:
  `feat/fractional-refresh` also changes the Settings app → any later Settings deploy must be built from both branches
  (else it would roll keep-awake back); the box state ≠ Streamybox main until both are merged → record in Streamybox
  STATUS.md once the install report is in.
- **Keep-awake fix permanently installed on the box** (c3439475, owner order 21:51; done 21:56): Player, Remote and
  Settings 1.7.2 (10038), the exact tested release APKs (b028afc261e3 / fba932496596 / 91f90844ab14); predecessor hashes
  and signing checked, no newer foreign packages found; 29/29 install/activation/short checks; root + network service
  switched to the new Remote automatically; short real PlayerActivity check: hardware progress and holds active,
  pause/stop release. No rollback, no reboot. Preferences unchanged; no test client/clip/adb reverse left (the earlier
  9.2 MiB clip verified by SHA and removed). Box dozing, TV + AVR standby, CEC on. Report:
  `$SB_WORK/round-2026-11-07/video-keep-awake/permanent-install-2151/REPORT.md`. Not done: long DV/Streamarr/app-matrix
  test. Box now runs `feat/video-keep-awake` builds that are **not on Streamybox main** → merge decision with the owner;
  any later Settings deploy (fractional-refresh) must be built from both branches.
- **DL-N verify 9 (Claude 4ccb1d05, fb/dl-verify-native 004490e5): pass with findings (2 nits) — engine merge-ready.**
  N8-01..03 fixed; all builder claims about the five N8-01 guards confirmed (each reverted alone caught; binding/clone/
  assembly/request-start each alone keep all four chains correct; all five removed → corruption back); generation
  numbers never repeat across relaunch; cut-back and orphan-snapshot ordering hold; core never calls `engine.move`.
  Full client jest 297/3081. Across 9 rounds: 57 numbered findings + D-01..03, all fixed except N9-01 (iOS staged
  publish error path retryable/0 bytes) and N9-02 (move/publish contract: replace a file, refuse a directory).
  → **DL-N 3h** (nits, no new verifier round; host tests as evidence).
- DL-C2 TV focus committed: 21129d13 (primary action keeps TV focus across state changes), 22932567 (tests), merged
  fb/downloads (df5321a4); device check pending.
- **DL-C2 TV focus done** (21129d13 fix, 22932567 tests, df5321a4 merge, 74a05062 journal + 6 Google TV shots): one
  stable primary action per row/card (Downloads rows incl. offline shell, detail progress card, sheet season rows, held
  anchor episode); busy = inert but focusable (a `disabled` view drops focus on Android); if the primary action or
  Delete disappears focus goes to the row/card, never to Delete. New `tv-focus.test.tsx` (4); device: emulator-5556
  with e33c2b20, Pause → Resume → Pause keeps the ring on the same button. Merged into fb/downloads (a9e9ee06);
  orchestrator check: typecheck 0, full jest 298 suites / 3085 tests. Leftover: one Tears of Steel test download on the
  TV emulator.
- Orchestrator review of the TV shots: Resume of a paused download uses ▷ on the detail card (reads as "play the film"
  right above "Abspielen") but ⬇ on the Downloads row → DL-C2 turn 7: one resume icon everywhere.
- **Client verify 4** (Codex efbf1846, turn 4) started on a9e9ee06 — final client check before the main merge.
- DL-C2 turn 7 done (ba82c842): Resume = download arrow, Pause, Retry = RotateCcw with one label each on the Downloads
  list and the detail card (▷ only for playing); list labels unified with the card's; sheet/anchor ⬇ is a status icon
  only; offline shell uses the same list. New `download-action-look.test.tsx` (5/6 fail without the fix); tv-09b
  re-taken (focused ⬇ above "Abspielen"). jest 299/3091. Merged into fb/downloads (2f45b932); orchestrator check:
  typecheck 0, downloads/components/i18n jest 17/167. Leftover: paused Tears of Steel test download on emulator-5556.
- **DL-N fix round 3h done** (c8b38642 N9-01, 4d8ad2ce N9-02, c26871a1 journal): iOS staged publish onto a directory
  fails like a direct publish (non-retryable `invalid_state`, staged bytes kept, no restart); one contract on iOS,
  Android and the fake — move/publish replace a file and refuse a directory (incl. an empty one) with `invalid_state`;
  types.ts + README updated, the wrong 3g Android note corrected. Mutants now run one at a time (parallel mutants
  interfered); the 3g guard matrix re-run that way agrees. tsc 0, lint 0, engine jest 170/170, full jest 3082/3082,
  JVM 103/103, Swift 773/773 + 120/120, Android lint 0. Builds: dl-native-4d8ad2ce (new APK; Android sources changed).
  Merged into fb/downloads (125cce9b); orchestrator check: typecheck 0, full jest **299 suites / 3092 tests**.
  **Engine lane done** (9 verifier rounds, 57 numbered findings + D-01..03 + N9 nits fixed). DL-N builder idle.
- Waiting only for: client verify 4 (Codex efbf1846, final client check). Then the main-merge question to the owner.
- **Client verify 4 (Codex efbf1846, fb/dl-verify-client 637f5e2d): fail** — all 45 earlier repro checks pass, 37 of
  41 earlier findings fixed; C3-01/C3-03/C3-05 partial via new ones, C1-26 regressed (multi-line comments in
  icon-button / focus-handoff). New 4 majors + 1 minor: C4-01 obsolete age retry rescheduled at 0 ms after the policy
  became unrestricted (121 calls in one backoff), C4-02 intent lost on remaining awaits/rejections (retry during DELETE
  overrides Pause; stale Start rejection writes failed; prepare answer after sign-out stays preparing), C4-03 start-gate
  fallback: a pause without time events doesn't reset the playback proof (stream + local), C4-04 "From the beginning"
  accepts a stale far-above reading (0 used as "no pending start"; stream + local), C4-05 inert primary exposes no
  busy state to a11y.
- → DL-C1 fix round 4 (turn 12): one eligibility function for age retries, generation re-check on every await incl.
  catch branches (audit), continuous playback epoch reset by pause/background/stall/source/seek, `null` = no pending
  start so target 0 can pend; C4-03/C4-04 as player-only commits for `fix/player-start-cover`. DL-C2 (turn 8): busy
  a11y state + label for inert primaries, one-line comments.
- DL-C2 turn 8 done (b9248242): C4-05 inert primaries expose `accessibilityState.busy` + a "{title}: {status}" label
  ("Datei wird geprüft" while verifying; new "Wird pausiert…"/"Wird fortgesetzt…" while pending), new `busyLabel` prop
  replaces `inert`, presses go to a no-op handler; C1-26 one-line comments. New `busy-primary.test.tsx` (4, all fail
  before). jest 300/3096. Merged into fb/downloads (1f54cb95); orchestrator check: typecheck 0, downloads/components jest
  40/423. DL-C2 idle. Waiting for DL-C1 fix round 4, then client verify 5.
