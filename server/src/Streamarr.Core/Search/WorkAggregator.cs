using System.Globalization;
using System.Text;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Parser;
using Streamarr.Core.Profiles;
using Streamarr.Core.Ranking;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Search;

/// <summary>
/// The tail of the search pipeline (BRIEF §7): parse each raw release, resolve the
/// TMDB work it belongs to, reject + rank it against the profile, and group the ranked
/// releases into <see cref="Work"/>s. TMDB is queried once per distinct work (not per
/// release) so a page of releases costs a handful of lookups, all cache-friendly.
/// </summary>
public sealed class WorkAggregator(ITmdbClient tmdb, ReleaseEvaluator evaluator, IReleaseHealthCache? healthCache = null)
{
    public async Task<SearchAggregation> AggregateAsync(
        IReadOnlyList<Release> releases,
        IReadOnlyList<IndexerOutcome> outcomes,
        SearchContext context,
        QualityProfile profile,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(releases);
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(profile);

        if (releases.Count == 0)
            return SearchAggregation.Empty with { Outcomes = outcomes };

        // 1) parse every release and bucket it by the work it appears to belong to.
        var parsedReleases = releases
            .Select(r => new Parsed(r, ReleaseParser.Parse(r.Title)))
            .ToArray();

        var groups = parsedReleases
            .GroupBy(p => KeyFor(p.Info, context))
            .ToArray();

        // The id-based path (imdbId / tmdbId) applies to one primary title group only.
        // Semantic searches choose the group closest to the canonical TMDB title/year;
        // explicit id-only calls retain the historical largest-group fallback. This keeps
        // a stray or noisy indexer result from hijacking the requested work's identity.
        var primaryKey = context.HasIds
            ? groups
                .Where(g => g.Key.Type == (context.RequestedType ?? MediaType.Movie))
                .Select(g => new
                {
                    Group = g,
                    Similarity = CanonicalSimilarity(g.Key, context),
                })
                .Where(candidate => candidate.Similarity >= 0)
                .OrderByDescending(candidate => candidate.Similarity)
                .ThenByDescending(candidate => candidate.Group.Count())
                .Select(candidate => (MatchKey?)candidate.Group.Key)
                .FirstOrDefault()
            : null;

        // 2) resolve each group's TMDB work (once), then reject + rank its releases.
        var works = new List<AggregatedWork>(groups.Length);
        var evaluated = new List<EvaluatedRelease>(releases.Count);

        foreach (var group in groups)
        {
            var key = group.Key;
            var title = TitleFor(group);
            var match = await ResolveAsync(key, context, title, key.Equals(primaryKey), cancellationToken);

            var workId = WorkId(key, match, title);
            var runtime = match?.RuntimeMinutes;

            var groupReleases = new List<EvaluatedRelease>(group.Count());
            foreach (var parsed in group)
            {
                // A dead classification from a prior resolve outranks the (Unknown) health a
                // freshly re-registered release carries, so known-dead releases stay demoted
                // and rejected across re-searches (BRIEF §10-M7: feed deadness into ranking).
                var health = healthCache?.Get(parsed.Release.ReleaseId) is { } cached
                    ? cached
                    : parsed.Release.Health;

                var assessment = evaluator.Evaluate(
                    ReleaseSignals.FromParsed(
                        parsed.Info,
                        parsed.Release.SizeBytes,
                        runtimeMinutes: runtime,
                        ageDays: parsed.Release.AgeDays,
                        grabs: parsed.Release.Grabs,
                        health: health),
                    profile);

                var enriched = ReleaseEvaluator.Apply(parsed.Release, assessment) with
                {
                    Quality = QualityOf(parsed.Info),
                    Languages = parsed.Info.Languages,
                    ReleaseGroup = parsed.Info.ReleaseGroup,
                    Health = health,
                };

                groupReleases.Add(new EvaluatedRelease
                {
                    WorkId = workId,
                    Release = enriched,
                    Parsed = parsed.Info,
                    Assessment = assessment,
                });
            }

            var ordered = ReleaseEvaluator.Order(groupReleases.Select(e => e.Release));
            evaluated.AddRange(groupReleases);

            works.Add(new AggregatedWork(
                new Work
                {
                    WorkId = workId,
                    MediaType = key.Type,
                    Title = match?.Title ?? Titleize(title),
                    Year = match?.Year ?? key.Year,
                    TmdbId = match?.TmdbId,
                    ImdbId = match?.ImdbId,
                    Overview = match?.Overview,
                    PosterUrl = match?.PosterUrl,
                    BackdropUrl = match?.BackdropUrl,
                    RuntimeMinutes = runtime,
                    Season = key.Season,
                    Episode = key.Episode,
                    Releases = ordered,
                },
                BestScore(ordered)));
        }

        // 3) order works best-first: those with an accepted release above those without,
        // then by their best release's score, then by title for stability.
        var orderedWorks = works
            .OrderByDescending(w => w.HasAccepted)
            .ThenByDescending(w => w.BestScore)
            .ThenBy(w => w.Work.Title, StringComparer.OrdinalIgnoreCase)
            .Select(w => w.Work)
            .ToArray();

        return new SearchAggregation
        {
            Works = orderedWorks,
            Releases = evaluated,
            Outcomes = outcomes,
        };
    }

