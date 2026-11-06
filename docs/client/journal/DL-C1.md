# DL-C1 — client core (offline downloads)

Status: in-progress — phase B started; fix round 1 (Codex review) has priority

Branch `fb/dl-core` (worktree `streamarr-worktrees/dl-core`) = `fb/downloads` + DL-S contract freeze (c029ac09) + DL-N
engine interface freeze (18e76428, c1a5af94). Spec: PLAN.md § "DL — offline downloads", `downloads-plan.html`,
`docs/api.md` § 14, `client/src/downloads/engine/*` (frozen, read only).

Intent: download store + manager (server prepare → engine transfer → verify → complete), metadata/artwork snapshot,
connectivity + offline shell, local playback mode in the player, global watch-progress queue (`occurredAt`), account
removal hooks. Slice 1 freezes the JS API (types, manager, hooks, fakes) for DL-C2.

## API freeze (Slice 1)

Public surface for DL-C2: `import { … } from '@/downloads'` (types in `src/downloads/types.ts`); test helpers in
`client/jest/downloads.tsx`. Providers are mounted in `src/app/_layout.tsx`: `AccountsProvider > ConnectivityProvider >
DownloadsProvider` (+ `ProgressSync`).

- **Types:** `OfflineDownload` (local `id` = engine task id = server `clientRef`; `accountKey` = `downloadAccountKey(account)`
  = `serverKey(serverUrl)#viewerId`; `downloadId`, `serverState`, `workId`, `kind`, `seriesId`/`seasonId`/numbers,
  `releaseId`/`sourceReleaseId`, `version` (VersionDto for chips), `engine` native|vlc, `mediaInfo`, `fileName`,
  `relativePath` + `volumeId` (never absolute URIs), `etag`, `sizeBytes`/`estimatedBytes`/`bytesWritten`, `state`,
  `error {code, params, actions, status}`, `retryAt`, `restarts`, `expiresAt`, `serverCompleted`, `meta`
  (title, seriesTitle, overview, runtime, year, tint, certification, genres), `artwork` (relative paths), timestamps).
  States: `queued | preparing | downloading | paused | waiting_wifi | waiting_network | waiting_server | waiting_space |
  verifying | done | failed`. Also `OfflineLibrary`, `SpaceVerdict`, `DownloadStorage`, `DownloadsSupport`,
  `LocalPlayTarget`, `LocalPosition`, `DownloadRequestItem`, `DownloadSettings` (+ re-exported server DTO types).
- **Manager** (`DownloadManager`, via hooks): `start(accountKey, items)`, `pause/resume/retry/cancel/remove(id)`,
  `removeSeason/removeSeries/removeAll/removeWatched`, `setWifiOnly/setMaxConcurrent/setDeleteWatched`, `storage()`,
  `availableBytes()`, `recordPosition()`, `wake()`, `reconcile()`.
- **Hooks:** `useDownloads()` (grouped library of the active profile), `useDownloadFor(workId)` (download, state, progress,
  bytesPerSecond, playable, position), `useSeasonDownloads(seasonId)` (downloaded/inProgress/failed/bytes → "5/10"),
  `useActiveDownloadCount()` (badge), `useDownloadStorage()` (free/total/used/other/committed/available),
  `useDownloadsSupported()` (platform/engine/permission/signed_out), `useDownloadActions()` (bound to the active
  profile), `useDownloadSettings()`, `useLocalPlayTarget(workId)`, `useArtworkUri(download, kind)`,
  `useAccountDownloads(account)`, `useConnectivity()` (`@/connectivity/provider`: state online | checking |
  offline_no_network | offline_server_unreachable, `offline`, `retry()`).
- **Candidates:** `useDownloadCandidates(workId)`, `useSeasonDownloadCandidates(seasonWorkId)`,
  `useDownloadPlan(anchor, workIds)` → `{ query, data, space }`; every candidate/pack/plan item carries
  `space: SpaceVerdict` (fits, needed, available = free − queued remainder − 256 MiB reserve, missing, estimate);
  `useDownloadSpace().verdict(bytes, estimate)` for custom selections (season pack minus deselected episodes).
- **Play:** `resolveLocalPlayTarget(workId, accountKey, …, releaseId?)`, `resumeSecondsOf(local, server)`,
  `nextDownloadedEpisode(workId, accountKey)`.
- **Labels:** `downloadStateLabel(t, state)`, `downloadErrorText(t, error, lang)`, `downloadTitle(t, download)`;
  i18n `downloads.state.*`, `downloads.error.*`, server codes in `errors.codes.*`.
- **Test helpers** (`client/jest/downloads.tsx`): `createTestDownloads()` (manager + fake engine + fake server + memory
  store, `restart()`), `createFakeDownloadsServer()`, `fakeOfflineDownload(patch)`, `seedDownloads(test, records)`,
  `DownloadsTestProvider`, `TEST_ACCOUNT_KEY`; app-level: `setDownloadsOverride({ engine, store, artwork })` before
  rendering the app.

## Decisions

