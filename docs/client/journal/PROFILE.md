# PROFILE — selectable ranking profile (server default, per-viewer choice)

Status: done

Intent: user request "Es muss irgendwo möglich sein, das Bewertungsmaßstab-Profil einzustellen, das genutzt wird. Am
besten Standard im Web-Dashboard und dann kann es auch in der App geändert werden." Branch `feat/watchlist-diagnostics`
(worktree `streamarr-worktrees/watchlist-diagnostics`). Before: every viewer path ranked with `DefaultProfiles.Standard`
(`ViewerAudioLanguages.Profile`, `profiles.Get(null)`, `GetSeasonReleasesAsync(profileId: null)`), the plugin/admin
search without `profileId` too.

## Decisions

- **Per account, not per device.** The choice lives on `ViewerEntity.RankingProfileId`. "Bewertungsprofil" is a taste of
  the person (4K/HDR vs. bandwidth), it should follow them from TV to phone to web, and the server-side consumers that
  have no device at hand (next-episode pre-download, My List monitor) can only read an account setting. Device limits
  (a phone on mobile data) are already handled per device by the capability overrides (`maxBitrateKbps`, height) and the
  device order, which still applies on top of any profile.
- **Per media type: yes.** Profiles already carry `appliesTo` (`movies`/`shows`/`both`) and Sonarr/Radarr imports are
  naturally one-sided, so the server has a general default plus optional movie and series overrides. Resolution per
  media type: override → general default → Standard, each step only when the profile exists and applies (a shows-only
  general default ranks series, movies fall to Standard). A viewer's shows-only choice ranks series; movies use the
  server's movie default.
- **One resolver**: `RankingProfileResolver` (`server/src/Streamarr.Server/Config/RankingProfileResolver.cs`): viewer
  choice (only while "viewers may choose" is on, the profile exists and applies) → server default for the media type →
  Standard. `ProfileConfigService.Get(null|unknown|mismatch)` now also falls to the server default, so the plugin
  (empty `ProfileId`), `/search`, `/tv/...` and `/debug/search` without a profile follow the server default.
- **Re-rank instead of re-search.** Version lists stay cached per movie/season (profile-agnostic key), searched once
  with the server default (`DraftProfile`) and *including rejected releases* (flagged). `ViewerCatalogService.Rank`
  uses the cached score when the list was ranked with exactly the viewer's profile + revision (`ResolvedProfile.Key` =
  `id@revision`), otherwise re-evaluates every release with `ReleaseEvaluator` (score **and** rejections) at the
  runtime the aggregator used. So a profile switch, a default change or a profile edit is visible on the next request,
  costs no indexer search, and profile-specific rejections (minimum custom-format score, size bands) apply per viewer.
  Considered keying the cache by profile (simpler, but N profiles = N indexer fan-outs per title and the 60 s
  `SearchCache` rarely covers it) and re-scoring only (ignores rejections) — both rejected.
- "Viewers may choose" off: everyone ranks with the server default; stored choices are kept and apply again when it is
  turned on (PUT answers `403 profile_choice_disabled`).
- Delete: `ProfileConfigService.DeleteAsync` clears the id from the defaults and from every viewer in the same save; the
  resolver also tolerates dangling ids (falls to the next step), so no 500s.
- Viewer list shows derived **traits** only (preferred/max resolution, HDR prefer/avoid from custom-format *names*, codec,
  3 languages, `savesBandwidth` = no 2160p) plus an optional operator `description` (new `QualityProfile.Description`,
  ≤ 200 chars, editable in the web editor). Never weights, group lists, custom formats, import source.
- Picture-on-device bonus and graded series affinity (VERSIONS) are unchanged and now use the resolved profile:
  `ViewerPicturePreference.Adjustment(ranking.Profile, …)` (a profile without 2160p gives 4K no bonus, so a
  bandwidth profile recommends 1080p even on a 4K HDR TV) and the affinity language points of the resolved profile.
- Web admin stays English-only like the rest of `web/` (no i18n framework there; same decision as DIAG). Client en+de.
- Client entry is a Settings section with a picker `Sheet` (existing radio-sheet pattern: TV focus, Back, phone bottom
  sheet) rather than a new screen.

