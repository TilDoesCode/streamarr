# DL-C1 — client core (offline downloads)

Status: done — phase B passed on the Android phone, the Google TV 13 emulator and the iPhone Air simulator (limits below)

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
  verifying | done | failed` (+ `waiting_volume`, and `removing` since a519c97b, `isRemovingDownload`). Also `OfflineLibrary`, `SpaceVerdict`, `DownloadStorage`, `DownloadsSupport`,
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

## DL-S fix round 1 contract (fb/dl-server f76055ed; not merged yet — orchestrator says when)

`client/src/api/schema.d.ts` on this branch is already identical to f76055ed's (checked with `git show`), so the merge
brings no schema change. How each point is handled (9a1366c8 on top of 32417219 / ab23c423):

| Contract | Client |
|---|---|
| `fileUrlRevoked: true`, `fileUrl: null`, state `ready` | file URL refusal (410/404) → `GET` record → revoked or expired → `renew` → `resume(id, { url })` keeps the partial |
| `renew?deviceId=` (new URL after a security sign-out) | every `renew` sends `deviceId` = install id |
| `410 download_revoked` → renew after (re-)login, never delete | renew/GET `401` → `waiting_server` `signed_out`, record + partial kept; `resumeSignedOut(owners)` continues at once when the profile signs in again |
| `403 downloads_not_allowed` / `403 age_restricted` (params) terminal, completed files stay | 403 → `renew` (same checks server-side) → its 403 code + params on the record, action `remove`, partial kept; renew answers → continue; renew 401 → wait for sign-in; a finished file stays `done`, a refused completion waits for the next launch |
| `410 download_expired` → renew | expiry judged on the server clock (`serverNow`), so a device clock behind the server renews instead of calling the source gone |
| `404 unknown_download` (URL older than the current one) | `GET` record → resume on the current `fileUrl` |
| transfers end ≤ 2 s, then a 4xx on the next request | engine retries the broken body natively, the 4xx fails at once → the paths above |
| prepare idempotency viewer + `deviceId` + `clientRef` | stable install id + local download id as `clientRef` on every prepare/retry |

Tests: `manager.test.ts` (revoked → signed out → sign-in resume on the renewed URL; 403 with server reason and age
params; 403 + account disabled → waits; 403 with access back → continues; refused completion of a finished file; clock
behind the server → expired link renewed). typecheck 0, lint 0, jest 261 suites / 2588 tests (two suites' workers were
killed by SIGSEGV under machine load in the full run and passed on their own).

## DL-N fix round — prepared ahead of the interface (7edc045b)

Orchestrator heads-up 2026-11-07 (exact engine/fake changes still to come from DL-N):

| Engine change | Client now |
|---|---|
| Retry-After waits capped at 12 h without progress → `failed` `http` + last status + `retryAfterMs`; min 2 s | any `failed` with 0/408/425/429/5xx (or `network`) → `waiting_server` with `retryAt` = max(2 s, Retry-After), resumed by the manager; never a hard failure |
| state `completed`, then one final progress | progress and non-final task states never change a `verifying`/`done`/`failed` record (`SETTLED` guard) |
| `start` on a path owned by another task → `invalid_state` | per-download paths; a rejection still ends as `file_system` with `params.engineCode` |
| removable volumes, `failed` `file_system` `volume_unavailable` | additive state **`waiting_volume`** (de "Speicher nicht verfügbar", en "Storage not available"; DL-C2 shows it via `downloadStateLabel`, the library shows its error line like any `waiting_*`), resumed on wake / 60 s recheck when `volumes()` lists the id; a finished download on a missing volume stays `done` with `error.code = volume_unavailable` and is not playable (`playable` false, no local play target) instead of `file_missing`; guard only, every download is on `internal` today |
| `headers` allowlist | the manager passes no headers |
| stricter fake | waiting for DL-N's list of affected tests |

Tests: `manager.test.ts` › "engine fix round (DL-N)" (5). typecheck 0, lint 0, jest 261 suites / 2593 tests.

## DL-N fix-round interface (fb/dl-native 220a0ded) — adapted in 99894c0b, merge pending the final head

| Point | Client |
|---|---|
| 1 unsolicited `cancelled` (notification Cancel) | removed like Remove (record, server DELETE, files + artwork); the manager's own cancels (retry, restart) are registered (`ownCancels`, 30 s) and keep the record; a task **listed** as `cancelled` at launch → removed, not restarted (reverses C1-23) |
| 1 unsolicited `paused` / Task-Manager stop | record `paused` (retry time cleared), never resumed at launch/reconcile/wake; only the viewer's Resume continues it; a late `paused` never overwrites `failed` |
| 2 `cancel` resolves after the end | cancel → deletePath → start(same id/path) as before |
| 3 path ownership | `remove`: completed/failed → `engine.remove`, else `cancel`, then `deletePath`; orphan tasks: remove/cancel first, then their own folder (only `…/<taskId>`) |
| 4 header allowlist | no headers passed |
| 5 Retry-After 2 s … 1 h, 12 h deadline → `failed` http | `waiting_server` with `retryAt` = clamp(Retry-After, 2 s, 1 h) and resumed later; a `waiting_wifi`/`waiting_network` event keeps a pending `retryAt`; 416 → restart once, then failed |
| 6 `completed` + one final progress | ignored once `verifying`/`done`/`failed` |
| 7 volumes `volume-<uuid>`, `volume_unavailable`, engine continues by itself | `waiting_volume` without a retry action; when the volume is listed again the manager follows the engine's task (no extra resume) and resumes only a task still failed; finished files on a missing volume stay `done`, unplayable |
| 8 iOS pause racing completion | stays `paused`; Resume completes it (no auto-resume) |
| 9 unknown native errors → `io` | `start` rejection → `file_system` with `params.engineCode` |

Verification: 220a0ded's engine files were checked out temporarily (not committed, restored): full jest **262 suites /
2685 tests** green with the new fake (incl. DL-N's conformance tests); this branch as committed: typecheck 0, lint 0, jest
**261 / 2601**. Tests: `manager.test.ts` › "engine fix round (DL-N)" (13 incl. 6 for point 1, 1 for 5, 1 for 6, 3 for 7);
volume tests run on both fakes (`sdCard()` uses `mountVolume` when the fake has it).

**Request to DL-N (sent via the orchestrator):** a Cancel from the notification while JS is not running is lost — the engine
forgets the task, so at the next launch it looks like a lost task and the manager restarts it. Keep a viewer-cancelled task
in `list()` as `cancelled` until `remove(id)`; the manager already removes such a download at launch.

## Queued round (2026-11-07): merge, DL-S round 2, nits, revoked-link device check

- **Merge** `fb/downloads` 97d36070 (DL-S fix rounds 1/1b/2 + DL-N fix round 1 incl. the native subtitle-lift fix) →
  dcfcc9ac; only `docs/client/JOURNAL.md` conflicted (append-only, both sides kept). New documented code `412
  precondition_failed` registered (de/en, own title) and handled like a 409 (restart once) → 88d59d4c.
- **DL-N tombstones** (orchestrator decision): a task cancelled outside the app stays listed as `cancelled` until
  `remove(id)`; the manager removes the download and clears the tombstone with `engine.remove` → 08b345cb.
- **DL-S round 2 semantics** → 44d54c79: `ready` + `fileUrlRevoked` with no URL (a security sign-out overtook the
  preparation) is taken as prepared and renewed with this device's id, then the engine starts (or resumes an existing
  task); `freshUrl` renews a revoked record instead of reporting it not found; any 401 waits for the next sign-in instead
  of failing. Concurrent renewals / idempotency columns need nothing on the client (stable install id + clientRef).
- **Nits** → 9da3fafa: finished movie rows get a Play button next to Delete (episode rows keep row-press); the no-network
  card's retry and sync lines name the device coming back online, not the server (de/en). Found on the device: a slow
  transfer read "0.0 MB/s" → KB/s below 1 MB/s (13ad2aa1).

### Revoked-link device check — Android phone (emulator-5554), dev client dl-native-a36493d1, Dev World c3e8b14d
1. Tears of Steel (FLAKY 1080p MKV, 12.3 MB) under a 300 kbps throttle fault: downloading
   (`phone-revoke-1-downloading.png`, also shows the new movie Play buttons).
2. Second anna session → `POST /viewer/me/sessions/sign-out-others` (19 sessions): the transfer broke off; record
   `waiting_server` / `signed_out` (401) with **2,111,460 bytes kept**; profile signed out (`revoked_by_viewer`), the
   picker says "Signed out from another device" (`phone-revoke-2-signed-out.png`). Server: record `ready`,
   `fileUrlRevoked: true`.
3. Signed in again: `renew?deviceId` → new capability, `expiresAt` +30 days, server `fileUrlRevoked: false`; the engine
   continued from 2.4 MB with **restarts 0** (Range + If-Range on the same ETag) (`phone-revoke-3-resumed-after-sign-in.png`).
4. Throttle cleared → `done`, 12,289,591 bytes = size, `serverCompleted: true` (`phone-revoke-4-done-movie-play-buttons.png`);
   played locally from the new Play button: VLC, MKV E-AC3 5.1, position advancing.
Not re-run on device this round: 403 `age_restricted` / `downloads_not_allowed` and account disable (jest-covered; the
same refusal path as the revoke).

Checks: typecheck 0, lint 0, jest **264 suites / 2692 tests**.

## Blocked downloads come back by themselves (orchestrator decision, 2026-11-07)

Orchestrator update: (1) DL-S fix round 1 (cdd6a6b8) was already merged; the published snapshot is now 6be29f29 (newer
than 1e9ffd3a) and was used below. (2) Disabling an account does not rotate file URLs; it ends the sessions
(`refresh_session_revoked` / `account_disabled`, 401) and refuses the URL with 403 `downloads_not_allowed`; re-enabling
restores the same URLs. (3) `downloads_not_allowed` / `age_restricted` on a transfer: failed with `actions: ['remove']`,
finished files stay (age-locked, C1-21), automatic re-evaluation, no Retry while blocked.

**Client (e4bc6659, 09022098):**
- `src/downloads/blocked.ts`: `isBlockedDownload`, `allowedAgain(download, policy)` — downloads on; for age refusals the
  server's decision params (`reason` `above_age_limit` + `minimumAge`, `unrated_blocked`, `rating_unavailable`,
  `viewerMaxAge`) against the persisted `maxAge`/`blockUnrated`.
- Manager `recheckBlocked(accountKey?, force)` on launch (end of reconcile, forced), every wake (reconnect, foreground,
  sign-in) and `notePolicy()` (every `/viewer/me` answer via the provider; forced when the permissions changed). Allowed
  again → **renew** (GET only checks the session, renew runs `RequireAllowed` + the age gate, so its answer proves the
  file is served) → `resume(id, { url })` on the kept bytes (enqueue when the engine has no task); never prepared →
  prepared anew; finished → the error goes, the lock follows the policy. Still refused → stays blocked with the server's
  code/params. Per record at most once a minute unless forced; owners still blocked by their last known permissions
  re-read `/viewer/me` at most once a minute, so an admin's change is noticed on the next wake.
- Disabled account: file 403 → renew 401 → `waiting_server` / `signed_out` with the bytes; after re-enable and
  sign-in it continues on the same link.
- UI: blocked rows offer Delete only (no Retry; the device found a Pause fallback → fixed); `downloads_not_allowed`
  text says unfinished ones continue by themselves (de/en).
- Tests: `downloads/__tests__/blocked.test.ts` (9: the off → blocked → on round trip without re-downloading, age limit
  not yet enough / enough, noticed on wake, disabled account on the same link, still refused, preparation cancelled →
  prepared anew, finished file lock, launch, `allowedAgain` table), `screens/offline/__tests__/offline-shell-blocked`
  (Delete only; another failure keeps Retry, no Pause). typecheck 0, lint 0, jest **266 suites / 2702 tests** (the last full run had 4 tests in 3 non-download suites —
  local-server, connection, screens — exceed the 5 s timeout at load average ~50; all 127 tests of those suites pass alone).

**Android phone (emulator-5554, dev client dl-native-a36493d1, Dev World 6be29f29):** Tears of Steel under a 300 kbps
throttle → admin `PATCH /config/viewers/{anna}` `allowDownloads: false` → the transfer broke off at 1,919,640 bytes
within 2 s, the next request got 403 → record `failed` `downloads_not_allowed`, `actions ['remove']`, persisted policy
off (`phone-blocked-2-downloads-off-delete-only.png`; before the fix it showed Pause: `phone-blocked-1-…`) → admin on →
app to background and back (a wake, no profile refresh needed) → `/viewer/me` re-read, renew, `resume(id, { url })`:
error cleared, engine task queued with **1,919,640 bytes, restarts 0** (`phone-blocked-3-allowed-again-resumed.png`).
The native engine then stalled (see below); Pause → Resume from the app recovered it and it finished: 12,289,591 bytes,
`done` (`phone-blocked-4-done.png`).

**Native engine stall (reported to DL-N via the orchestrator):** the resume ran at app foreground; native
`onForeground()` (host null, active task) replaced the just-scheduled job (`requestHost(replace = true)`); the replaced
instance's `hostStopped(CANCELLED_BY_APP)` cleared the newer host (`stopAll(HOST)`, `hostRequested = false`) while
JobScheduler kept the new job active (Ready false, `!active=false`), so `ensureHost` never scheduled again. Log:
```
11-07 01:27:40.986 I/OfflineDownloads(16061): previous process was stopped by the user (reason 10, [FORCE STOP] stop dev.streamarr.app due to from pid 16051): unfinished downloads pause
11-07 01:28:02.460 W/JobScheduler(  539): Job didn't exist in JobStore: c50da96 #u0a195/3354 dev.streamarr.app/expo.modules.offlinedownloads.DownloadJobService
11-07 01:28:53.723 I/OfflineDownloads(16061): dmw5nzvq7jko6ole4: ProtocolException: unexpected end of stream, attempt 1, retry at 1794011335723
11-07 01:28:55.763 I/OfflineDownloads(16061): dmw5nzvq7jko6ole4 failed: http HTTP 403
11-07 01:30:26.248 I/OfflineDownloads(16061): host stopped (CANCELLED_BY_APP), reschedule=false
11-07 01:30:26.300 W/JobScheduler(  539): Job didn't exist in JobStore: df2de0b #u0a195/3354 dev.streamarr.app/expo.modules.offlinedownloads.DownloadJobService
11-07 01:33:22.806 W/JobScheduler(  539): Job didn't exist in JobStore: def4fe7 #u0a195/3354 dev.streamarr.app/expo.modules.offlinedownloads.DownloadJobService
11-07 01:33:24.527 W/JobScheduler(  539): Job didn't exist in JobStore: ab5852 #u0a195/3354 dev.streamarr.app/expo.modules.offlinedownloads.DownloadJobService
11-07 01:33:24.712 W/JobScheduler(  539): Job didn't exist in JobStore: 82a79e #u0a195/3354 dev.streamarr.app/expo.modules.offlinedownloads.DownloadJobService
```

## DL-S fix round 2 semantics pinned (fb/dl-server 4cd9ea7d; lands in fb/downloads later)

No manager change was needed (44d54c79 already implemented them); new tests pin each point, mutation-checked:

| Server behaviour | Client | Test (`manager.test.ts` › "DL-S fix round 2") |
|---|---|---|
| security sign-out while preparing → `ready`, `fileUrlRevoked`, no URL, no bytes | renew with this device's id → engine **`start`** (not `resume`) with `expectedBytes` = `sizeBytes`, `etag` = `eTag` | "…renews (with this device) and then starts" (asserts `start:` not `resume:`, totalBytes, etag) |
| signed out at that moment | renew 401 → `waiting_server` / `signed_out`, record kept → after sign-in renew + start | "signed out at that moment…" |
| ordinary logout while preparing keeps the URL | poll 401 → waits; after sign-in the poll returns the ready URL, **no renew** | "a 401 answering the preparation poll…" |
| 401 at answer time on prepare POST | waits, no `downloadId`; after sign-in prepares again with the same `deviceId` + `clientRef` (one server record) | "a 401 answering the prepare POST…" |
| 401 on the device list | nothing deleted on either side; the next reconcile cleans the orphan | "a 401 answering the device list…" |
| concurrent renewals return the same new URL | two sign-in resumes + a wake racing → one engine task on the one renewed URL | "renews racing for one revoked download…" |
| idempotency (viewer, device trimmed/ASCII case-insensitive, clientRef) | install id `i` + lowercase base36, persisted; `clientRef` = local download id | `store.test.ts` (format + stable across instances) |

Mutation check: removing the prepare 401 branch fails the POST and poll tests; `resume` instead of `start` for a revoked
ready fails the first test.

## Turn 2026-11-07 (orchestrator: merge, round 2, revoked-link device runs, nits)

1. **Merge** `fb/downloads` (8ed24f3e; DL-S rounds 1, 1b, 2 and 3 were already in via dcfcc9ac / 837911ee / d441cacc,
   `d9f040a2` included) → dfc3eda9, journal commits only. typecheck 0, lint 0, jest 266 suites / 2705 (one
   streaming-path diagnostics test hit the 5 s timeout at load ~38, passes alone).
2. **Round-2 semantics:** implemented in 44d54c79, pinned in 7211a346 (revoked ready → renew → `start` with size + ETag;
   401 at answer time on prepare/poll/list → sign-in handling, nothing failed or deleted; concurrent renewals → one task on
   one URL; stable install id + clientRef). No change needed this turn.
3. **Device runs** — Android phone (emulator-5554 = Streamarr_Phone by `emu avd name`), dev client `dl-native-a36493d1`
   (matches the engine merged in fb/downloads), Dev World restarted from snapshot **464a7952** with kept data:
   - **A — admin "sign out all sessions" during a running download** (`DELETE /config/viewers/{id}/sessions`, Tears of
     Steel FLAKY MKV under a 300 kbps throttle): transfer broke off at **1,657,440 bytes**; record `waiting_server` /
     `signed_out` (401) with its `downloadId`; server `ready`, `fileUrlRevoked: true`; picker "Signed out by the server
     admin" (`phone-admin-signout-1-picker.png`); sign-in screen **"1 download continues after you sign in again."**
     (new, `phone-admin-signout-2-sign-in-hint.png`); signed in → renew (server `fileUrlRevoked: false`, same ETag) →
     the engine continued from the kept bytes, **restarts 0** (`phone-admin-signout-3-resumed.png`) → done, 12,289,591 B,
     completed on the server.
   - **B — sign-out while still preparing** (Cosmos Laundromat, `resolve_hang` 75 s on its work id): record `preparing`
     / `resolving`, no file, 0 bytes → admin sign-out-all → the long-poll's 401 → `waiting_server` / `signed_out`, record
     kept; server after the hang: `ready`, `fileUrlRevoked: true`, 8,654,507 B + ETag, never a URL; sign-in screen "2
     downloads continue…" (`phone-preparing-signout-1-sign-in-hint-2.png`); signed in → poll → revoked ready → renew →
     `start` (no task could exist: no relativePath, 0 bytes) → done at exactly 8,654,507 B with the server's ETag,
     completed (`phone-preparing-signout-2-both-done.png`). Tears of Steel (signed out a second time at 3,846,780 B) resumed
     and finished in the same sign-in.
   - Before A, the cold start hit DL-N's **N2-11** host race again (`host stopped (CANCELLED_BY_APP)` 22 s after launch,
     task `queued` with the job "active"); Pause → Resume from the app recovered it. Fix pending in DL-N round 2.
4. **Nits** (9da3fafa, earlier): Play button on finished movie rows (row press still plays, TV select); no-network card
   names the device. Device: `phone-offline-no-network-device-copy.png` (Wi-Fi + data off on the phone).
5. **New (80a2adc6):** a signed-out profile cannot reach the library, so the sign-in screen now says how many of its
   unfinished downloads continue after sign-in (de/en plural, `SignInDownloadsHint`); a download waiting for the sign-in
   reads "Continues after you sign in again" (DL-C2's wording). Test `sign-in-downloads-hint.test.tsx`.

Final checks (head 80a2adc6 + journal): typecheck 0, lint 0, jest **267 suites / 2707 tests**, all passed.

Not in this turn: DL-N fix round 2 interface (af135dd5: pending cancel/remove = "removing", `.part` paths) — waits for
the announced final head.

## Revoked link on all three devices with the a36493d1 dev clients (2026-11-07)

Merge `fb/downloads` ce5e05a5 (DL-S fix round 4, server + one doc sentence: a renewed URL keeps transferring when the old
one is retired) → e0555637; only `docs/client/JOURNAL.md` conflicted (append-only, both kept). typecheck 0, lint 0, jest
**267 suites / 2707 tests** (Node 24.14.0). Dev clients from `dl-native-a36493d1` (= DL-N fix round 1 head bec40ef2,
merged via 97d36070): phone + Google TV `adb install -r -g` (keeps data), iPhone Air argent `reinstall-app` (clean);
each opened explicitly on Metro 8082 (`/json/list`: only my three apps of this project). Dev World 39300 = 3752e5ad.
Scenario per device: Tears of Steel (FLAKY MKV, 12,289,591 B) under a 300 kbps throttle → admin
`DELETE /config/viewers/{anna}/sessions` mid-transfer → sign in again.

| Device | After the sign-out | After sign-in | Server log of the resumed request | Result |
|---|---|---|---|---|
| Android phone (emulator-5554) | 1,657,440 B kept, `signed_out` | renew → resume, restarts 0 | (last turn) | **pass** (+ preparing run) |
| Google TV 13 (emulator-5558, D-pad) | 1,608,690 B kept, `signed_out`; server `ready` + revoked; sign-in "1 download continues after you sign in again" | D-pad sign-in → renew (new URL, same ETag) → resume, restarts 0 | **10,680,901 B** (= 12,289,591 − 1,608,690) | **pass** |
| iPhone Air (iOS 26.5) | engine: `failed http 410`, bytesWritten **166** (the 410 body), no partial; sign-in "1 Download geht nach erneuter Anmeldung weiter." | renew → `resume(id,{url})` | **12,289,591 B** (whole file, no Range) | done + completed, but **bytes re-downloaded** |

**DL-N finding (reported):** on iOS the partial of a transfer cut by a revocation is lost: the cut-off gives resume data,
the retry's 410 answer replaces it (166 B body), and `resume(id, { url })` starts from 0. The contract says the bytes stay;
fix belongs in the iOS engine (keep the previous resume data when a retry answers 4xx). Client unchanged.

Test-tool artifact: my Dev World helper signed Anna in once per poll and pushed her past the 20-session limit, so the
iPhone was signed out (`session_limit`) right after its file finished. Side evidence: the finished file stayed `done`;
its pending completion waited for sign-in and was sent afterwards (`serverCompleted: true`). Helper now reuses one session.

Screenshots: `tv-revoke-1-downloading.png`, `tv-revoke-2-picker.png`, `tv-revoke-3-sign-in-hint.png`,
`tv-revoke-4-done.png`, `ios-revoke-1-downloading.png`, `ios-revoke-2-sign-in-hint-de.png`, `ios-revoke-3-done-de.png`.
Notification-cancel tombstone test: done after DL-N round 1c (see the next section).

## DL-N fix round 1c: notification-cancel tombstone (2026-11-07)

Merged **2a6e65a1** only (TS + fake; `fb/dl-native` had moved on to round-1c native and the unannounced round-2
interface af135dd5…b1340937, which waits for the announced final head) → fbbffb92. Contract: the app's own `cancel` is an
event only (task forgotten); a cancel outside the app (Android notification) leaves a `cancelled` tombstone in `list()`
(bytes 0, no error, partial deleted, owns no path) until `remove`, which is now idempotent.

Fix 87c5d622: two paths still read a listed `cancelled` task as "no task" (a leftover of the reversed C1-23 rule):
- a wake reaching a waiting download before the launch check went `continueTransfer` → `enqueue`, which removed the
  tombstone and **downloaded the file again** from 0 (test reproduced it: state `downloading`, 0 bytes);
- the launch check skipped `failed` records before looking for a tombstone, so such a record and tombstone stayed.
A tombstone now removes its download wherever it is met (launch first, `continueTransfer`, `enqueue`); an orphan
tombstone (record already removed live, engine kept it over a kill) is forgotten with `engine.remove`, no file ops.

Tests (`manager.test.ts` › "DL-N fix round 1c", on `controls.userCancel`): launch after a cancel while the app was not
running (record gone, one server DELETE, tombstone cleared with `remove`, folder gone, **no new prepare/start**); live
event with a tombstone left over a kill (removed at once, one DELETE, the relaunch clears it without a second DELETE or
error); a second DELETE answering 404 (nothing surfaced, nothing queued); a failed record whose task was still held; a
wake before the launch check (removed, no new start). The fake server's DELETE now answers 404 for an unknown record,
like the server. typecheck 0, lint 0, jest **267 suites / 2715 tests** (Node 24.14.0).

## Removing state + DL-N fix round 2 (2026-11-07)

Commits: **a519c97b** type first for DL-C2 (`'removing'`, `isRemovingDownload`, `downloads.state.removing` "Removing…" /
"Wird entfernt…"; hash sent to the orchestrator), **b4a5e203** merge `fb/dl-native` 3fc66a7d (TS engine unchanged since
af135dd5; native only: N2-11 host race, iOS https→http; not built here, dev clients stay a36493d1), then the removal
pipeline and round-2 adaptations (this section).

Decision "removing" (DL.md) as built:
- **Every removal path** sets `removing` synchronously and persisted before anything else: `remove`/`cancel`,
  `removeMany`/`Season`/`Series`/`All`/`Watched` (all marked before the first is deleted), the viewer's cancel outside
  the app (event or tombstone at launch, `continueTransfer`, `enqueue`), a failed download a new `start` replaces. Polls
  abort, backoff and pending URL go, live speed clears; the record keeps its fields. Not ACTIVE; `remainingBytes` and
  `bytesOnDevice` 0; out of the badge, `useAccountDownloads`, the sign-out prompt, season bytes and the library total.
- **Order:** engine (cancel; remove for completed/failed/tombstone) → media file → outbox entry + record → artwork
  (download folder) → server DELETE. The outbox (`pendingDeletes`) is now the store itself (no in-memory copy that a
  removal before the launch load could overwrite); `flushDeletes(owner)` runs per profile in the background (404 = gone);
  launch and every `wake()` (reconnect, foreground, sign-in) flush the rest. A removal never waits for the server and works offline / signed out. `removeAll`
  (sign-out prompt) does await the flush so the server hears it while the session is still valid.
- **Pending stops:** exactly `code === 'io'` with detail `cancel_pending` / `remove_pending` (the wrapper's message is
  `io: cancel_pending`) → asked again after `PENDING_RETRY_MS` (1 s; each engine call waits up to 30 s itself), never a
  failure, files untouched until the transfer ended. Any other `io` is a real error: the removal goes on, the launch
  cleans what the engine still holds. `remove` refused with `invalid_state` (started again) → `cancel`. App stopped
  while pending → the record stays `removing` and the launch continues it before anything else.
- One stop per task (`stopTask`) for removals, the manager's own cancels (retry/restart now also wait for the drain, so
  the same path can be claimed again), the discard after a start race and orphan cleanup at launch.
- **Final:** `set()` ignores every patch for a removing record (late prepare/poll answers, engine events, progress);
  `onTask`, `continueTransfer`, `enqueue`, pause/resume/retry skip it; a preparation answered after the removal puts its
  `downloadId` into the outbox.
- **`work_removing`:** `start` of a work being removed (or of a failed one whose replacement removal is still pending)
  rejects before anything is created (multi-item starts are checked as a whole); `downloads.error.work_removing`.
- **Library:** a removing row stays where it was (finished → series/movies via `isFinishedRow`; unfinished → In
  progress), dimmed (0.4), no press, no actions (nothing focusable on TV), "Removing…" only after `REMOVING_LABEL_MS`
  600 ms; a series whose finished episodes all go shows one subdued row; In progress drops "· 0" when only removing
  rows are left (`downloads.library.inProgressTitle`).

DL-N round 2 otherwise:
- `retryAt` is display only: while the engine is `retrying`, the record shows its time but the manager's timer and
  `wake()` no longer resume the task at that wall-clock time (`resume` would drop a Retry-After wait after a clock jump);
  the engine's own deadline ends the wait. The viewer's Retry still cuts it short.
- A server file name ending in `.part` gets `_` appended (`.part` targets are `invalid_argument` now).
- Claims of final + `.part` incl. ancestors: the manager deletes a download folder only after its task stopped (already
  so; now also after a pending drain), artwork lives in the same folder but is not an engine path.

Tests: `removing.test.ts` (17, on fake `stallDrain` / `releaseDrain` / `wallNow`): synchronous persisted mark; exact
step order with the outbox written before the record goes; `cancel_pending` (stays removing with its `.part`, retried,
never failed, DELETE only after); `remove_pending` of a failed task (missing volume); notification cancel while the
drain stalls; kill while pending → the launch finishes it; `work_removing` (also via a failed replacement); other `io`
not retried; exact pending matching; the outbox when the server never answers; a prepare answered after the removal;
late wake/resume/retry ignored; a season marked as a whole; wall-clock jump vs Retry-After (fails without the fix:
resume ×1); the viewer's Retry; queued deletions sent at the next wake. `offline-shell-removing.test.tsx`: subdued row without Delete/Pause/press, label absent
at first and shown ≥ 550 ms later, row gone and empty state once the drain ends. `store.test.ts` updated.
Spec re-check (orchestrator's removing spec, received after the build): all six points were in; added the pending
retry **backoff** (1 s doubling to 30 s, `pendingRetryDelay`) and four spec tests — tombstone at launch saved as
`removing` before the engine forgets it, offline DELETE drained on reconnect, 401 kept until sign-in (404 = done), and
`useDownloadFor` / season counts / badge with a removing record (`hooks.test.tsx`).

Checks (Node 24.14.0): typecheck 0, lint 0 errors (6 old warnings in `jest/player/harness.ts`, `jest/setup.ts`),
prettier clean, jest **269 suites / 2755 tests** (one series-stage navigation test failed once under load, passes alone).

Device check — Android phone (emulator-5554 = Streamarr_Phone, `emu avd name` verified; dev client a36493d1, Metro 8082
on cbd37532, Dev World 39300 = e5a94883, transfers throttled to 300 kbps; `/dev/downloads`):
- **Finished** Cosmos Laundromat deleted in the UI: row gone at once (no label: faster than 600 ms), storage 100 → 92 MB,
  download folder (file + art) gone, record gone, outbox empty, server record 56d020e1… gone from the device list.
- **In progress** (re-downloaded, 37 KB/s, `.part` 342,680 B, server `ready`): Delete → states `downloading → removing →
  gone` (never `failed`), real engine cancel ended the transfer at once, 0 engine tasks, folder incl. `.part` gone, outbox
  empty, server record a3c4d928… gone.
- **Slow drain** (the running app's `engine.cancel` wrapped to reject `io: cancel_pending` 5× like the native module):
  dimmed row "Cosmos Laundromat · Removing…" without Pause/Delete under a plain "In progress" header
  (`screenshots/DL-C1/removing-phone-subdued-row.png`, before: `removing-phone-before.png`); 6 cancel calls over 5.1 s,
  then gone, 0 tasks, outbox empty, no server record. A real `cancel_pending` needs DL-N's round-2 native build (not in
  the a36493d1 dev clients); the fake pins it in jest.
- Not run on Google TV / iPhone this time (same JS path; the removing row has nothing focusable, pinned in jest).
Afterwards: throttle cleared, phone on its home screen, Metro and Dev World stopped by PID, argent scoped to 5554.

## DL-N fix round 3 adaptation (2026-11-07, jest only)

Merge **f1c846dd** = `fb/dl-native` acca869f (round-3 TS/fake; brings fb/downloads 60fa6a07 incl. DL-S round 6, so that
follow-up is closed). No native build, no devices.
- **N3-03** (segments ending in `.` or space → `invalid_argument`): `safeFileName` strips trailing dots/spaces after
  the 120-char tail and before the `.part` guard; empty → `<id>.bin`. Account folder (`a` + hex), download id
  (`d` + base36) and artwork (`art/<kind>.jpg|png|webp`) cannot end in either. Test: `Movie.`, `Movie. `,
  `Movie.mkv...`, `...`, spaces, a 200-char name whose tail ends in dots, `x.part.`, `Movie . . ` — no segment ends in
  `.`/space and the fake's `start` accepts each path (fails without the fix).
- **N3-02** (`deletePath`/`move` refuse paths of any registered unfinished task): every call site stops the task
  first (`retry`, `restart`, `removeNow`, `discardTask`, orphan sweep); `move` is unused; `onFileGone` deletes nothing;
  the snapshot cleanup for a vanished record now goes through `discardTask`. New `pathsReleased(id)`: files are only
  deleted once `get` shows no task, a completed one or a tombstone — after a real (non-pending) stop error the record
  still goes, the held files wait for the next launch's orphan sweep (`sweepOrphan`). A failed `get` defers to the
  engine's own refusal rather than leaking files. Tests: orphan sweep never touches a paused / failed (kept bytes)
  task whose stop failed for real (`deleted` = [] — fails on the old code), cleans it at the next launch; a completed
  orphan's file is still deleted; a removal with a real stop error leaves the files to the launch sweep.
- **N3-06** (cancel on a draining tombstone waits): the launch removes tombstones with `remove`, which already waited;
  backoff covers both. **Bug found while writing the test:** reconcile awaited each removal and orphan stop in its
  loop, so one stalled drain held up re-attaching every other download (native: ≥ 30 s per call). Removals, orphan
  sweeps and watched-deletions now run in the background; `reconcile()` still awaits them at its very end. Test
  (`userCancel` + `stallDrain` + relaunch, the cancelled one first in store order): `removing` persisted, retried,
  `.part` kept, no DELETE yet, the other download finished meanwhile is `done`; after release everything is gone,
  one DELETE, empty outbox, never `failed` (fails 3/3 on the old code, passes 3/3).
- Observation for the orchestrator: "Delete downloads" on sign-out (`account-downloads-prompt`) awaits `removeAll`,
  which also waits for drains to end before the profile signs out. Usually seconds; worst case long. Could await only
  the marks + outbox instead — not changed here.
Checks (Node 24.14.0): typecheck 0, lint 0 errors (6 old warnings in `jest/player/harness.ts`, `jest/setup.ts`),
prettier clean, jest **269 suites / 2769 tests**, 0 failed.

## Sign-out with "Delete downloads" never waits for drains (orchestrator decision, 2026-11-07, jest only)

- **`manager.removeForSignOut(accountKey, { forget })`** (the prompt calls it instead of `removeAll`): marks every
  download `removing` (persisted), queues each server record in the outbox and hands it over (`downloadId` cleared on
  the removing record, so the local removal never queues it again), drops the positions, starts the local removals in
  the background (engine with backoff, media, record, artwork; a restart continues them), then flushes that profile's
  outbox once with the still valid session, bounded by **`SIGN_OUT_FLUSH_MS` = 5 s**, at most
  **`DELETE_CONCURRENCY` = 4** requests at once. `forget` (profile removed, `ask(…, { removal: true })` from the
  profiles screen): what the server did not take is dropped afterwards, and a late answer for that profile queues
  nothing in this run (cleared when it signs in again).
- **Outbox flush** per profile, parallel pool of 4; a 404 counts as done; a **401** stops that session and parks the
  profile's outbox until it signs in again (`resumeSignedOut`); every DELETE is bounded by `DELETE_TIMEOUT_MS` (30 s:
  RN's fetch may never time out). A new sign-in starts a fresh flush whatever the old session still waits for (found
  by the unreachable-server test: one hung request blocked that profile's flushes for good). `reconcileServers` runs
  each profile on its own, so a hanging server never holds up another profile; a profile's DELETEs only ever use its
  own `serverFor` session. Removing records no longer count as unsaved preparations (they never block the orphan
  cleanup).
- **UI:** after "Delete downloads" the dialog keeps its title and shows a spinner + "Downloads werden entfernt…" /
  "Removing downloads…" without buttons only for the bounded flush, then signs out; never for drains.
- `removeAll` (the active profile's "delete all", `useDownloadActions`) is unchanged: it waits until the files are gone.
- Tests (`sign-out.test.ts`, 5): stalled drain → sign-out returns at once with the DELETE sent and an empty outbox, the
  drain ends in the background with no second DELETE; unreachable server → resolves at exactly 5 s (fake timers: not
  at 4.9 s), entry kept through sign-out and wake, sent after the next sign-in; 401 → ≤ 4 in flight, no further
  request with that session (also after the local removals and a wake), all sent after sign-in; removal drops the
  entries, the late failing answer and the finishing local removal queue nothing; a second profile's sign-out
  completes in < 1 s while the first one's server hangs, and its server only ever sees its own record.
  `profile-downloads-signout-progress.test.tsx`: progress line without buttons and no logout while the DELETEs are
  unanswered, then `/profiles` while a stalled transfer's record is still `removing`, gone after the drain ends.
Checks (Node 24.14.0): typecheck 0, lint 0 errors (6 old warnings in `jest/player/harness.ts`, `jest/setup.ts`),
prettier clean, jest **271 suites / 2775 tests**, 0 failed (`--maxWorkers=4`; a first run lost one unrelated suite,
`shell-hero-layout.test.ts`, to a jest worker SIGSEGV at load 19, 8/8 alone).

## Final device pass, part 1: Android (2026-11-07)

Setup: `fb/dl-core` fast-forwarded to `fb/downloads` 44fa38ad (no client source change); Node **24.14.0** from
`~/.nvm` (Homebrew's default `node` is now v26; `env.sh` does not pin it) → typecheck 0, lint 0 errors, prettier
clean, jest **271 suites / 2775 tests**. Round-3 dev client `dl-native-a23bc812` installed on Streamarr_Phone
(`emulator-5554`) and Streamarr_GoogleTV13_1080p (`emulator-5558`), every adb call through an AVD-name check. Metro
8082 (Node 24), Dev World 39300 from snapshot e2874df2. Evidence proxy: the devices' `127.0.0.1:39300` is reversed to
a logging pass-through on my port 39302 (method, path, status; capability tokens redacted, no auth bodies; bodies of
`watch/progress`), so every server DELETE and progress post is counted exactly.

1. **Offline shell → local playback → reconnect** (phone): Wi-Fi + data off and the 39300 tunnel removed → offline
   shell (`final/phone-1-offline-shell.png`); Sprite Fright played natively from the file
   (`phone-2-offline-native-playing.png`), Elephants Dream in VLC (`phone-4-offline-vlc-playing.png`); the library said
   "Watch progress is synced as soon as this device is online again" with 6 reports queued
   (`phone-3-offline-progress-pending.png`). Reconnect 15:56:23 → within 2 s six `POST /watch/progress` (200), each
   with its real `occurredAt` (15:52:55.761 start … 15:56:00.214 stop), server resume list = 62.6 s / 109.7 s.
   **Finding** (local playback, mine): "Resume from X" started at 0:00 on both engines, later local MP4s loaded VLC
   with no start position and ended in `network_unreachable`, and playing from 0 overwrote the stored positions —
   fixed in this turn, see "Local playback fix" below (`phone-finding-*.png`).
2. **Removing state** (phone, real engine, Dev World throttled to 300 kbps): Cosmos Laundromat downloading → Delete →
   `removing` 16:02:30.434 → gone .610 (176 ms: the round-3 engine force-closes the read), one
   `DELETE …/397e5e06… → 204`, folder gone, outbox empty (`phone-5-removing-before.png`, `phone-7-removing-gone.png`).
   A real `cancel_pending` cannot be produced on an emulator (DL-N journal: only a write hung in the kernel outlives
   30 s), so the native module's exact answer `io: cancel_pending` was replayed 3× at the engine boundary of the
   running app: dimmed row "Cosmos Laundromat · Removing…" without actions under a plain "In progress"
   (`phone-6-removing-greyed-row.png`); calls at 16:02:59.247 / +1.02 s / +2.04 s / +4.01 s (backoff 1 → 2 → 4 s),
   then the real cancel, gone 16:03:06.314, never `failed`, one `DELETE …/e07f15a5… → 204` at 06.764 (after the
   transfer ended). `remove_pending` was not replayed on the device (same retry loop; jest pins it).
3. **Removing on Google TV, D-pad only** (the same replay): Pause → right → Delete → confirm (Cancel focused by
   default, right → Delete): dimmed "Cosmos Laundromat · Removing…", no actions, **focus moved to the next row** (the
   removing row is not focusable) (`tv-5-removing-greyed-row-dpad.png`); retries 16:41:24.045 / +1.0 / +2.0 / +4.0 s,
   real cancel, gone 31.100, one `DELETE → 204`, outbox empty.
4. **Notification Cancel with the app swiped away** (phone): download running, task removed from Recents (adb swipe; the
   process stays for the job), shade → Cancel (`phone-14-notification-app-swiped-away.png`): notification gone,
   `.part` deleted, **no DELETE while the app was away**; relaunch → exactly one `DELETE …/b4a79087… → 204`, record
   gone, `engine.list()` empty (tombstone forgotten), no prepare, no start.
5. **Notification Pause and a Task Manager stop** (phone): shade → Pause → record and task `paused`, notification gone
   (`phone-15-notification-paused.png`); force stop + relaunch → still `paused`, no resume call; Resume in the app →
   downloading; Quick Settings "1 app is active" → Stop (`phone-16-task-manager-stop.png`) → process gone → relaunch
   → `paused` ("[STOP APP] … unfinished downloads pause"), not restarted. **Engine finding (reported to DL-N):** both
   times the whole partial was lost at the next launch (685,360 B and 1,170,362 B → a new 0 B `.part`; the persisted
   task kept `bytesWritten 0` from the pause) — pause does not checkpoint and nothing was checkpointed within ~1.2 MB /
   30 s. No manager workaround.
6. **N2-11 host race, resume at foreground** (phone): per round the server blocks the running transfer (Dev World
   `allowDownloads` off → break, file 403, renew 403 → `failed downloads_not_allowed`), HOME, permission on, launcher
   intent 2.5 s later. Five valid rounds (1, 4, 6, 7, 8): `queued` → `downloading` in 143 / 184 / 220 / 395 / 340 ms,
   renew 200, the partial continued from the kept offset each time (256,608 → 674,110 → 893,218 → 1,112,326 →
   1,333,220). Never stuck `queued`. Rounds 2, 3, 5 stayed blocked: the manager's own `UNBLOCK_GAP_MS` (60 s between
   asks unless the app saw the permission change) — by design, noted for the orchestrator, not N2-11.
7. **Sign-out with "Delete downloads"** (DE "Downloads löschen"; UI in English) during a running download: prompt
   "12 downloads (95 MB)" (`phone-17-signout-delete-prompt.png`) → Delete → profile picker **2.3 s** later
   (`phone-17b-signed-out-2s.png`); 12 × `DELETE → 204` within 190 ms, then `POST /auth/logout`; server: the phone's 12
   records gone, TV 4 and iPhone 4 untouched; locally 0 records, 0 engine tasks (the running one cancelled), account
   folder empty, outbox empty. Signed in again → "No downloads yet", 0 MB, no preparation, server unchanged
   (`phone-18-signed-in-again-nothing-back.png`).
8. **Offline playback on Google TV** (server cut by removing the tunnel; the TV emulator's Ethernet cannot be switched
   off): native Earthfall resumed at 1:00 (`tv-1-…`), kept playing with the server gone (`tv-2-…`), stop 92.327 s =
   server 92.327 s; VLC Tears of Steel resumed at 1:15 with the server down (`tv-3-…`), stop 85.154 s → after the
   tunnel came back `start`/`progress`/`stop` with their real `occurredAt` (16:38:34–16:38:45), server 85.154 s, next
   open "Resume from 1:25" (`tv-4-…`).
9. **File name with a trailing dot:** skipped — no Dev World release name ends in a dot or space (400 names checked).

### Local playback fix (orchestrator: fix in this turn) — e223a575, c4a64a64 (cherry-pick to `main`)

Root cause of the morning's "resume ignored": **my tooling**. Argent 0.23.0 maps taps on a rotated Android screen to
the rotated point, so taps on "Resume" hit "From the start" (proven: after an argent tap on Resume the live controller
had `chosenStart: 0`; with `chooseStart(true)` or adb taps both engines resume correctly, online and offline). The
zeroed positions followed from that (a "from the start" play reports 0). `VlcEngine.load` with `startPosition: null` was
a legitimate 0 start (Big Buck Bunny `played` on the server; Sprite Fright's stored position below the 30 s threshold).
Argent 0.32.0 is available (not installed: the user's call). Real bugs found and fixed, failing tests first:
- **e223a575** (local only): a local failure is never a network/server class (engine_error/vlc_error), the local
  ladder reloads at most twice (1 s, 2 s), tries VLC once at the position, then the card (online + streaming); a gone
  file (`verifyLocalFile`) → `download_file_missing` card with Delete; nothing saved/reported before the start target
  is reached (the start report follows), the first 10 s never below the stored position, reloads never below the
  target (all except "From the start"/a seek); a local start uses the record's engine (an outside forced engine no
  longer applies; the card's "Use VLC" switches in place); no buffer poll and no lost-playback check for local ids.
  The native→VLC trigger of the 16:00 run did not reproduce on a clean runtime (6 tries); its failure chain is fixed.
- **c4a64a64** (shared, streaming too): expo-video's StartSeek judged a resume on stale readings when the seek outlasted
  its settle window (a start while the phone turns to landscape), gave up after both tries and kept the black start
  cover to the end over a playing picture (live engine: attempts 2, gaveUp, clock 148 → 180). The cover now also goes
  once the clock is at the target (±3 s); a clock that stays at 0:00 keeps it (seg_corrupt test green).
- Device re-check (fix loaded): phone native Resume 2:08 → 2:10/burned-in 2:11 (`phone-8-…`), network cut keeps
  playing (`phone-9-…`), stop 151.185 s = server 151.185 s (`lastPlayedAt` = the offline stop's `occurredAt`); the
  immediate start that went black now shows the picture (`phone-10-…`); VLC Resume 1:30 → 1:33 (`phone-11-…`), cut keeps
  playing (`phone-12-…`), stop 107.066 s = server, reopen "Resume from 1:47" (`phone-13-…`); TV as in 8 above; native
  records started in expo-video every time.
- Checks (Node 24.14.0): typecheck 0, lint 0 errors, prettier clean, jest **271 suites / 2785 tests** (F10 green);
  after c4a64a64 player + play-screen suites 81/81, 1292/1292; final head **271 suites / 2786 tests**, 0 failed.
- Afterwards: Dev World throttle cleared and `allowDownloads` back on, both devices on their home screen (online,
  airplane off), my reverses removed, proxy / Dev World / Metro stopped by PID, argent scoped to 5554/5558. The iPhone
  part follows with DL-N's iOS build 3b.

## Fix round 2 (client verify 2, `docs/client/journal/DL-C-verify2.md` on fb/dl-verify-client d056c375)

Base: merge **722cf81c** = fb/downloads bc6306ca (the reviewed 100da883 + journal only). The verifier's repros
(`client/src/__verify__/round2-*.test.ts(x)` on that branch, never added here) are now ordinary regressions in
`client/src/**/__tests__`; DL-C2 keeps `round2-library` (C2-09) and the UI check `round2-offline-link`. Two helper
sessions worked in this worktree under file ownership (clock: C2-06/07; offline cold start: C1-24); I reviewed and
committed their changes. Commits: **b15e24bd** (core: C2-01…C2-08, C2-10, C1-21, C1-26) and **069e133c** (C1-24).

| Item | Fix | Regression test |
|---|---|---|
| C2-01 | Orphan DELETEs from the server list go through the persisted outbox and its session guard (retry/timeout as every outbox entry); a 401 parks the profile: no list, no orphan deletes until it signs in again. | `downloads/__tests__/server-housekeeping.test.ts` "C2-01: an orphan scan goes through the outbox and stops at a 401" (1 DELETE, entry kept) |
| C2-02 | Per-profile session generation, bumped at sign-in (`resumeSignedOut`), sign-out (owner leaves `setKnownOwners`) and removal (`forget`); a flush/scan of an older session may only drop its own acknowledged entries, never park the new session or keep working. | server-housekeeping "C2-02: a 401 of the previous session never parks the new signed-in one" |
| C2-03 | Removal writes a cleanup job `{ id, accountKey, volumeId, paths: [media, folder (incl. artwork)], bytes }` before the record goes; retried at launch (all), on volume return (parked jobs, checked at wake and every 60 s) and with backoff (30 s doubling to 1 h); never while a record or a registered unfinished engine task owns the id (N3-02); `useDownloadStorage` counts the job's bytes as used until they are gone. | `downloads/__tests__/cleanup-jobs.test.ts` (verifier's launch case, missing volume parked until mount, N3-02 guard); `removing-storage.test.tsx` "C2-03: the bytes of a pending cleanup job stay counted" |
| C2-04 | Every prepare POST is counted per profile; a scan whose list answer arrives while a POST is unanswered, or after one started since the scan began, deletes nothing (that is how "created after the scan started" is decided: only this device's own POSTs create `thisDevice` items); local state is re-read after the list returns; a server item whose `clientRef` matches a local record is never an orphan. **Gap:** `DownloadResponse` has no `clientRef`/`deviceId` (docs/api.md § 14), so the clientRef match only works once DL-S adds them. | server-housekeeping "C2-04: a list answer racing a prepare never deletes the new preparation" |
| C2-05 | Intent generation per download, bumped by pause, removal (`markRemoving`) and sign-out; re-checked after the GET/renew/engine awaits of the refused-link, renew, unblock, forbidden, continue and enqueue paths: a stale continuation may keep the renewed link (`expiresAt`, pending URL) but never changes state, resumes or starts; a pause while a task is being started pauses it. | `downloads/__tests__/transfer-intent.test.ts` (pause during a delayed revoked-link GET; removal during a delayed renew). The verifier asserted the engine task `paused`; the fake cannot pause a failed task, so the test asserts no resume after the late answer and that Resume renews and continues. |
| C2-06 | `server-clock.ts` keyed by `serverKey`; learned in an openapi-fetch middleware of `createApiClient` (keyed by the client's base URL, also under a path prefix), no longer in `createTimeoutFetch`; queued progress keeps its server; positions use their account's server. | `lib/__tests__/server-clock.test.ts` "C2-06: server B's Date never moves A" (±2 h), keyed-under-a-path; `player/__tests__/progress-queue.test.ts` own-server clock |
| C2-07 | Each offset anchored to an elapsed clock (`setElapsedClock`; until DL-N's `downloadEngine.clock()` lands: `performance.now()` with a per-process boot id, so every restart counts as an estimate): same boot exact whatever the wall clock does (wall jumps > 2 s corrected), other boot / no anchor → `Date.now() + offset` flagged `estimated` with uncertainty \|offset\| + 5 min; local positions carry `estimated`, `uncertaintyMs`, `restarted` (the controller's explicit start/seek); `resumeSecondsOf`: an estimate never beats a server stamp inside its window — the larger position wins there unless the local one is an explicit restart. | server-clock "C2-07" (−1 h correction offline → 0 s error), wall set forward, reboot → estimate, no Date header, never-heard server; `downloads/__tests__/clock-merge.test.ts` (5); `player/__tests__/local-mode.test.ts` restarted flag |
| C2-08 + C1-21 | Metadata stores `accessVerified` + `accessCheckedAt` with the verdict (`minimumAge`, `rated`); `fetchAccessVerdict` / `server.access()` separate from the title/artwork snapshot. `lockOf` returns `age_unverified` for an unknown verdict or one older than 90 days under a profile with `maxAge` or `blockUnrated` (unrestricted: never locked; older records count by the verdict fields they carry); files are kept. `revalidateAccess(owner)` runs with every `reconcileServers` (launch and reconnect), apart from the snapshot, with backoff (1 min doubling to 1 h). Offline the player shows its own card (`errors.codes.age_unverified`, de/en); online the server decides. **For DL-C2:** the library/detail label "Altersfreigabe wird geprüft…" for `lockOf(...) === 'age_unverified'` (the shared lock still renders as locked today). | `downloads/__tests__/age-verdict.test.ts` (verifier's repro, unrestricted, legacy/stale verdicts, revalidation with backoff and no snapshot); `local-play.test.tsx` C1-21 updated (unknown + child → `age_unverified`) and the locked start carries its reason |
| C2-10 | Launch pumps queued work and re-attaches transfers first, then starts server housekeeping in the background; each profile's scan + completion (and verdict check) runs on its own; nothing in the launch path waits for all of them (`reconcile()` itself still resolves after everything, for tests). | server-housekeeping "C2-10: a hung list of one profile never holds up another profile queued at launch" |
| C1-24 | Offline the offline shell wins over a persisted forced password change (AppLayout redirects to change-password only online; the change screen sends the active profile to `/offline` while offline, as a cold start decides before the first server check); as soon as the server answers the change screen takes over (after a playing download is released). Where the offline shell exists (iOS/Android phones, tablets, Android TV) `['account', …]` queries use `networkMode: 'online'` (pause offline, resume on reconnect, no error card); device, local-server, other-server and app-update queries and all of web/tvOS keep `'always'` (Q1-24 error card unchanged). | `screens/offline/__tests__/offline-shell-change-password.test.tsx` (cold start → shell, no `/viewer/me` in 11 min, plays, server back → change screen); `accounts/__tests__/profile-sync.test.tsx` C1-24; `query/__tests__/query-client.test.ts` (2 new). Open: the change screen can flash for up to the 4 s probe at a cold start (needs a "first probe done" flag on the monitor). |
| C1-26 | One-line comments: `blocked.ts` `allowedAgain`, `manager.ts` `remove`, `removeForSignOut`, `recheckBlocked`, `onForbidden`; no multi-line comment left in my files (engine interface is DL-N's). | — |
| checks | Positive checks promoted: `outbox-isolation.test.ts` (each owner's outbox only uses its own token), `removing-storage.test.tsx` (removing records). | |

Also: the verifier's `round2-clock` middle check (skew both ways over three offline days, missing/invalid Date) is in
`server-clock.test.ts`. Stale generated expo-router types after the merge (`/downloads` routes missing in
`.expo/types/router.d.ts`) were regenerated by a short Metro start on 8082 (stopped by PID).

Follow-up (same round): merge **e3d4628e** = fb/dl-native 5410255b (engine `clock()` 35e07e7f, D-01 256f2c51, D-02, N4).
- **Engine clock wired:** `lib/server-clock.ts` reads `downloadEngine.clock()` by default (sync, never throws;
  `setElapsedClock(null)` restores it). A `process-…` boot id (no native clock: web, tvOS, dev clients before 3b, the
  local fallback) is no boot identity, so its stamps are always estimates; this also keeps a non-sleep-inclusive
  `performance.now()` from reading a device sleep as a wall-clock step. Tests in `server-clock.test.ts` ("the engine
  clock"): default source answers `process-` in jest; real boot id on the fake engine — 30 min offline + NTP −1 h and
  +5 h → stamp exact (`advanceElapsed`); `reboot()` → estimated (offset kept, ± |offset| + 5 min) until the next answer
  re-anchors; `process-` ids → estimated across two app starts, exact under a real id. The file's other tests run on an
  explicit real boot clock.
- **Change-password flash fixed:** the monitor's snapshot has `checked` (false from `setServer` until the first probe
  answers or NetInfo reports no network). `(app)/_layout.tsx` shows the launch background (`launch-pending`) while a
  forced change waits for it, capped at `PROBE_TIMEOUT_MS + 1 s`; unreachable → offline shell, reachable → change.
  Tests: `offline-shell-change-password-launch.test.tsx` (render counter on `ChangePasswordScreen`: 0 renders while the
  first probe is out and after it fails — fails without the gate); `change-password-cold-start.test.tsx` (reachable →
  change; a probe that never answers holds the launch background no longer than its timeout).
- C2-04 `clientRef`: waits for DL-S (additive `clientRef`/`deviceId` on `DownloadResponse` and list items); the
  manager already honours it. Then: regenerate `schema.d.ts` + one crash-between-POST-and-persist adoption test.
Commits **9e60c20b** (clock) and **2df94d5a** (launch gate). Checks (Node 24.14.0): typecheck 0, lint 0 errors,
prettier clean, jest **290 suites / 2966 tests**, 0 failed.
Checks (Node 24.14.0): typecheck 0, lint 0 errors (6 old warnings in `jest/player/harness.ts`, `jest/setup.ts`),
prettier clean, jest **288 suites / 2938 tests**, 0 failed. Each new C2 test failed on the pre-fix code (outbox/intent:
5 of 6 fail on the old manager; the clock and C1-24 helpers checked theirs the same way).

## Final device pass, part 2: iPhone + Android re-check (2026-11-07)

Setup: merge ddd27fd0 (checks: typecheck 0, lint 0, jest 293/2979). Dev clients dl-native-5410255b, from the D-03 step on
**dl-native-bd8911dc** (merge 48328ce3 = fb/downloads ad8cccb8). Dev World 39300 restarted on snapshot **079de227**
(DL-S 7). iPhone Air talks to the server through my logging proxy 127.0.0.1:39302; Android via
`adb reverse tcp:39300 tcp:39302`. Screenshots `screenshots/DL-C1/final/ios-*`, `phone-19…27`, `tv-6…8`.

**iPhone Air (iOS 26.5, 5410255b)**
- **Revoked link (N2-12): found a core bug, fixed (99d4d769).** The admin's "sign out all sessions" mid-transfer:
  ECONNRESET, the engine's retry got `410` at 1,756,436, the record GET `401`, refresh `401`. The failed refresh signed
  the profile out first; `setKnownOwners` bumped the download's intent, the 401 came back stale and was dropped → the row
  stayed `downloading` on a failed task, and sign-in never resumed it (`ios-finding-revoked-stuck-after-signin.png`).
  Fix: a sign-out bump is marked; a continuation it drops parks queued/preparing/downloading as
  `waiting_server/signed_out`; pause/removal clear the mark; `resumeSignedOut` bumps what it continues. Two failing
  tests first (`transfer-intent.test.ts`, N2-12). Re-run on the device: parked with **1,657,150 B kept**, sign-in →
  GET 200 → renew 200 → `Range: bytes=1657150-`, served **14,995,501 = 16,652,651 − 1,657,150**, `restarts` 0
  (`ios-1/2`). Within the first 500 KB (cut at 299,644 served): parked, sign-in → renew → clean restart from 0
  (`range=-`), engine `restarts` 1, completed.
- **Connection drop (`direct_reset`)**, 5410255b: a reset in the **first** response (no checkpoint yet) lost the kept
  bytes: the `Range: bytes=2000000-` If-Range retry got 206 with the same ETag, the engine closed it after ~20 ms
  ("unverifiable partial response … resumed at unknown") and restarted from 0 (`restarts` 1); file correct. Twice
  (Cosmos Laundromat, Elephants Dream). Reported to DL-N → **D-03**. A reset in a later response resumed correctly.
- **D-03 re-check on bd8911dc:** the engine now ends its first response itself at the 786,432 B checkpoint
  (client-closed) and continues `Range: bytes=786432-`. That first response consumes a once-fault, so
  `afterBytes 2,000,000` never fires (2 runs, both complete, `restarts` 0). With the fault on the continuation
  (`after.bytes 1`): 206 from 786,432 reset after 2,000,000 → `Range: bytes=2786432-`, served
  **5,868,075 = 8,654,507 − 2,786,432**, `restarts` 0, sha256 `1ab41c2f…45bb` = the Dev World media file
  (`ios-11-d03-bd8911dc-reset-resumed-complete.png`).
- **Pause → force quit → relaunch → Resume:** paused at 2,250,724, still "Pausiert · 2 MB von 9 MB" after relaunch
  (`ios-3`), Resume → HEAD, `Range: bytes=2250724-`, served 6,404,770 = total − kept.
- **Offline shell → play:** proxy stopped, cold start → "Server nicht erreichbar … Hier sind deine Downloads" (`ios-4`).
  Native: offer "Fortsetzen ab 1:13" (`ios-5`), burnt-in 00:01:13 (`ios-6`). VLC (Sintel MKV/AC-3): "Fortsetzen ab
  0:50" → 00:00:51 (`ios-8a/8`); a 16.9 s position gets no offer (MIN_RESUME_SECONDS 30, by design). Queued reports:
  all `estimated: false` (engine clock: real bootId `CCD48373-…`). Reconnect → every queued report sent within 2 s,
  server `lastPlayedAt` = the stop's `occurredAt` (18:09:21.362, 18:11:53.279), queue empty (`ios-7`).
- **Sign-out with "Downloads löschen"** while Pioneer One S1E5 downloaded: profile picker after **2.3 s**; 6 DELETEs
  204 within 360 ms, then logout; server: 0 records of this device; local: 0 records, 0 tasks, 0 pending deletes, 0
  cleanup jobs (`ios-9/10`).

**Android re-check (5410255b)**
- **D-01 phone:** paused at 1,672,150 (row), `.part` 1,683,400 after `am force-stop`; relaunch → "Paused · 2 MB of 6 MB"
  (`phone-19`), Resume → `Range: bytes=1683400-`. `am stop-app` mid-transfer at 2,338,760 → "Paused · 41 %"
  (`phone-20`; a system stop reads as a pause), Resume → `Range: bytes=2338760-`.
- **D-02 phone:** downloads off → 403 at 2,735,726 + renew 403, row on hold (`phone-21`); on again → renew 200 on the next
  foreground → `Range: bytes=2735726-`, served to the end (`phone-22`). Recheck only on wake/`/viewer/me` (60 s gap),
  as designed.
- **TV (bd8911dc), D-pad:** D-01 paused at 2,018,580 (`.part` equal), force-stop → "Paused · 2 MB of 9 MB" (`tv-6`),
  Resume (D-pad) → `Range: bytes=2018580-`. D-02 → 403 at 2,589,654, on again → renew 200 → `Range: bytes=2589654-`,
  served 6,064,853 = 8,654,507 − 2,589,654, complete (`tv-7`). Note for DL-UI: after Resume the focus sits on the
  row's delete button (the action button changed under the focus).
- **Local playback with resume:** phone offline "Resume from 2:20" → 00:02:23 native (`phone-23/24/25`); TV online
  Elephants Dream (VLC) Resume → server point 1:47 → 00:01:49 → 00:01:54 (`tv-8`).

**Player finding, fixed (e359cabd, cherry-pick to fix/player-start-cover):** phone local starts at 0:00 showed
"Playback stopped. Resuming at 0:00…" for ~1 s (3 of 5). Captured: `engineEnd({position 0, engineDuration 0,
loadPosition 0, blank true, pictured false})` → empty → T8 `empty_media` → reload: expo-video's playToEnd for an emptied
Exo playlist while the new source loads. Now an `ended` counts as empty media only once the engine reported the load
ready (playing/paused, a picture or a duration); C31 "zero-length file" now scripts the real engine (readyToPlay, then
ended) and still ends in T8 + Other version; new C31 row for the artefact; player suites 66/66 (1176). Device after the
fix: 5/5 local starts at 0:00 (4 load-time `ended` with `ready: false` ignored, one after the first frame at close) and
one stream start (Big Buck Bunny, one load-time `ended` ignored): no recovery, no card (`phone-26/27`).

**Resume rules (fd5b4bfc, orchestrator decision):** local positions follow the server's rules (`resumePointOf`:
played ≥ 90 %, no resume point under 300 s or before 5 % / 2 min; also for stored records). The three settings are
admin-only (`/config/viewers/settings`), so the server defaults apply. Online, the server's `positionTicks` counts also
for a played work (re-watch). Why the server said `played: true` at ~50 %: no server bug: stored DurationTicks
1,800,000,000 (180 s) is right; Dev World runs playedPercent 90 / minResumeDurationSeconds 60, and `played` is the
sticky flag from a complete watch on 2026-11-06 23:30 (playCount 1) while the server kept a 126 s resume point that
the client's `played ? 0` dropped.

**C2-04 (51b5beae, DL-S 7 on f6cf1ba7):** a server record whose `clientRef` is a local record id and whose `deviceId`
is this installation's (trimmed, ASCII case-insensitive) is adopted (downloadId, state, size, URL; transfer started);
unsaved downloads wait at launch for the list (≤ 10 s). Another device's record is never adopted or orphan-deleted.
Tests: crash between POST and persist (1 record, no DELETE, no 2nd prepare), mixed-case/padded deviceId, other device,
list timeout, orphan scan by device id.

Checks (Node 24.14.0) on 48328ce3 (includes e359cabd, fd5b4bfc): typecheck 0, lint 0, jest **295 suites / 2998 tests**, 0 failed.

## Resume thresholds per server (DL-S 8, 2026-11-07, jest only)

Merge fb/downloads **4bd0ab74** (fast-forward; `resume: { playedPercent, minResumePercent, minResumeDurationSeconds }` on
the viewer profile, schema regenerated there). `lib/resume-rules.ts` (moved from `downloads/`) holds the rules type, the
server defaults (90 / 5 / 300) and `resumePointOf`. `AccountStore` keeps them per `serverKey` in the accounts storage
(`resume-rules`), from the sign-in answer (`addSignedIn`) and every `/viewer/me` answer (`syncProfile`: the query,
PATCH /me, email verify); an answer without the field (older server) keeps what was known, defaults apply only to a
server that never sent them. The manager reads them per record (`deps.resumeRules` → `manager.resumeRules(accountKey)`)
for the local position save and its played mark ("delete watched", "watched" label, offline up-next) and the local
resume offer (`resumeSecondsOf`). The player's own 30 s prompt margins stay the same for stream and download. Removed
the unused `PLAYED_FRACTION`. Tests (`server-resume-rules.test.tsx`): server A 60 s minimum vs B defaults (99/180 s
resumes on A only; played at A's 80 %), sign-in then an admin change on the next /me, offline cold start from storage,
older server → defaults without wiping known values; 3 of 4 fail with the manager forced to the defaults.
Checks (Node 24.14.0): typecheck 0, lint 0, jest **296 suites / 3002 tests**, 0 failed.

## Fix round 3 (client verify 3, `docs/client/journal/DL-C-verify3.md` on fb/dl-verify-client 2c0e4c67)

Merge fb/downloads 6bc32aba (fast-forward). The verifier's repros live on fb/dl-verify-client (`client/src/__verify__/`);
they were never on fb/dl-core, so there is nothing to delete here. Each one is ported to a regular test below; the
unchanged verifier files, run in a temporary copy with `DL_VERIFY_EXPECT_FIXED=1`, pass **13/13** (copy removed).

| Item | Commit | What changed | Regression tests (fail before → pass) |
|---|---|---|---|
| C3-01 intent across every await | dff49e02 | The intent token is (intent generation, profile session); each manager operation rechecks it after every await, stops and follows the newer intent. enqueue: sign-out before `engine.start` parks `waiting_server/signed_out` and starts nothing, a Pause/sign-out during the start pauses the native task once. Engine Resume: a Pause while `resume()` is pending wins, the native task is paused after. Engine events never move a record the viewer paused here or a sign-out parked (`pauseIntents`, once per intent); engine-side pauses still follow the engine. Restart: marked first (`restartReason`, persisted), each step rechecks; Pause keeps `paused` and the bytes and prepares nothing, sign-out parks, removal ends it; the next Resume / sign-in finishes it (also after a relaunch). | `transfer-intent.test.ts` "intent across every await (C3-01)": 9 tests (sign-out during space check / engine.start, removal during each enqueue await, Pause during engine resume, engine events vs a paused record, removal during resume, Pause/removal/sign-out during the restart's DELETE incl. relaunch); 6 fail on the old code, the removal ones guard regressions |
| C3-02 cleanup jobs | dff49e02 | Every job change is an upsert/delete against the stored list of that moment; `settleCleanup` re-reads its job after the volume check and never resurrects a settled one; `cleanNow` re-reads each job. Storage hook follows job changes at once. | `cleanup-jobs.test.ts` C3-02 (two failing removals keep both jobs, also after relaunch; a settled job is not brought back), `removing-storage.test.tsx` (both jobs count as used until each is deleted) |
| C3-03 age retry | fd3c9a63 | `revalidateAccess` runs once per profile; when a check stays due, one timer per profile fires at `nextAt` while attached and online. Offline (`setOnline` from the provider) no timers; reconnect and `wake()` (foreground) ask the due ones. Failures keep 60 s doubling to 1 h. | `age-verdict.test.ts` C3-03: transient failure then answer unlocks without relaunch/reconnect; offline no timer, reconnect asks; one run per profile |
| C3-04 `rating_unavailable` | fd3c9a63 | `verdictOf` keeps the reason (`meta.accessReason`) and maps every § 13 reason; `rating_unavailable` → rated false, unverified → `age_unverified` lock (existing UI), file kept; unrestricted answers count only with a known minimum age; a profile without age rules asks for nothing and is never locked, a newly restricted one asks at once. Unrateable answers are retried on the failure backoff capped at a day. | `age-verdict.test.ts` C3-04: 7 reason × 3 policy cases, verdict keeps the file and never plays, 404/503 give no verdict, unrestricted → restricted; daily cap test |
| C3-05 local start/seek landing | 934a0489 | Pending local landing (target + seek generation), symmetric ±3 s like StartSeek; set by a start above 0 and every explicit seek. Until it lands: no progress/start/stop report, no position save, the target is the shown/resume position; explicitStart allows backward progress only after landing. Streaming code paths and engine start covers unchanged (all new branches behind `options.local`; expo-video's one-sided uncover after a given-up start is the c4a64a64 late-landing fix) → no cherry-pick. | `local-mode.test.ts` "local start and seek landing (C3-05)", native + VLC: stale 400 before a resume to 100 lands, transient 0 before a seek to 50 lands, landed seek also backwards, From the beginning saves 0, seek back to 0; 4 fail on the old code |

Checks (Node 24.14.0) on 934a0489: typecheck 0, lint 0 problems, jest **296 suites / 3037 tests**, 0 failed.

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

### Phase B — Android phone (emulator-5554), after fix round 1 (Metro 8082 on the fixed code)
- Local playback online, native: Big Buck Bunny from the library → `isLocal`, `expo-video`, `file:///data/data/
  dev.streamarr.app/files/downloads/…/Big.Buck.Bunny…mp4`, playback id `local-…`; engine menu → VLC continued at the same
  position (C1-14 path); progress reached the server (75.0 s, `lastPlayedAt` set). `phone-local-play-native.png`.
- Server down (Dev World process stopped; network up): the next failing requests probed and the offline shell opened in
  ~12 s — "Server not reachable · Streamarr Dev World does not answer right now", Try again, the profile's downloads with
  local positions, on-device settings. `phone-offline-server-unreachable.png`. (Removing only the adb reverse rule was not
  enough: OkHttp keep-alive connections survive it.)
- Offline playback with VLC: Elephants Dream MISLABEL (MKV/DTS, saved engine `vlc`) played from the offline shell; local
  position 105.5 s, 3 reports queued. `phone-offline-play-vlc.png`.
- No network (airplane mode): banner "No network · This device is offline", "Watch progress is synced as soon as the server
  is reachable again". `phone-offline-no-network.png`.
- Return: airplane off + Dev World restarted (`DEVWORLD_KEEP_DATA=1`, records kept) → Home again 5 s after the server
  answered; server watch state for tmdb-movie-9761: position 105.489 s, **`lastPlayedAt` 22:31:23Z = when the stop
  happened offline** (sync ran 22:32:3x) → `occurredAt` landed. `phone-back-online-home.png`,
  `phone-home-offline-progress-synced.png`.
- Season with the RAR pack (Pioneer One S01E02–E06, release RARPACK, one RAR set per episode) + E01 single: all 6
  episodes done (23 MB). **Bug found + fixed (6fa75ef7):** a preparation that ended in the long-poll never pumped the
  queue — E04–E06 stayed queued until the next wake (the server prepares one at a time). `phone-season-rar-pack-done.png`.
- 429 path: Dev World fault `direct_status 429, Retry-After 60` → Sintel German DL `waiting_server` /
  `too_many_downloads` / retry 60 s later; library "Waiting for the server · next try 11:38 PM · 0 MB of 17 MB" + reason;
  fault cleared → finished by itself after the retry time. `phone-429-waiting-server.png`.
- Network handover (Wi-Fi took over from cellular after airplane mode): NetInfo reported "no network" for a moment and the
  app flashed into the offline shell. **Fixed (7053e0bb):** a loss counts after 3 s.
- Local audio switch (Sintel, VLC, AC-3 de 5.1 + en 2.0): `selectAudio(en)` → engine track 1 selected, `currentAudio()`
  2. Resume question for a download: "Resume from 0:50"/"1:07" (newest of local/server) — `chooseStart(true)` started VLC
  at 67.1 s. **Open:** two taps on the card's Resume in landscape started at 0 while the controller call resumes; taps on
  the landscape overlay (close) did not land either → looks like landscape tap mapping of the tooling; DL-Q to recheck by
  hand. `phone-local-resume-question.png`.
- Slow VLC start of a download showed "Lower quality". **Fixed (afb3c335):** a download's hints drop server-only actions.
- Wi-Fi only on cellular (`svc wifi disable`, mobile data on): Sprite Fright → `waiting_wifi`, 0 B
  (`phone-waiting-wifi.png`); Wi-Fi only off → finished over cellular (8.6 MB); setting restored.
- Sign-out prompt: Settings → Sign out → "Keep the downloads of Anna? 10 downloads (79 MB) …" Keep / Delete / Cancel
  (`phone-sign-out-downloads-prompt.png`) → Keep → profile picker "Signed out" → signed in again → all 10 downloads
  visible for Anna.
- Deep links into the dev client are dropped on a cold start (warm ones work) — dev-client behaviour, not DL.

### Phase B — Google TV 13 (emulator-5558, API 33, FGS path), everything by D-pad
- Download + process kill mid-download → relaunch: the library re-attached and finished (`tv-library-after-crash.png`:
  Pioneer One S1E1, Big Buck Bunny, Elephants Dream; row actions reachable left/right).
- Local playback online, native: Big Buck Bunny resumed at 1:32 from the downloaded MP4 (`tv-local-play-native-resumed.png`).
- Server stopped → offline shell "Server not reachable" with remote focus on Try again (`tv-offline-server-unreachable.png`;
  the first pass opened without focus → fixed in 495eb14d), also on a cold start (`tv-cold-start-offline-focus.png`).
- Offline playback with VLC: Elephants Dream MISLABEL (MKV/DTS, saved engine `vlc`) (`tv-offline-play-vlc.png`). Second
  run after 465adf63: the Continue-watching card started the download while the server was down (`isLocal`, `vlc`,
  `file://…`, 147 s) and kept playing; Back → offline shell with "Watch progress is synced…" and 3 queued reports
  (`tv-offline-after-local-play.png`).