- **No amend/rebase on `fb/dl-core`** (orchestrator, 2026-11-06): DL-C2 merges from this branch; fixes go in follow-up
  commits only. (The player commit was amended once: DL-C2 picked up the pre-amend 86eec76b, the branch has c78103e1 —
  same content plus a test type fix; the orchestrator told DL-C2 how to resolve it.)

- **Owner key = `serverKey(serverUrl)#viewerId`**, not the local `Account.id` (random per sign-in): a profile signed out
  with "keep downloads" finds them again after signing in. Files live under `a<hash(owner)>/<downloadId>/`.
- **Install id** (`deviceId` for the server's per-device list) lives in the downloads MMKV (`installId`).
- **Extra state `waiting_network`** (the engine's "no network at all") next to the plan's states; engine `retrying` maps to
  `waiting_server` (with `retryAt`).
- **Preparation:** at most 2 server preparations at once (`MAX_PREPARING`); long-poll `waitMs=10000`, at least 1 s between
  polls (or `pollAfterMs`). Ready → snapshot (non-blocking) → free-space check → `engine.start`.
- **Space:** available = free − remaining bytes of every unfinished download (all profiles) − 256 MiB reserve; a ready
  download that does not fit parks in `waiting_space` (re-checked every 60 s, on removal, on wake).
- **Failures:** 410 → `renew` + `engine.resume(url)`; a second 410 within 60 s → `download_source_gone`. 429/5xx/0 →
  `waiting_server` with backoff 30 s → 5 min (or `Retry-After` on API errors). 403 → `downloads_not_allowed`. 409 / validator
  / size mismatch → one restart (server record deleted, prepared anew), then failed. 404 → `download_not_found` (retry
  prepares anew). Server 501 → `server_unsupported` (the DL-S stubs answer 501 until implemented).
- **Done before server completion:** a verified file is `done` (playable offline at once); `POST …/complete` is sent best
  effort and retried at reconcile/reconnect (`serverCompleted`).
- **Removal while signed out/offline** queues the server DELETE (`pendingDeletes`) for the next reconcile.
- **Progress queue** (`src/player/progress-queue.ts`): one drain per account shared by the player and the app-wide
  `ProgressSync`; queued reports are sent with `occurredAt` = when they happened; retention 30 days (was 24 h, B23 row
  updated), 500 entries.
- **Connectivity** only runs where downloads exist (`platformSupportsDownloads()`); web and Apple TV keep today's
  behaviour. Failure signal = query/mutation cache errors with the service-status transport codes
  (`network_unreachable`, `timeout`, `tls_error`); recovery only via the health probe (persisted query data can look like
  a success offline).
- **Test helpers in `client/jest/downloads.tsx`** (repo convention, outside the literal-text scan).
- `no-literal-text` exempts `downloads/engine/fake.ts` (DL-N's English diagnostics by contract; the folder is frozen).

## Log

- Slice 1 API freeze: 31632f88 (error codes), c3be8766 (connectivity + progress sync), **9fa5d2a3** (API freeze);
  reported to the orchestrator.
- c78103e1 player local mode; e7bf22a9 library/prompt; b7ff939d offline shell; 436dbc01 reconcile
  race fix; 9438eda5 tests; 07d4cdf6 notification permission + candidates test.
- Orchestrator: phase B waits until DL-N is integrated (only DL-N installs on devices now). Merged `fb/downloads`
  (DL-S implementation a58d41b7 and later docs) into `fb/dl-core` as 1fdcc72f: no client changes, OpenAPI unchanged
  (client schema regenerated identically); docs add `409 download_not_ready` and `409 size_mismatch` → registered with
  texts, Retry prepares anew for server-state failures. typecheck 0, lint clean, jest 246 suites / 2502 green.
- Orchestrator's DL-S hints checked against the manager: `deviceId` on prepare/get/list ✓, `complete` with
  `bytesReceived` ✓, `occurredAt` ✓, `Retry-After` on server 429/503 ✓ (file 429/503 back off 30 s doubling until DL-N
  reports `retryAfterMs`), Range/If-Range is the engine's (DL-N). Gaps fixed in 9e940551: a `410` while the link is still
  valid is `download_source_gone` → fails at once with `otherVersion` (no renew); a source changed twice offers
  retry/otherVersion; unfinished downloads renew their link 3 days before `expiresAt`. Merged fb/downloads again
  (df0cc3ba, docs only). typecheck 0, lint clean, jest 246 suites / 2504 green.

- Baseline on clean `fb/dl-core` (before any DL-C1 change): jest 2443 tests, **2 pre-existing failures** from the merged
  freezes: `errors.test.ts` (11 newly documented download codes unknown to the client) and `no-literal-text.test.ts`
  (`downloads/engine/fake.ts` diagnostics). Both fixed in the freeze commits.

- 2026-11-06: read PLAN §2–4 + DL, downloads-plan.html, api.md § 14, schema download DTOs, engine types/index/fake,
  DL-N journal. `npm install` in client/.

## Evidence

### Phase B — Android phone (emulator-5554, API 34), first pass (before fix round 1)
- Setup: merged fb/downloads a38c1ffe (7470d978), adapted to the final engine (32417219); Dev World snapshot on 39300
  (run directly), Metro 8082, `adb reverse` 8082/39300, DL-N dev client b1b3a8f4 (reinstalled on emulator-5558).
  Downloads are started through `globalThis.__streamarrDownloadManager.start(...)` (dev-only global) — the sheet is DL-C2's;
  the library is shown online on the dev-only route `/dev/downloads`.
- Throttle 1.5 Mbit/s: Big Buck Bunny (mp4, native), Pioneer One S01E01 (mp4, native) downloading, Elephants Dream
  MISLABEL queued (2 per viewer) → server prepared it with `engine: vlc` (MKV/DTS). `phone-library-downloading.png`.
- Swipe from Recents mid-download: the UIDT job keeps the process; S01E01 completed on the server meanwhile.
- `kill -9` of the process mid-download: the job restarted the process headless (no JS), Big Buck Bunny finished
  natively and stayed `ready` on the server; relaunch → reconciliation verified it and sent `complete` (server:
  `completed`), Elephants Dream re-attached at 16/22 MB. `phone-library-after-kill-relaunch.png`.
- Found: speed under 1 MB/s reads "0 MB/s"; download progress bars announce "… watched" (a11y) → fixed in fix round 1.

- `npm run typecheck` exit 0; `npm run lint` (expo lint) clean; `npm test`: **246 suites, 2504/2504** after merging
  `fb/downloads` (baseline before DL-C1: 2443 tests with 2 pre-existing failures, both fixed; the DL-S merge added 2
  documented codes, registered).
- New suites: `downloads/__tests__/manager.test.ts` (14: happy path, clientRef/profile/install id, dedupe, prepare failure,
  waiting_server + wake, 403/501, waiting_space both ways, Wi-Fi/no network/retrying/pause/resume, 410 renew + gone,
  429/403, validator restart once then failed, removal incl. artwork + server record, delete queued while signed out),
  `reconcile.test.ts` (10: finished while killed, re-attach, preparation in flight, POST without saved id, engine and
  server orphans, file missing, lost engine task, pending completion, delete watched), `store.test.ts` (10),
  `hooks.test.tsx` (3 incl. candidates' space verdicts and `allowDownloads`), `connectivity/__tests__/monitor.test.ts`
  (6), `player/__tests__/local-mode.test.ts` (7), `player/__tests__/progress-sync.test.ts` (5),
  `screens/offline/__tests__/offline-shell-{return,library,empty}.test.tsx` (3), `screens/onboarding/__tests__/
  profile-downloads.test.tsx` (1).
- Real bugs the tests found and fixed: `mediaUrl` prefixed the server origin to `file://` URIs; the launch reconciliation
  reset a download started in the same session (double POST) and could delete a server record an unsaved preparation
  would reclaim by `clientRef`; the prepare long-poll spun without a gap when the server answered instantly.
- Screenshots: none yet — device/simulator work is held until the orchestrator's go-ahead (phase B); downloads and the
  offline shell do not exist on web, so Expo web cannot show them.

## Requests to DL-N

1. **Retry-After:** `DownloadError` carries only `httpStatus`; for `429 too_many_downloads` / `503
   download_source_unavailable` the server sends `Retry-After`. An optional `retryAfterMs` would let the manager wait
   exactly (today: its own 30 s → 5 min backoff).
2. **Confirm failure classes:** the manager assumes `403/404/409/410/416` end as `failed` + `http` at once (no native
   retries) and `429/5xx`/transport as `retrying` → `failed network|http` after the budget.
3. **Artwork next to the file:** poster/backdrop/still are written with expo-file-system into
   `<downloadFolder>/art/*` under `rootUri` (the engine has no small-file API). Please keep the iOS backup exclusion on
   the engine root directory (so files other code writes inside it are excluded too) and keep `deletePath(folder)`
   recursive.

## Follow-ups

- **Phase B** (after DL-S + DL-N are in `fb/downloads`): merge, then Android phone, Android TV and iOS simulator — download
  from the Dev World, kill mid-download, airplane mode / server stop → offline shell → play local (native + VLC) →
  progress synced after reconnect; screenshots to `docs/client/screenshots/DL-C1/`.
- **DL-C2:** the Downloads tab/rail screen wraps `DownloadsLibrary` (`header` prop for its title/badge); the detail page
  starts a downloaded work with `playHref({ workId, title })` without `releaseId` (the player then plays the file; an
  explicit other `releaseId` streams); the Settings "Downloads" section should also be added to `OfflineScreen`
  (`offline-settings` section, today Language + Performance).
- **Jest:** expo-router's test store does not survive a second render in the same file after a test navigated away from
  `/offline` — offline shell scenarios live one per file.
- **Streamybox:** local files never go to Streamybox (DL-N note); a `content://`/fd contract v2 would be a Streamybox
  follow-up.
- **Server stubs:** until DL-S implements the endpoints the manager shows `server_unsupported` (HTTP 501).
