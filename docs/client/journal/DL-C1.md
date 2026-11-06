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

## Fix round 1 (Codex review DL-C-verify1, fb/dl-verify-client 806adaf1)

Commits: 9bd3c386 (connectivity), ab23c423 (downloads core), d9520b0d (player). The reviewer's repro files were brought in
and promoted to ordinary regression tests (plain `it`, no env switch); `client/src/__verify__/` is deleted. C1-06 and
C1-12 are pinned in the decided form (async file check at play start; server record instead of the English diagnostic).

| ID | Fix | Commit | Regression test(s) |
|---|---|---|---|
| C1-01 | Pause during a pending prepare keeps `paused` (server id kept; Resume polls and starts); `onReady`/`enqueue` re-read the record after every await | ab23c423 | `downloads/__tests__/races.test.ts` "C1-01: a pause during the pending prepare survives…" |
| C1-02 | Removal while enqueueing: re-check after the storage await and after `engine.start` (orphan task cancelled + files deleted); late artwork deleted | ab23c423 | races "C1-02: a removal while the transfer is being enqueued…", "C1-02: artwork arriving after a removal…" |
| C1-03 | `start()` serialized (one start at a time) → one record, one clientRef | ab23c423 | races "C1-03: two starts replacing a failed record…" |
| C1-04 | 502/503/504 count toward the probe; successful queries reset | 9bd3c386 | `connectivity/__tests__/monitor.test.ts` "C1-04: …" (2) |
| C1-05 | Probe promise per generation/server; a switch starts the new server's probe | 9bd3c386 | monitor "C1-05: switching servers during a probe…" |
| C1-06 (core) | `manager.verifyLocalFile`, `checkLocalPlayTarget`; missing/short file → `file_missing` with `actions: ['retry','remove']`; Retry re-prepares (`file_missing` in PREPARE_AGAIN). Player: `prepareLocalSource` → `local` / `stream` (+notice `downloadMissing` online) / `missing` / `locked` (offline cards with Remove/Back); local failure online → "Stream instead" from the current position | ab23c423, d9520b0d | races "C1-06: …" (3), `local-play.test.tsx` "the player start (C1-06)" (2) |
| C1-07 | Storage hook keeps the engine sample with every download's bytes and subtracts bytes written since; unknown space → `{ fits: false, unknown: true }` | ab23c423 | `storage.test.tsx` "C1-07: …" (2) |
| C1-08 | Progress queue entries carry an id; the drain removes exactly the sent entry (legacy entries get ids once) | d9520b0d | `player/__tests__/progress-sync.test.ts` "C1-08: …" |
| C1-12 | 410/404/403 from the engine read `GET …/downloads/{id}`: `fileUrlRevoked` or expired → `renew?deviceId=` → `resume(id,{url})` on the same bytes; renew 401 → `waiting_server`/`signed_out` (never deleted), resumes after sign-in; 410 on a valid link → `download_source_gone` + `otherVersion`; 404 with a newer URL → resume on it; 403 → `GET /viewer/me` → `downloads_not_allowed` / `age_restricted`, transfer ends, partial kept, `actions: ['remove']`. No file probe, no English diagnostic. `download_revoked`/`age_restricted` texts under `downloads.error.*` (+ `errors.codes`) | ab23c423 | `manager.test.ts` "C1-12: …" (4) |
| C1-13 | `holdFile(id)` (player holds until stop); delete-watched runs when `played` turns true and no hold remains, and for already watched ones when the option is turned on | ab23c423, d9520b0d | races "C1-13: …" (2), `local-tracks.test.ts` (release on stop) |
| C1-14 | `localPlayback(…, engine)`: VLC also lists `vlcOnly` subtitles (`deliveredAs: embedded`); rebuilt on every local engine switch and on the VLC fallback | d9520b0d | `player/__tests__/local-tracks.test.ts` (2) |
| C1-15 | Up-next = `offline ? offlineNext : serverNext`; the hook follows the download store | d9520b0d | `local-play.test.tsx` "offline up-next (C1-15)" (2) |
| C1-17 | Store: progress notifies per-download subscribers at once, the whole library at most once per second; live speed per download only; `subscribeTo(id)` + `useDownloadRecord(id)` | ab23c423 | races "C1-17: …" |
| C1-18 | Completion: 404 = gone (acknowledged); 409 `size_mismatch` stays unacknowledged with the error, not repeated this launch; `download_not_ready` retried later | ab23c423 | races "C1-18: …" |
| C1-19 | `abortableDelay` removes its abort listener on timeout and abort | ab23c423 | races "C1-19: …" (2) |
| C1-21 | Viewer policy (`maxAge`, `blockUnrated`, `allowDownloads`) persisted per owner from every `/viewer/me` answer (and after a 403); `meta.minimumAge`/`rated` from `GET /viewer/access/{workId}` in the snapshot; `lockOf()` locks (never deletes) online and offline; locked rows "Für dieses Profil nicht freigegeben", only Remove; a server `age_restricted` locks too. Profile PINs do not exist in the app: offline profile switching works exactly like online (no extra lock) — documented, nothing invented | ab23c423 | `local-play.test.tsx` "age rules offline (C1-21)" (2), `policy.test.tsx` |
| C1-23 (core) | HTTP 409 source changed (restart once, then retry/otherVersion), disk full with bytes kept, Wi-Fi-only toggle while waiting, other profile active during a transfer, cancelled engine task restarted (bug fixed: `start` returned it unchanged), sign-out keep + relogin, profile removal delete, missing-file one-click retry, late artwork delete | ab23c423 | `coverage.test.ts` (5), `profile-downloads-keep/remove.test.tsx`, races |
| C1-24 | See C1-04/05; stale health answer after NetInfo loss ignored; `setServerReachable` gates React Query's `onlineManager` (paused mutations resume); `keepsOffline` lets a starting or local player stay, a stream (`holdStreamPlayback`) gives way | 9bd3c386 | monitor "C1-24: …", `query-client.test.ts` "server reachability (C1-24)", `connectivity/__tests__/progress-sync.test.tsx`, `offline-shell-expired-auth`, `offline-stream-lost`, `offline-local-keeps-playing` |
| C1-26 | Comments in DL-C1's files condensed to one line | ab23c423 (+ 9bd3c386) | — |
| C1-22 | Not ours: `use-download-ui.ts` is DL-C2's (fb/dl-ui already narrows that subscription to the `/me` key). Node 24.14.0 run below | — | — |

