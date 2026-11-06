using Streamarr.Core.Parser;
using Streamarr.Core.Media;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Watch;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>Device-download candidates: the versions list (same cache, ranking, affinity and copy merge) ordered by offline playability.</summary>
public sealed partial class ViewerCatalogService
{
    public const string SizeResolved = "resolved";
    public const string SizeIndexer = "indexer";
    public const string SizeEstimate = "estimate";

    public async Task<DownloadCandidatesResponse> DownloadCandidatesAsync(
        ViewerEntity viewer, WorkKey key, PlayContext play, IReadOnlyList<string>? languages, bool refresh, CancellationToken ct)
    {
        var work = await WorkReleasesAsync(viewer, key, refresh, cachedOnly: false, ct)
                   ?? throw new InvalidOperationException("A searched version list is never a cache miss.");
        var candidates = await DownloadListAsync(viewer, key, work, play, languages, anchorTitle: null, ct);
        return new DownloadCandidatesResponse
        {
            WorkId = key.WorkId,
            MediaType = MediaTypeOf(key),
            Candidates = candidates,
            StreamOnlyCount = candidates.Count(c => !c.Offline.Playable),
            CheckedAt = work.CheckedAt,
            FromCache = work.FromCache,
            Incomplete = work.Incomplete,
        };
    }

    public async Task<DownloadSeasonCandidatesResponse> DownloadSeasonAsync(
        ViewerEntity viewer, int tmdbId, int seasonNumber, PlayContext play, IReadOnlyList<string>? languages, bool refresh, bool includeEpisodes,
        CancellationToken ct)
    {
        var seriesTask = TmdbAsync(() => _tmdb.GetTvSeriesCatalogAsync(tmdbId, ct));
        var seasonTask = TmdbAsync(() => _tmdb.GetTvSeasonCatalogAsync(tmdbId, seasonNumber, ct));
        var catalog = await seriesTask ?? throw TitleNotFound();
        var seasonCatalog = await seasonTask ?? throw ViewerProblem.NotFound("season_not_found", "The season was not found.");
        var seriesWorkId = TvCatalogService.SeriesWorkId(tmdbId);
        Gate(viewer, seriesWorkId, catalog.Series.OfficialRating);

        var lookup = await SeasonVersionsAsync(tmdbId, seasonNumber, refresh, ct);
        var season = lookup.Value;
        var today = DateOnly.FromDateTime(time.GetUtcNow().UtcDateTime);
        var aired = seasonCatalog.Episodes.Where(e => NextUpService.HasAired(e.AirDate, today)).Select(e => e.EpisodeNumber).ToHashSet();
        var coverage = Coverage(season);

        var episodes = new List<DownloadSeasonEpisodeDto>();
        foreach (var episode in seasonCatalog.Episodes.OrderBy(e => e.EpisodeNumber))
        {
            var key = WorkKey.ForEpisode(tmdbId, seasonNumber, episode.EpisodeNumber);
            IReadOnlyList<DownloadCandidateDto> candidates = [];
            if (includeEpisodes && aired.Contains(episode.EpisodeNumber) && season.Episodes.ContainsKey(episode.EpisodeNumber))
                candidates = await DownloadListAsync(viewer, key, EpisodeWork(season, episode.EpisodeNumber, lookup), play, languages, anchorTitle: null, ct);
            episodes.Add(new DownloadSeasonEpisodeDto
            {
                WorkId = key.WorkId,
                EpisodeNumber = episode.EpisodeNumber,
                Title = episode.Title,
                AirDate = episode.AirDate,
                Aired = aired.Contains(episode.EpisodeNumber),
                RuntimeMinutes = episode.RuntimeMinutes ?? catalog.Series.RuntimeMinutes,
                Candidates = candidates,
                StreamOnlyCount = candidates.Count(c => !c.Offline.Playable),
            });
        }

        return new DownloadSeasonCandidatesResponse
        {
            WorkId = TvCatalogService.SeasonWorkId(tmdbId, seasonNumber),
            SeriesWorkId = seriesWorkId,
            SeasonNumber = seasonNumber,
            Packs = await PacksAsync(viewer, tmdbId, seasonNumber, season, lookup, coverage, aired, play, languages, ct),
            Episodes = episodes,
            CheckedAt = lookup.CheckedAt,
            FromCache = lookup.FromCache,
            Incomplete = season.Incomplete,
        };
    }

