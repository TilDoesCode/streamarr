using System.Globalization;
using System.Text.RegularExpressions;
using Streamarr.Server.Services;

namespace Streamarr.Server.Viewers.Watch;

public enum WorkKind
{
    Movie,
    Episode,
    Season,
    Series,
    Other,
}

/// <summary>A parsed, canonical Streamarr work id as used for watch state.</summary>
public sealed partial record WorkKey(string WorkId, WorkKind Kind, int? TmdbId, int? Season, int? Episode)
{
    [GeneratedRegex("^tmdb-(?<type>movie|tv)-(?<id>[1-9][0-9]{0,9})(?:-s(?<season>[0-9]{2,4})(?:e(?<episode>[0-9]{2,4}))?)?$", RegexOptions.CultureInvariant)]
    private static partial Regex CanonicalPattern();

    [GeneratedRegex("^unmatched-(?:movie|tv)-[a-z0-9][a-z0-9-]{0,180}$", RegexOptions.CultureInvariant)]
    private static partial Regex UnmatchedPattern();

    public string? SeriesWorkId => Kind is WorkKind.Episode or WorkKind.Season or WorkKind.Series ? TvCatalogService.SeriesWorkId(TmdbId!.Value) : null;

    public bool IsPlayable => Kind is WorkKind.Movie or WorkKind.Episode or WorkKind.Other;

    public string KindName => Kind.ToString().ToLowerInvariant();

    public static WorkKey? TryParse(string? workId)
    {
        if (string.IsNullOrWhiteSpace(workId) || workId.Length > 200)
            return null;
        var trimmed = workId.Trim();
        if (UnmatchedPattern().IsMatch(trimmed))
            return new WorkKey(trimmed, WorkKind.Other, null, null, null);
        if (!CanonicalTmdbWorkId.TryNormalize(trimmed, out var canonical))
            return null;

        var match = CanonicalPattern().Match(canonical);
        if (!match.Success || !int.TryParse(match.Groups["id"].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdbId))
            return null;
        if (match.Groups["type"].Value == "movie")
            return new WorkKey(canonical, WorkKind.Movie, tmdbId, null, null);

        var season = ParseGroup(match, "season");
        var episode = ParseGroup(match, "episode");
        var kind = episode is not null ? WorkKind.Episode : season is not null ? WorkKind.Season : WorkKind.Series;
        return new WorkKey(canonical, kind, tmdbId, season, episode);
    }

    public static WorkKey ForEpisode(int tmdbId, int season, int episode)
        => new(TvCatalogService.EpisodeWorkId(tmdbId, season, episode), WorkKind.Episode, tmdbId, season, episode);

    private static int? ParseGroup(Match match, string name)
        => match.Groups[name] is { Success: true } group &&
           int.TryParse(group.Value, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            ? value
            : null;
}