Decisions in this round: a refused file never relies on the engine's English diagnostic (the earlier one-byte file probe of
32417219 is gone); `markFileUnreadable` was not added — a decode error does not prove the file is bad, so the record stays
`done` and the card offers "Stream instead" online. `mustChangePassword` keeps its gate also offline (no downloads until
the password is changed) — unchanged behaviour, noted for DL-Q.

### API changes after freeze (additive, for DL-C2)
- `SpaceVerdict.unknown?: true` with `fits: false` while the free space is unknown (`useDownloadSpace().verdict` for a
  custom subset already exists — C1-16).
- `DownloadForWork.locked: 'age_restricted' | null` (`playable` false when locked); `lockOf(download, policy)`.
- `useDownloadRecord(id)` (per-download subscription with live speed); `store.subscribeTo(id, listener)`.
- `OfflineDownloadError.actions` may contain `remove` (`file_missing`: `['retry','remove']`; not allowed / age:
  `['remove']`) next to `retry` / `otherVersion` (C1-10 renders them).
- `checkLocalPlayTarget()` (async file check), `manager.verifyLocalFile(id)`, `manager.holdFile(id)`,
  `manager.refreshPolicy(accountKey)`; `store.policy()/setPolicy()`; `OfflineMetadata.minimumAge/rated`; `ViewerPolicy`.
- Player card actions `removeDownload`, `streamInstead`; notice `downloadMissing`; error code `download_file_missing`.

### Checks after fix round 1 (Node 24.14.0)
- `npm run typecheck` exit 0; `npm run lint` exit 0.
- `npx jest -w 4`: **260 suites, 2574 tests: 2573 passed, 1 failed** — `screens/settings/__tests__/capabilities.test.tsx`
  "keeps the detected value…" timed out under machine load (load average ~25); the suite passes 9/9 alone. Earlier full
  runs at load ~64 timed out 12 unrelated suites; all pass with fewer workers — load artefacts, not regressions.

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