    /// <summary>
    /// For each target episode the downloadable candidate most like <paramref name="anchorReleaseId"/>, in the anchor's language (the viewer's
    /// explicit pick decides it, not the profile's preference): similarity among candidates of that language, else the first of that
    /// language in device order, else the first in the viewer's best audio language with a <c>language_differs</c> note.
    /// </summary>
    public async Task<DownloadPlanResponse> DownloadPlanAsync(
        ViewerEntity viewer, WorkKey anchor, string anchorReleaseId, IReadOnlyList<WorkKey> targets, PlayContext play,
        IReadOnlyList<string>? languages, CancellationToken ct)
    {
        var anchorWork = await WorkReleasesAsync(viewer, anchor, refresh: false, cachedOnly: false, ct)
                         ?? throw new InvalidOperationException("A searched version list is never a cache miss.");
        var anchorTitle = anchorWork.Releases.Releases.FirstOrDefault(r => r.Release.ReleaseId == anchorReleaseId)?.Release.Title
                          ?? releaseStore.Get(anchorReleaseId, anchor.WorkId)?.Release.Title
                          ?? throw new ViewerProblem(StatusCodes.Status404NotFound, "release_not_found", "The anchor version is not a version of the anchor episode.",
                              new Dictionary<string, string> { ["releaseId"] = anchorReleaseId });
        var ranking = rankingProfiles.ForViewer(viewer, MediaType.Tv);
        var languageProfile = ViewerAudioLanguages.ProfileFor(languages, ranking.Profile);
        var anchorLanguages = ReleaseParser.Parse(anchorTitle).Languages;

        var items = new List<DownloadPlanItemDto>(targets.Count);
        foreach (var target in targets)
        {
            WorkReleases work;
            try
            {
                work = target.WorkId == anchor.WorkId ? anchorWork
                    : await WorkReleasesAsync(viewer, target, refresh: false, cachedOnly: false, ct)
                      ?? throw new InvalidOperationException("A searched version list is never a cache miss.");
            }
            catch (ViewerProblem problem) when (problem.Code is "episode_not_found" or "season_not_found")
            {
                items.Add(new DownloadPlanItemDto { WorkId = target.WorkId, Match = "none", Notes = [Note(problem.Code)] });
                continue;
            }
            var candidates = await DownloadListAsync(viewer, target, work, play, languages, anchorTitle, ct);
            var downloadable = candidates.Where(c => c.Offline.Playable).ToList();
            if (downloadable.Count == 0)
            {
                items.Add(new DownloadPlanItemDto
                {
                    WorkId = target.WorkId,
                    Match = "none",
                    Notes = [Note(candidates.Count == 0 ? "no_versions" : "not_offline_playable")],
                });
                continue;
            }
            var languagesOf = downloadable.Select(c => ReleaseParser.Parse(c.Version.Name).Languages).ToList();
            var compatible = languagesOf.Select(l => SameLanguage(anchorLanguages, l)).ToList();
            // Similarity only among the anchor's language; never a better picture in another language over one in it.
            var grades = ViewerReleaseAffinity.Grades(anchorTitle, downloadable.Select((c, i) => (c.Version.Name, compatible[i] ? 1 : 0)).ToList());
            var similar = Enumerable.Range(0, downloadable.Count).Where(i => compatible[i] && grades[i].Grade != AffinityGrade.None)
                .Select(i => (int?)i).MaxBy(i => ((int)grades[i!.Value].Grade, -i!.Value));
            var grade = similar is { } match ? grades[match].Grade : AffinityGrade.None;
            var pick = similar ?? compatible.IndexOf(true);
            if (pick < 0)
            {
                var points = downloadable.Select(c => ViewerAudioLanguages.LanguagePoints(ReleaseParser.Parse(c.Version.Name).Languages, languageProfile, ranking.Profile)).ToList();
                pick = points.IndexOf(points.Max());
            }
            var notes = new List<PredictionReasonDto>();
            if (grade == AffinityGrade.None && grades.Any(g => g.LanguageGated))
                notes.Add(Note("language_mismatch"));
            if (!compatible[pick])
            {
                notes.Add(new PredictionReasonDto
                {
                    Code = "language_differs",
                    Params = new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["languages"] = LanguageList(languagesOf[pick]),
                        ["anchorLanguages"] = LanguageList(anchorLanguages),
                    },
                });
            }
            items.Add(new DownloadPlanItemDto
            {
                WorkId = target.WorkId,
                Match = grade switch
                {
                    AffinityGrade.Release => "same_release",
                    AffinityGrade.Variant => "same_variant",
                    AffinityGrade.Group => "same_group",
                    _ => "best_available",
                },
                Score = Math.Round(grades[pick].Score, 2),
                Candidate = downloadable[pick],
                Notes = notes,
            });
        }