- **Bug found + fixed (465adf63):** the TV emulator's clock runs ~1 h behind (device UTC 22:13 vs real 23:12). Its first
  offline report reached the server with `occurredAt` 21:58Z, older than the phone's 22:31Z, and was rightly ignored by
  the newer-wins rule. Now the device's skew comes from every answer's `Date` header (persisted for offline cold starts,
  < 5 s ignored) and queued reports + local positions are stamped on the server clock. Proof: device 22:18Z, `serverNow`
  23:16:58Z; after the Dev World came back the TV returned to Home on its own (32 s) and the server holds Elephants Dream
  **150.546 s, `lastPlayedAt` 23:16:44.298Z** = the real stop time (`tv-back-online-synced.png`).
- Sign-out by D-pad: Settings → Sign out (confirm opens on Cancel) → "Keep the downloads of Anna? 3 downloads (35 MB)"
  with focus on Keep; down → Delete → Cancel; Cancel keeps Anna signed in and returns focus to Sign out
  (`tv-sign-out-downloads-prompt.png`).
- **Not producible here:** "no network". The TV image's uplink is Ethernet; airplane mode leaves it up (the app rightly
  stays online), the image is a user build (no root, no `cmd ethernet`). The no-network banner is proven on the phone
  (same JS path).

### Phase B — iPhone Air simulator (iOS 26.5, German UI)
- Downloads with the throttle fault: Elephants Dream (VLC) and Tears of Steel (native) (`ios-library-de-done.png`); app
  terminated mid-download → relaunch: Elephants Dream continued at 16 of 22 MB, 0.2 MB/s (`ios-library-de-after-terminate.png`).
