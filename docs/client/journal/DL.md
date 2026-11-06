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
