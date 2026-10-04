using System.Text.RegularExpressions;

namespace Streamarr.Server.Viewers.Artwork;

/// <summary>
/// One image in three size classes. Pick the smallest class whose width covers the rendered width in device pixels:
/// posters 185 / 342 / 780 px wide, backdrops and episode stills 300 / 780 / 1280 px wide.
/// </summary>
public sealed record ArtworkSizesDto
{
    /// <summary>Thumbnails and cards at 1x (poster <c>w185</c>, backdrop/still <c>w300</c>).</summary>
    public required string Small { get; init; }

    /// <summary>Cards on high-density screens and TV rows (poster <c>w342</c>, backdrop/still <c>w780</c>).</summary>
    public required string Medium { get; init; }

    /// <summary>Detail and hero artwork (poster <c>w780</c>, backdrop/still <c>w1280</c>); the size of the plain URL field.</summary>
    public required string Large { get; init; }
}

/// <summary>Maps an artwork URL to its size classes. URLs in TMDB's layout (<c>…/t/p/{size}/{file}</c>) get the size segment swapped; any other URL is used for every class.</summary>
public static partial class ArtworkSizes
{
    public static ArtworkSizesDto? Poster(string? url) => For(url, "w185", "w342", "w780");

    public static ArtworkSizesDto? Backdrop(string? url) => For(url, "w300", "w780", "w1280");

    public static ArtworkSizesDto? Still(string? url) => For(url, "w300", "w780", "w1280");

    private static ArtworkSizesDto? For(string? url, string small, string medium, string large)
    {
        if (string.IsNullOrWhiteSpace(url))
            return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme is not ("https" or "http") || !SizeSegment().IsMatch(uri.AbsolutePath))
            return new ArtworkSizesDto { Small = url, Medium = url, Large = url };
        return new ArtworkSizesDto { Small = Sized(url, small), Medium = Sized(url, medium), Large = Sized(url, large) };
    }

    private static string Sized(string url, string size) => SizeSegment().Replace(url, $"/t/p/{size}/", 1);

    [GeneratedRegex(@"/t/p/(?:w\d{2,4}|h\d{2,4}|original)/", RegexOptions.CultureInvariant)]
    private static partial Regex SizeSegment();
}