## Every path now on the resolver (line numbers of the final tree)

- Versions list / Versions sheet / detail Play chips: `ViewerCatalogService.MapVersions` → `rankingProfiles.ForViewer`
  `Viewers/Catalog/ViewerCatalogService.cs:510`, re-rank `Rank` `:538-558`, picture bonus `:528`, affinity `:515`.
- Recommendation + playback auto-pick (plain Play) + playing version: `RecommendedAsync` `:448` / `VersionAsync` `:459`
  (both via `MapVersions`), called from `Viewers/Playback/ViewerPlaybackService.cs:514, 523, 565`.
- Season version counts: `ViewerCatalogService.cs:279, 329`.
- Next-episode "available" on series detail and My List: `ViewerCatalogService.Available` `:567-570` (used at `:208` and
  `Viewers/MyList/MyListService.cs:303`).
- Canonical (server default) search for the cache: movies `:691`, seasons `:725`.
- Pre-download next-episode pick: `Services/PreDownloadCoordinator.cs:409` (`ForRequesterAsync`: app viewer → own
  choice, Jellyfin/admin → server default) → `NextEpisodeResolver.ResolveAsync(profile)` ranks the season with it and
  orders candidates by that search's scores `Services/NextEpisodeResolver.cs:98`.
- My List monitor "usable release exists": per viewer `Viewers/MyList/MyListMonitor.cs:172` (choices loaded with the
  entries), check `:173, :249` → `Available` `:350-351` (cached season list re-ranked for the waiter's profile; spec store
  only for server-default waiters).
- Jellyfin plugin / admin search: `Services/SearchService.cs:103` → `ProfileConfigService.Get` `Config/ProfileConfigService.cs:42`
  (absent/unknown/mismatched id → server default). The plugin itself is unchanged (no logic in the plugin).

## Caches

- `ViewerVersionCache` (movies/seasons): key unchanged; lists carry `RankedWith` + `RankRuntime` and are re-evaluated
  when the viewer's `ResolvedProfile.Key` differs (profile revision bumps on every profile CRUD or defaults change).
- `CatalogSpecStore` (card spec + availability): profile-agnostic by design, recorded from the server-default lists only
  (best spec skips rejected releases); refreshed on the next lookup after a default change — cards show "the best
  existing version" for the server, not per viewer.
- Season release overlay (`TvCatalogService`): no own cache; the indexer `SearchCache` holds raw results only.
- Pre-download jobs: decided at trigger time with the requester's profile; no stale decision cache.
- Client React Query: choosing invalidates `catalog/versions`, `catalog/series` (seasons incl. availability, detail next
  episode) and `watch/list` (My List).

## Endpoints

- Admin `GET/PUT /api/v1/config/profile-defaults` (`defaultProfileId`, `movieProfileId`, `seriesProfileId`,
  `viewersMayChoose`, `effective.movie/series`); `400 unknown_profile`, `400 profile_media_type_mismatch`.
- Viewer `GET/PUT /api/v1/viewer/me/ranking-profile` (`profileId`, `canChoose`, `movie`, `series`, `serverDefault`,
  `profiles[]` with `traits`); `403 profile_choice_disabled`, `400 unknown_profile`.
- EF migration `20261024103120_ProfileDefaults` (GeneralConfig: DefaultProfileId, MovieProfileId, SeriesProfileId,
  ViewersMayChooseProfile default true; Viewers: RankingProfileId). Defaults keep Standard → no change for existing installs.

## Files

Server: `Config/{ProfileConfigService,RankingProfileResolver,RankingProfileTraits}.cs`, `Contracts/RankingProfileContracts.cs`,
`Controllers/{ProfileDefaultsController,ProfilesController}.cs`, entities + migration, `Services/{TvCatalogService,
NextEpisodeResolver,PreDownloadCoordinator}.cs`, `Viewers/Catalog/{ViewerCatalogService,ViewerAudioLanguages}.cs`,
`Viewers/MyList/{MyListMonitor,MyListService}.cs`, `Viewers/{ViewerRankingProfileService,ViewersServiceCollectionExtensions}.cs`,
`Viewers/Controllers/ViewerMeController.cs`, Core `QualityProfile.Description`; `openapi/v1.json`;
tests `Viewers/RankingProfileTests.cs`.
Web: `pages/profile-defaults.tsx` (+ test), `pages/profiles.tsx`, `api/{queries,types,schema.d}.ts`.
Client: `screens/settings/ranking-profile.tsx` (+ test), `settings-screen.tsx`, `components/icons.ts`, locales en/de,
`api/schema.d.ts`. Docs: `api.md`, `configuration.md`, `viewers.md`, `ranker-tuning.md`.

