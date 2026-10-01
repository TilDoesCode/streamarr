namespace Streamarr.Core.Tmdb;

/// <summary>
/// The TMDB metadata language of the current async flow (a viewer's Accept-Language). <c>null</c> means the
/// server default (<see cref="TmdbOptions.Language"/>). Caches key on <see cref="CacheKey"/> so languages never mix.
/// </summary>
public static class TmdbLanguage
{
    private static readonly AsyncLocal<string?> CurrentValue = new();

    public static string? Current => CurrentValue.Value;

    public static string CacheKey => CurrentValue.Value ?? "";

    /// <summary>Run the following awaits in <paramref name="language"/> (null = server default) until disposed.</summary>
    public static IDisposable Use(string? language)
    {
        var previous = CurrentValue.Value;
        CurrentValue.Value = string.IsNullOrWhiteSpace(language) ? null : language.Trim();
        return new Restore(previous);
    }

    /// <summary>The primary subtag ("de" for "de-AT"), lower case, or null when it is not a 2–3 letter code.</summary>
    public static string? Primary(string? language)
    {
        var code = language?.Trim().Split('-', '_')[0].ToLowerInvariant();
        return code is { Length: 2 or 3 } && code.All(char.IsAsciiLetterLower) ? code : null;
    }

    /// <summary>Whether the language of this flow is English (or the default with an English/empty server language).</summary>
    public static bool IsEnglish(string? effective) => Primary(effective) is null or "en";

    private sealed class Restore(string? previous) : IDisposable
    {
        public void Dispose() => CurrentValue.Value = previous;
    }
}