- Offline cold start with the server stopped: "Server nicht erreichbar", downloads, settings on this device
  (`ios-offline-cold-start-de.png`). Found: a title whose single query failed showed its own card instead of the shell →
  fixed in 2f206c08 (the first transport/5xx failure runs the probe).
- **Bug found + fixed (0f8f1829): the app crashed playing a downloaded MP4 on AVPlayer** ~3 s in, when the controls hid
  (two reports, 00:08:39 and 00:19:21: `EXC_BAD_ACCESS` at 0x0 on the CoreMedia queue, `itemfig_setTextMarkupArray` →
  `CFArrayGetCount(NULL)`). The patched expo-video (`VideoPlayerSubtitleLift.swift`) sets `item.textStyleRules = nil`
  when the subtitle lift goes back to 0; AVFoundation crashes on that for a file item, a streamed item survives it
  (verified: Big Buck Bunny streamed past the hide without a crash). File sources on iOS get no lift now. After the fix:
  Tears of Steel played locally (`isLocal`, `expo-video`, `file://…DEVWORLD.mp4`) through the hide to the end card, no
  crash (`ios-local-play-native-after-fix.png`); no Version/Quality chips for a download.
- Offline (server stopped) → shell (`ios-offline-server-unreachable-de.png`) → Sintel German DL (saved engine VLC, AC-3
  de 5.1 + en 2.0, ASS subtitles listed for VLC) played offline with VLCKit; local audio switch en → de: engine track
  "Deutsch AC3 5.1" selected, playback continued. 5 reports queued (Tears of Steel reached its end offline → `played`).