        var chosen = items.Select(i => i.Candidate).OfType<DownloadCandidateDto>().ToList();
        return new DownloadPlanResponse
        {
            AnchorWorkId = anchor.WorkId,
            AnchorReleaseId = anchorReleaseId,
            AnchorName = anchorTitle,
            Items = items,
            TotalSizeBytes = chosen.Sum(c => c.SizeBytes),
            TotalSizeExact = chosen.All(c => c.SizeExact),
        };
    }

    /// <summary>The other copies of a release in the work's cached list (the same name within 2 % of the size, as the versions list merges them).</summary>
    public IReadOnlyList<string> CopiesOf(WorkKey key, string releaseId)
    {
        var list = key switch
        {
            { Kind: WorkKind.Movie, TmdbId: { } movieId } => versionCache.TryPeek<MovieVersions>(MovieKey(movieId))?.Releases,
            { Kind: WorkKind.Episode, TmdbId: { } seriesId, Season: { } season, Episode: { } episode }
                => versionCache.TryPeek<SeasonVersions>(SeasonKey(seriesId, season))?.Episodes.GetValueOrDefault(episode),
            _ => null,
        };
        var own = list?.FirstOrDefault(r => r.Release.ReleaseId == releaseId)?.Release ?? releaseStore.Get(releaseId, key.WorkId)?.Release;
        if (own is null || list is null)
            return [];
        var name = CopyName(own.Title);
        return list.Select(r => r.Release)
            .Where(r => r.ReleaseId != releaseId && !r.Rejected && !IsDead(r) && CopyName(r.Title) == name
                        && Math.Abs(r.SizeBytes - own.SizeBytes) <= Math.Max(r.SizeBytes, own.SizeBytes) / 50)
            .Select(r => r.ReleaseId)
            .Distinct(StringComparer.Ordinal)
            .ToList();
    }

    /// <summary>The episodes of the season each release of the cached season list is listed under (packs: several).</summary>
    internal static Dictionary<string, IReadOnlyList<int>> Coverage(SeasonVersions season)
        => season.Episodes
            .SelectMany(e => e.Value.Select(r => (r.Release.ReleaseId, Episode: e.Key)))
            .GroupBy(x => x.ReleaseId, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => (IReadOnlyList<int>)g.Select(x => x.Episode).Distinct().Order().ToList(), StringComparer.Ordinal);

    /// <summary>The exact size when an earlier resolve opened this release for this work, else the indexer size or a pack's even share.</summary>
    public (long Bytes, string Source) DownloadSize(string releaseId, string workId, long releaseBytes, int share)
        => resolvedFiles.Get(releaseId, workId) is { } file ? (file.SizeBytes, SizeResolved)
            : share > 1 ? (releaseBytes / share, SizeEstimate)
            : (releaseBytes, SizeIndexer);

    private static WorkReleases EpisodeWork(SeasonVersions season, int episode, CachedLookup<SeasonVersions> lookup)
        => new(EpisodeList(season, episode), season.RuntimeMinutes.GetValueOrDefault(episode), season.EpisodeCount, lookup.CheckedAt, lookup.FromCache,
            season.Incomplete, season);

    private async Task<List<DownloadCandidateDto>> DownloadListAsync(
        ViewerEntity viewer, WorkKey key, WorkReleases work, PlayContext play, IReadOnlyList<string>? languages, string? anchorTitle, CancellationToken ct)
    {
        var lastPlayed = anchorTitle is null ? await LastPlayedAsync(viewer, key, work.Releases.Releases, ct) : new LastPlayed(anchorTitle, null);
        var offline = new Dictionary<string, OfflinePrediction>(StringComparer.Ordinal);
        var (versions, _) = MapVersions(viewer, key, work.Releases, work.Runtime, work.PackEpisodes, device: null, play, languages, lastPlayed, legs: null, offline);
        var coverage = work.Season is { } season ? Coverage(season) : null;
        var candidates = versions.Select(v => Candidate(v, offline[v.ReleaseId].Dto, key, coverage?.GetValueOrDefault(v.ReleaseId), work.PackEpisodes)).ToList();
        var points = LanguagePoints(viewer, key, languages);
        var recommended = BestLanguageFirst(candidates, c => c.Version.Name, points);
        return candidates.Select(c => c with
            {
                Recommended = ReferenceEquals(c, recommended),
                Version = c.Version with { Recommended = ReferenceEquals(c, recommended) },
            })
            .ToList();
    }

    /// <summary>Language points of a release name for the viewer's audio languages (as the ranking and the series affinity use them).</summary>
    private Func<string, int> LanguagePoints(ViewerEntity viewer, WorkKey key, IReadOnlyList<string>? languages)
    {
        var ranking = rankingProfiles.ForViewer(viewer, key.Kind == WorkKind.Movie ? MediaType.Movie : MediaType.Tv);
        var profile = ViewerAudioLanguages.ProfileFor(languages, ranking.Profile);
        return name => ViewerAudioLanguages.LanguagePoints(ReleaseParser.Parse(name).Languages, profile, ranking.Profile);
    }

    /// <summary>The first offline-playable item in the best audio language any offline-playable item has; null when none plays offline.</summary>
    private static T? BestLanguageFirst<T>(IReadOnlyList<T> items, Func<T, string> name, Func<string, int> points) where T : class
    {
        var playable = items.Where(i => i switch
        {
            DownloadCandidateDto c => c.Offline.Playable,
            DownloadPackDto p => p.Offline.Playable,
            _ => false,
        }).ToList();
        if (playable.Count == 0)
            return null;
        var best = playable.Max(i => points(name(i)));
        return playable.First(i => points(name(i)) == best);
    }

    private DownloadCandidateDto Candidate(VersionDto version, OfflinePlayabilityDto offline, WorkKey key, IReadOnlyList<int>? episodes, int packEpisodes)
    {
        var pack = key.Kind == WorkKind.Episode && (episodes is { Count: > 1 } || version.SeasonPack);
        var share = !pack ? 1 : episodes is { Count: > 1 } ? episodes.Count : Math.Max(1, packEpisodes);
        var (bytes, source) = DownloadSize(version.ReleaseId, key.WorkId, version.SizeBytes, share);
        return new DownloadCandidateDto
        {
            Version = version,
            Offline = offline,
            SizeBytes = bytes,
            SizeExact = source == SizeResolved,
            SizeSource = source,
            SeasonPack = pack,
            PackEpisodes = pack ? episodes : null,
            Recommended = version.Recommended && offline.Playable,
        };
    }

    private async Task<IReadOnlyList<DownloadPackDto>> PacksAsync(
        ViewerEntity viewer, int tmdbId, int seasonNumber, SeasonVersions season, CachedLookup<SeasonVersions> lookup,
        Dictionary<string, IReadOnlyList<int>> coverage, IReadOnlySet<int> aired, PlayContext play, IReadOnlyList<string>? languages, CancellationToken ct)
    {
        var packIds = coverage.Where(c => c.Value.Count > 1).Select(c => c.Key).ToHashSet(StringComparer.Ordinal);
        if (packIds.Count == 0)
            return [];
        // Ranked once, at the first episode a pack covers, among the season's packs only.
        var first = coverage.Where(c => packIds.Contains(c.Key)).Min(c => c.Value[0]);
        var releases = season.Episodes.OrderBy(e => e.Key).SelectMany(e => e.Value)
            .Where(r => packIds.Contains(r.Release.ReleaseId))
            .DistinctBy(r => r.Release.ReleaseId)
            .ToList();
        var key = WorkKey.ForEpisode(tmdbId, seasonNumber, first);
        var work = EpisodeWork(season, first, lookup) with { Releases = new VersionList(releases, season.RankedWith, season.RankRuntime) };
        var candidates = await DownloadListAsync(viewer, key, work, play, languages, anchorTitle: null, ct);
        var regular = season.Episodes.Keys.Where(aired.Contains).ToHashSet();
        List<DownloadPackDto> packs = candidates.Select(candidate =>
        {
            var episodes = coverage[candidate.Version.ReleaseId];
            var sizes = episodes
                .Select(e => DownloadSize(candidate.Version.ReleaseId, WorkKey.ForEpisode(tmdbId, seasonNumber, e).WorkId, candidate.Version.SizeBytes, episodes.Count))
                .ToList();
            return new DownloadPackDto
            {
                Version = candidate.Version,
                Offline = candidate.Offline,
                Episodes = episodes,
                Complete = regular.Count > 0 && regular.IsSubsetOf(episodes),
                PackSizeBytes = candidate.Version.SizeBytes,
                SizeBytes = sizes.Sum(s => s.Bytes),
                SizeExact = sizes.All(s => s.Source == SizeResolved),
                PerEpisodeSizeBytes = candidate.Version.SizeBytes / episodes.Count,
                Recommended = false,
            };
        })
            .ToList();
        var points = LanguagePoints(viewer, key, languages);
        packs = packs
            .OrderBy(p => p.Offline.Playable ? 0 : 1)
            .ThenByDescending(p => points(p.Version.Name))
            .ThenBy(p => p.Complete ? 0 : 1)
            .ThenBy(p => p.Version.Rank)
            .ToList();
        if (BestLanguageFirst(packs, p => p.Version.Name, points) is { } best)
            packs[packs.IndexOf(best)] = best with { Recommended = true };
        return packs;
    }

    private static PredictionReasonDto Note(string code) => new() { Code = code };

    /// <summary>The plan's language class: the same primary (first parsed) audio language, or both names without a language tag.</summary>
    internal static bool SameLanguage(IReadOnlyList<string> anchor, IReadOnlyList<string> candidate)
        => anchor.Count == 0 ? candidate.Count == 0 : candidate.Count > 0 && string.Equals(anchor[0], candidate[0], StringComparison.Ordinal);

    private static string LanguageList(IReadOnlyList<string> languages) => languages.Count == 0 ? "untagged" : string.Join(',', languages);
}