    private async Task<TmdbMatch?> ResolveAsync(MatchKey key, SearchContext context, string title, bool usePrimaryIds, CancellationToken ct)
    {
        if (usePrimaryIds && context.ResolvedTarget is { } target && target.MediaType == key.Type)
            return target;

        if (key.Type == MediaType.Tv)
        {
            if (usePrimaryIds && context.TmdbId is { } tvId)
                return await tmdb.GetTvAsync(tvId, ct);
            if (usePrimaryIds && !string.IsNullOrWhiteSpace(context.ImdbId)
                && await tmdb.FindByImdbAsync(context.ImdbId!, ct) is { MediaType: MediaType.Tv } byImdb)
                return byImdb;
            return string.IsNullOrWhiteSpace(title) ? null : await tmdb.SearchTvAsync(title, ct);
        }

        if (usePrimaryIds && context.TmdbId is { } movieId)
            return await tmdb.GetMovieAsync(movieId, ct);
        if (usePrimaryIds && !string.IsNullOrWhiteSpace(context.ImdbId)
            && await tmdb.FindByImdbAsync(context.ImdbId!, ct) is { MediaType: MediaType.Movie } movieByImdb)
            return movieByImdb;
        return string.IsNullOrWhiteSpace(title) ? null : await tmdb.SearchMovieAsync(title, key.Year, ct);
    }

    /// <summary>Bucket a release: media type + normalized title (+ year for movies, season/episode for TV).</summary>
    private static MatchKey KeyFor(ParsedReleaseInfo info, SearchContext context)
    {
        var type = context.RequestedType
            ?? (info.MediaType == ParsedMediaType.Tv ? MediaType.Tv : MediaType.Movie);

        var titleKey = NewznabQuery.NormalizeTerm(info.Title ?? info.ReleaseName);

        if (type == MediaType.Tv)
        {
            var season = info.Season ?? context.Season;
            var episode = info.Episodes.Count > 0 ? info.Episodes[0] : context.Episode;
            return new MatchKey(MediaType.Tv, titleKey, Year: null, season, episode, info.SeasonPack);
        }

        return new MatchKey(MediaType.Movie, titleKey, info.Year, Season: null, Episode: null, SeasonPack: false);
    }

    private static string TitleFor(IGrouping<MatchKey, Parsed> group)
        => group
            .Select(p => p.Info.Title)
            .FirstOrDefault(t => !string.IsNullOrWhiteSpace(t))
           ?? group.Key.TitleKey;

    /// <summary>
    /// Confidence that an indexer title group is the canonical semantic target. Explicit
    /// id-only API calls have no canonical title and retain the historical largest-group
    /// behavior (all groups get confidence 0). A semantic target must clear a conservative
    /// title threshold, with a conflicting release year treated as a definite mismatch.
    /// </summary>
    private static double CanonicalSimilarity(MatchKey key, SearchContext context)
    {
        if (string.IsNullOrWhiteSpace(context.CanonicalTitle))
            return 0;
        if (key.Year is { } releaseYear
            && context.CanonicalYear is { } canonicalYear
            && releaseYear != canonicalYear)
        {
            return -1;
        }

        var left = SemanticTitleTokens(key.TitleKey);
        var right = SemanticTitleTokens(context.CanonicalTitle);
        if (left.Length == 0 || right.Length == 0)
            return -1;
        if (left.SequenceEqual(right, StringComparer.Ordinal))
            return 1;

        var leftSet = left.ToHashSet(StringComparer.Ordinal);
        var rightSet = right.ToHashSet(StringComparer.Ordinal);
        var intersection = leftSet.Count(rightSet.Contains);
        var dice = 2d * intersection / (leftSet.Count + rightSet.Count);
        return dice >= 0.72 ? dice : -1;
    }