- Server back → Home after 9 s (`ios-back-online-de.png`), queue empty; server: Sintel **19.773 s, `lastPlayedAt`
  23:31:26.556Z** (the offline stop), Tears of Steel `played`, playCount 1, 23:30:53Z.
- Sign-out prompt: Abmelden → "Downloads von Anna behalten? 3 Downloads (45 MB) …" Behalten / Löschen / Abbrechen
  (`ios-sign-out-downloads-prompt-de.png`); Abbrechen keeps Anna signed in.
- Tooling note: in the landscape player, taps near the close button land on the dev client's floating Tools button
  (it overlaps the close button); the player was left via the router in those runs. Same as the phone's landscape note.

### Phase B — bugs found and fixed (all with regression tests)
| Bug | Device | Commit |
|---|---|---|
| A preparation finished inside the long-poll did not pump the queue (season pack E04–E06 stuck in `queued`) | phone | 6fa75ef7 |
| Wi-Fi ↔ cellular handover flashed the offline shell | phone | 7053e0bb |
| A download's slow VLC start offered "Lower quality" (server-only action) | phone | afb3c335 |
| Offline shell opened without remote focus | Google TV | 495eb14d |
| A single failed query never opened the offline shell | iPhone | 2f206c08 |
| Offline progress lost to a device clock running behind (TV boxes without NTP) | Google TV | 465adf63 |
| App crash: downloaded MP4 on AVPlayer when the controls hide (nil text style rules) | iPhone | 0f8f1829 |

