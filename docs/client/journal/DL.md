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
