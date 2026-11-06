# DL-S — offline downloads, server

Status: in-progress

Branch `fb/dl-server` (worktree `../streamarr-worktrees/dl-server`, off `fb/downloads` be6f1978). Spec: PLAN.md § "DL —
offline downloads", `downloads-plan.html` § 6. Dev World for self-tests: 39310.

## Intent

Viewer API `/api/v1/viewer/downloads` (candidates, season candidates, similarity plan, async prepare with a hard
direct-play check, list/renew/complete/delete), a long-lived resumable file capability `/api/v1/offline/{capability}`,
persisted `ViewerDownloads`, `allowDownloads` + limits, download priority below live streams, `occurredAt` on watch
progress, web admin, Dev World fixtures, OpenAPI, docs, tests. Slice 1 freezes the contract.

## Decisions

- **Candidates are POST** (`/candidates`, `/candidates/season`) with a body `{ workId, device: DeviceProfileDto, … }`:
  the full engine profile (per-codec limits, subtitle formats, VLC caps) does not fit a query string. Read-only, no
  state change; documented as such.
- **Offline playability** = the playback decider (`PlaybackDecider.Decide`, the same as a start) restricted to direct
  candidates: native direct, else VLC direct; never remux/transcode. Bandwidth caps and `maxHeight` preferences are
  ignored (nothing is streamed live). Reason codes are the decider's skipped-direct reasons (i18n like
  `predictionReasons`) plus the predictor's assumption notes.
- **Order** = the versions list's `MapVersions` + `MergeCopies` + `DeviceOrder`, with the play class replaced by the
  offline class (direct / vlc / unplayable), so downloadable first, same score/affinity/penalty rules.
- **Size**: `sizeSource` `resolved` (exact, from a stream session or the resolved-file store of an earlier resolve of
  this release + work), `indexer` (the release's indexer size: an upper bound incl. PAR2/NFO, not exact), `estimate`
  (pack size ÷ episodes it covers). `sizeExact` is true only for `resolved` (deviation from the brief, which called a
  single-file release exact: the indexer size includes recovery data, 5–15 %).
- **File endpoint outside `/viewer`**: `GET|HEAD /api/v1/offline/{capability}` — anonymous like `/stream`, the capability
  is the credential, so it cannot carry the viewer gate's 401 (contract test: every `/viewer/*` op declares 401).
- **Pack coverage** comes from the season fan-out itself: a release id listed under several episodes of the cached
  season list covers exactly those episodes (full and partial packs, no extra parsing).
- Download stream sessions use their own client label `streamarr-download`, so a playback of another release never
  supersedes them and they never show as a server pre-download (`local`).

## Contract frozen

(pending)

## Contract changes after freeze

(none yet)

## Log

- 2026-11-06: read PLAN/downloads plan/BRIEF/architecture/viewers/api; explored catalog, predictor, decider, playback
  service, sessions, resolve, materializer, NNTP gates, segment cache, test hosts.