## Verification

- Server: `RankingProfileTests` 10/10 (fresh install = Standard; viewer switch re-ranks the cached list with **no extra
  indexer search** + plain-Play recommendation follows; server default ranks followers, a profile edit is live; per media
  type incl. `profile_media_type_mismatch`/`unknown_profile`; resolver precedence + revision key; choice disabled →
  403, stored choice ignored then restored; delete of default + viewer choice → Standard, no dangling ids in DB; redaction
  (no group names, custom-format names, import source, weights); per-profile rejections hide releases and decide
  `EpisodeAvailable`; pre-download pick follows the requester's profile (WEB-DL single vs BluRay pack)).
  Full `dotnet test Streamarr.sln`: Usenet 247/247, Core 512/512, DevWorld 92/92, Server 1647/1660 — the 13 failures
  are the known Remux/Transcoding integration tests on local ffmpeg 9.0.1.
- Web: `tsc -b` clean, vitest 37 files / 268 tests (new `profile-defaults.test.tsx` 4), `npm run build` ok.
- Client: `tsc --noEmit`, `expo lint`, prettier clean; jest 195 suites / 2197 tests, 2 failures = the known
  `tab-guard.test.tsx` ones (new `ranking-profile.test.tsx` 4).
- Live (Dev World 39340 `--tree`, Expo web 39341, web admin via Vite 39342 proxy; Chromium de-DE with an init script that
  reports a 4K HDR10 screen and every decoder; profiles "Spart Bandbreite" [1080p, 720p], "4K HDR Kino", "Serien kompakt"
  [shows] created through the admin API). Sherlock S2E1: Standard recommends the 4K HDR10 pack (Direkt-Stream 4K HDR10
  chips on the detail), after choosing "Spart Bandbreite" the 1080p WEB-DL pack is recommended, the header adds
  "Empfohlen 1080p · SDR", the detail chips switch to 1080p — without reload or restart. Stack stopped afterwards.
- Screenshots `docs/client/screenshots/PROFILE/`: `web-admin-defaults-light.png`, `web-admin-defaults-dark.png`,
  `web-admin-defaults-series-override-light.png` (Movies default / Series default badges), `tv-1920-settings-entry-de.png`,
  `tv-1920-picker-de.png`, `tv-1920-settings-chosen-de.png`, `tv-1920-before-standard-detail.png`,
  `tv-1920-before-standard-versions-sheet.png`, `tv-1920-after-spart-bandbreite-detail.png`,
  `tv-1920-after-spart-bandbreite-versions-sheet.png`, `tv-1920-settings-locked-de.png`, `phone-390-settings-entry-de.png`,
  `phone-390-picker-de.png`, `phone-390-settings-locked-de.png`. "TV 1920" = the large shell in Expo web at 1920×1080
  (as STATUS/VERSIONS); no Google TV emulator run.

## Open / limitations

- Resolve auto-fallback after a dead release (`ResolveService` → `IReleaseStore.FindFallback`) still orders by the score
  of the release's last registration (normally the server-default list), not the viewer's profile; the fallback chain is
  generic (admin, Jellyfin, viewer) and the store is not per profile.
- `CatalogSpecStore` card specs are the server default's view (see Caches).
- The admin cannot see/set a viewer's choice in the Viewers page (viewer-owned setting; resolved via the API).
- Real TV (D-pad focus inside the sheet on Google TV/Apple TV) not run; the Sheet is the existing TV-tested component.
- Plugin config page label still says "Quality profile id (optional)"; empty now means "server default" (documented
  in api.md; plugin untouched).
