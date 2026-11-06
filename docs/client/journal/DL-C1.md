# DL-C1 — client core (offline downloads)

Status: in-progress

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

- Baseline on clean `fb/dl-core` (before any DL-C1 change): jest 2443 tests, **2 pre-existing failures** from the merged
  freezes: `errors.test.ts` (11 newly documented download codes unknown to the client) and `no-literal-text.test.ts`
  (`downloads/engine/fake.ts` diagnostics). Both fixed in the freeze commits.

- 2026-11-06: read PLAN §2–4 + DL, downloads-plan.html, api.md § 14, schema download DTOs, engine types/index/fake,
  DL-N journal. `npm install` in client/.

## Evidence

## Requests to DL-N

## Follow-ups