    private static string[] SemanticTitleTokens(string title)
        => NewznabQuery.NormalizeTerm(title)
            .Split(' ', StringSplitOptions.RemoveEmptyEntries)
            .Select(NormalizeOrdinalToken)
            .ToArray();

    private static string NormalizeOrdinalToken(string token) => token switch
    {
        "0" => "zero",
        "1" or "i" => "one",
        "2" or "ii" => "two",
        "3" or "iii" => "three",
        "4" or "iv" => "four",
        "5" or "v" => "five",
        "6" or "vi" => "six",
        "7" or "vii" => "seven",
        "8" or "viii" => "eight",
        "9" or "ix" => "nine",
        "10" or "x" => "ten",
        _ => token,
    };

    private static string WorkId(MatchKey key, TmdbMatch? match, string title)
    {
        if (match is not null)
        {
            return key.Type switch
            {
                MediaType.Movie => $"tmdb-movie-{match.TmdbId}",
                MediaType.Tv when key is { Season: { } s, Episode: { } e } => $"tmdb-tv-{match.TmdbId}-s{s:D2}e{e:D2}",
                MediaType.Tv when key.Season is { } sp => $"tmdb-tv-{match.TmdbId}-s{sp:D2}",
                _ => $"tmdb-tv-{match.TmdbId}",
            };
        }

        return $"unmatched-{key.Type.ToString().ToLowerInvariant()}-{Slug(title, key)}";
    }

    private static QualityInfo QualityOf(ParsedReleaseInfo info) => new()
    {
        Resolution = info.Resolution,
        Source = info.Source,
        Codec = info.VideoCodec,
        Hdr = info.Hdr,
        Audio = ComposeAudio(info),
        Edition = info.Edition,
        Proper = info.Proper,
        Repack = info.Repack,
    };

    private static string? ComposeAudio(ParsedReleaseInfo info)
    {
        if (string.IsNullOrWhiteSpace(info.AudioCodec))
            return null;
        var audio = string.IsNullOrWhiteSpace(info.AudioChannels)
            ? info.AudioCodec
            : $"{info.AudioCodec}{info.AudioChannels}";
        return info.Atmos ? $"{audio} Atmos" : audio;
    }

    private static int BestScore(IReadOnlyList<Release> releases)
    {
        var accepted = releases.Where(r => !r.Rejected).ToArray();
        var pool = accepted.Length > 0 ? accepted : releases;
        return pool.Count > 0 ? pool.Max(r => r.Score) : int.MinValue;
    }

    private static string Titleize(string normalized)
    {
        if (string.IsNullOrWhiteSpace(normalized))
            return "Unknown";
        return CultureInfo.InvariantCulture.TextInfo.ToTitleCase(normalized);
    }

    private static string Slug(string title, MatchKey key)
    {
        var sb = new StringBuilder();
        foreach (var ch in NewznabQuery.NormalizeTerm(title))
            sb.Append(ch == ' ' ? '-' : ch);
        if (key.Year is { } y)
            sb.Append('-').Append(y);
        if (key.Season is { } s)
            sb.Append("-s").Append(s.ToString("D2", CultureInfo.InvariantCulture));
        if (key.Episode is { } e)
            sb.Append("-e").Append(e.ToString("D2", CultureInfo.InvariantCulture));
        return sb.Length == 0 ? "unknown" : sb.ToString();
    }

    private readonly record struct Parsed(Release Release, ParsedReleaseInfo Info);

    private readonly record struct MatchKey(MediaType Type, string TitleKey, int? Year, int? Season, int? Episode, bool SeasonPack);

    private readonly record struct AggregatedWork(Work Work, int BestScore)
    {
        public bool HasAccepted => Work.Releases.Any(r => !r.Rejected);
    }
}
