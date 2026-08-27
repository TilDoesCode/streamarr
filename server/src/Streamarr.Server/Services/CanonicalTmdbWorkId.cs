using System.Text.RegularExpressions;

namespace Streamarr.Server.Services;

internal static partial class CanonicalTmdbWorkId
{
    [GeneratedRegex(
        "^tmdb-movie-(?<id>[1-9][0-9]*)$",
        RegexOptions.CultureInvariant)]
    private static partial Regex MoviePattern();

    [GeneratedRegex(
        "^tmdb-tv-(?<id>[1-9][0-9]*)(?:-s(?<season>[0-9]+)(?:e(?<episode>[0-9]+))?)?$",
        RegexOptions.CultureInvariant)]
    private static partial Regex TvPattern();

    public static bool IsMatch(string? workId)
        => TryNormalize(workId, out _);

    public static bool TryNormalize(string? workId, out string canonical)
    {
        canonical = string.Empty;
        if (string.IsNullOrWhiteSpace(workId))
            return false;

        var movie = MoviePattern().Match(workId);
        if (movie.Success)
        {
            canonical = $"tmdb-movie-{movie.Groups["id"].Value}";
            return true;
        }

        var tv = TvPattern().Match(workId);
        if (!tv.Success)
            return false;

        canonical = $"tmdb-tv-{tv.Groups["id"].Value}";
        if (tv.Groups["season"] is not { Success: true } season)
            return true;

        canonical += $"-s{NormalizeIndex(season.Value)}";
        if (tv.Groups["episode"] is { Success: true } episode)
            canonical += $"e{NormalizeIndex(episode.Value)}";
        return true;
    }

    private static string NormalizeIndex(string value)
    {
        var significant = value.TrimStart('0');
        if (significant.Length == 0)
            significant = "0";
        return significant.Length == 1 ? $"0{significant}" : significant;
    }
}