### Checks at the end of phase B (Node 24.14.0, head after 0f8f1829)
- `npm run typecheck` exit 0; `npm run lint` exit 0; `npx jest -w 4`: **261 suites, 2584/2584 passed**.

### Phase B — not re-run per device (same JS path, proven on the phone)
- 429/Retry-After → `waiting_server` with the retry time, Wi-Fi only on cellular (phone only by the brief), the RAR
  season pack, sign-out with *Keep* + sign-in again. TV and iPhone ran the prompt itself and cancelled.

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

All three answered in DL-N's interface changes after the freeze (`retryAfterMs`, shared HTTP policy, backup exclusion of
the root + recursive `deletePath`, verified by DL-N on phone + iPhone). New, for the owner of the expo-video patch (native
rebuild, not this lane): in `ios/VideoPlayerSubtitleLift.swift` assign `[]` (or skip the assignment) instead of
`textStyleRules = nil` — iOS 26.5 crashes on nil for file items (0f8f1829 only works around it in JS). **Done** by DL-N in
a36493d1 (`[]` instead of nil); the JS guard stays (orchestrator: tx3g cues do not move with the lift, and it protects
binaries with the old patch).

Original requests:

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

- Re-evaluate the lift for local files on a real iPhone (tx3g); until then the JS guard (0f8f1829, no lift for
  `file://` on iOS) stays, as decided after DL-N's native fix a36493d1.
- **DL-Q:** "no network" on an Ethernet TV box by hand (unplug); landscape player taps by hand (tooling overlap).
- **Shared Metro ports:** other lanes' simulators ("DL-C2 iPhone", "iPhone SE DE test") were attached to this lane's
  Metro 8082 during phase B (reported to the orchestrator).
- **DL-C2:** the Downloads tab/rail screen wraps `DownloadsLibrary` (`header` prop for its title/badge); the detail page
  starts a downloaded work with `playHref({ workId, title })` without `releaseId` (the player then plays the file; an
  explicit other `releaseId` streams); the Settings "Downloads" section should also be added to `OfflineScreen`
  (`offline-settings` section, today Language + Performance).
- **Jest:** expo-router's test store does not survive a second render in the same file after a test navigated away from
  `/offline` — offline shell scenarios live one per file.
- **Streamybox:** local files never go to Streamybox (DL-N note); a `content://`/fd contract v2 would be a Streamybox
  follow-up.
- **Server stubs:** until DL-S implements the endpoints the manager shows `server_unsupported` (HTTP 501).
