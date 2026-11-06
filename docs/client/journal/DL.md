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
