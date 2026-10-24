# VERSIONS — version picker: 1080p recommended over 4K, duplicate packs, affinity, device summary

Status: done

Intent: user report (Google TV photos `screenshots/VERSIONS/user/`, Cyberpunk: Edgerunners S2E2): the picker recommends a
1080p pack although 4K HDR10 plays directly, lists both season packs twice (one copy "Wird vorbereitet"), ignores the
series' release affinity and says "Auf diesem Gerät 1080p · SDR". Branch `fix/versions-recommendation` (from 0.18.0).

## Root causes (line numbers of origin/main)

1. **1080p recommended.** The viewer list ranks by the operator profile's ranker score. `DefaultProfiles.Standard`
   (`server/src/Streamarr.Core/Profiles/DefaultProfiles.cs:21`) prefers `1080p` over `2160p` (100 vs 75 points), HDR
   scores nothing, and `ViewerCatalogService.DeviceOrder` (`ViewerCatalogService.cs:531-532`) only *subtracts* play
   penalties — nothing rewards the picture the device can show. The user's names score 274 (1080p H.264 pack) vs 267
   (2160p HEVC HDR pack) with German as viewer language (measured with `WeightedSumRanker`). The client does not
   re-sort: it shows the server order and Play sends no `releaseId` (server `RecommendedAsync`), so the app started
   the 1080p too. Bandwidth played no role: the 4K cards said "direct", and no measured bandwidth feeds the ranking
   (only the manual `maxBitrateKbps` capability override; the speed test on `feat/diag-speedtest` is diagnostics only).
2. **Duplicates.** The indexer fan-out dedupes by normalized title + *exact* byte size
   (`IndexerSearchService.cs:250`); the same NZB on two indexers (or a repost) differs by a few bytes, so both
   survive with different `releaseId`s, and the season overlay/merge dedupes only by `releaseId`
   (`TvCatalogService.cs:147, 289, 301`). The "Wird vorbereitet" copy: the pre-download's next-episode pick
   (`NextEpisodeResolver.SelectRelease`, `NextEpisodeResolver.cs:132-135`) breaks the 100 % similarity tie by score,
   then release id — i.e. it can download the *other* indexer's copy, which the list then shows as a separate entry.
   Reproduced in Dev World: E1 played with copy 24ef…, pre-download chose 13f0….
3. **Affinity "ignored".** It was applied, but flat: `ViewerReleaseAffinity.Points` (`ViewerReleaseAffinity.cs:30-31`)
   gives +40 to every release ≥ 75 % similar. The same group's 1080p pack is 76.67 % similar to the 4K pack the user
   watched (group 40/40, tokens 16.7/25, quality 10/25, language 10/10), so the 1080p pack, the 1080p single episode
   and both 4K copies all got +40 and the profile's 1080p preference decided again.
4. **"Auf diesem Gerät 1080p · SDR".** Not a capability probe: `sheetSpecs` (`client/src/browse/version-format.ts:336-344`)
   prints `deviceOutput(playedHere(versions))` — what the *recommended* version shows. With the 1080p recommendation it
   said 1080p · SDR while the 4K HDR10 cards said "direct". media-caps reads decoder heights (not the display mode) and
   the per-mode HDR types; the TV's own profile was right (4K HDR10 direct).

No unmerged fix exists on `feat/rock4d-*`/`fix/rock4d-*` (all merged into origin/main, none touch this ranking).

## Changes

Server
- `ViewerPicturePreference` (new): with a device profile, a version that plays without a transcode gets half the
  profile's resolution weight per resolution step the device really shows above the profile's preferred one
  (Standard: 4K +50) and +15 for HDR the screen shows. Transcodes keep the profile order (the engine-hint test caught a
  first draft that let a 4K transcode beat a 1080p VLC play).
- `ViewerReleaseAffinity`: graded — same release apart from episode numbering +40 (another pack copy, next episode),
  same group + same resolution/HDR +30, same group other resolution +15. `VersionDto.affinity` marks ≥ +30.
- `ViewerCatalogService.MergeCopies`: one entry per release name within 2 % size; keeps the downloaded copy, else this
  work's last played copy, else the downloading one, else the healthiest; score of the best copy; `qualityRank`
  renumbered; `VersionAsync` maps a hidden copy to its listed version (player rank).
- `NextEpisodeResolver.SelectRelease(sourceReleaseId)`: a pack continues with the copy that is playing.
- `WeightedSumRanker.ResolutionPoints` exposed; OpenAPI (`affinity`), web + client schema regenerated; docs/api.md,
  docs/viewers.md.
Client
- `sheetSpecs`: "Auf diesem Gerät" = best picture the device shows of any version (no-transcode first, then transcode;
  without predictions the recommended one as before); a third pair "Empfohlen <picture> – sofort startklar / wie zuletzt
  gesehen" when Play starts less; a bandwidth note when the sharper versions hit `bitrate_exceeds_limit`.
- Version card pill "Wie zuletzt" for `affinity`.
Dev World
- `ReleaseEntry.mirrors` (extra indexer copies: another guid, +0.2 % size, same NZB); season packs may bring their own
  media; Sherlock S2 gets a 1080p and a 4K HDR10 German.DL pack of group `snk` (each mirrored once), an S02E02 `snk`
  single and the variant `mkv-hevc-hdr10-dualaudio-2160p` (3 × 60 s, payload 466 MiB).

## Verification

- Repro (Dev World 39330 `--tree`, Expo web 39331, Chromium 1920×1080 de-DE with an init script that reports a 4K HDR10
  screen; E1 watched past half with the 4K pack via `/viewer/playback` + progress): before = user's order (1080p pack ×2,
  1080p single, 4K ×2; header 1080p · SDR) `screenshots/VERSIONS/web-before-sheet.jpg`, `web-before-sheet-scrolled.jpg`,
  `web-before-detail-e2.jpg`; after = 4K HDR10 pack once, Empfohlen + Wie zuletzt, header 4K · HDR10, 5 versions
  `web-after-sheet.jpg`, `web-after-detail-e2.jpg`; with pre-download on: merged copy "Sofort" (the pre-download used the
  playing copy) `web-after-sheet-predownloaded.jpg`. A stalled pre-download ("Wird vorbereitet") could not be held in
  Dev World (small files are read during E1's resolve); covered by `MergeCopies` unit tests.
- Server: RecommendedVersionTests/ViewerVersionRankingTests/NextEpisodeReleaseSelectionTests new cases; Viewers 720/720;
  full `dotnet test Streamarr.sln`: Core 505/505, Usenet 247/247, DevWorld 92/92 (new mirror test), Server 1570/1583 —
  the 13 failures are the known Remux/TranscodingIntegrationTests on local ffmpeg 9.0.1. Client: tsc, expo lint,
  prettier clean; jest 2134/2136 (the 2 known tab-guard failures). Web `tsc -b` clean after schema regeneration.

## Open / real TV only

- The Google TV itself: that the TV's profile still predicts 4K HDR10 direct (it did in the photos) and the Play button
  starts the 4K pack; the "Wird vorbereitet" merge with a real slow pre-download.
- Core indexer dedupe still uses the exact size (admin search keeps listing both copies); only the viewer list merges.
