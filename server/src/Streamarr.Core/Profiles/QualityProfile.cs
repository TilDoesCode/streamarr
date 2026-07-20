using Streamarr.Core.Media;

namespace Streamarr.Core.Profiles;

/// <summary>A single condition inside an imported Sonarr/Radarr custom format.</summary>
public sealed record CustomFormatCondition
{
    public string Name { get; init; } = string.Empty;
    public string Implementation { get; init; } = string.Empty;
    public bool Negate { get; init; }
    public bool Required { get; init; }
    public string? Value { get; init; }
    public double? Min { get; init; }
    public double? Max { get; init; }
    public bool ExceptLanguage { get; init; }
}

/// <summary>An imported custom format and the score assigned by its quality profile.</summary>
public sealed record CustomFormatScore
{
    public string Name { get; init; } = string.Empty;
    public int Score { get; init; }
    public IReadOnlyList<CustomFormatCondition> Conditions { get; init; } = [];
}

/// <summary>
/// A sane bytes-per-minute band for the fake / size-sanity rejection rule
/// (BRIEF.md §7.2). Bands are keyed by resolution so a 2160p Remux is not
/// judged against a 720p WEB-DL bitrate expectation.
/// </summary>
public sealed record SizeBand
{
    public required long MinBytesPerMinute { get; init; }
    public required long MaxBytesPerMinute { get; init; }
}

/// <summary>
/// A quality preference profile driving the release ranker (BRIEF.md §7.3):
/// a transparent weighted sum, structured so a Radarr-style custom-format model
/// can replace it later without changing the API.
/// </summary>
public sealed record QualityProfile
{
    // Not `required`: the config API generates an id on create, and profiles bind from
    // JSON where a client legitimately omits it. Controller validation enforces a name.
    public string Id { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;

    /// <summary><c>both</c>, <c>movies</c>, or <c>shows</c>.</summary>
    public string AppliesTo { get; init; } = "both";

    /// <summary>Source application for an imported profile; null for native profiles.</summary>
    public string? ImportedFrom { get; init; }

    /// <summary>Source-side quality-profile id, retained for operator traceability.</summary>
    public int? ImportedProfileId { get; init; }

    public DateTimeOffset? ImportedAtUtc { get; init; }

    /// <summary>Preferred resolutions, best first (e.g. ["1080p", "2160p", "720p"]).</summary>
    public IReadOnlyList<string> PreferredResolutions { get; init; } = [];

    /// <summary>Preferred sources, best first (e.g. ["WEB-DL", "BluRay"]).</summary>
    public IReadOnlyList<string> PreferredSources { get; init; } = [];

    /// <summary>Preferred video codecs, best first (e.g. ["x265", "x264"]).</summary>
    public IReadOnlyList<string> PreferredCodecs { get; init; } = [];

    /// <summary>Preferred audio languages, best first (ISO 639-1).</summary>
    public IReadOnlyList<string> PreferredLanguages { get; init; } = [];

    public IReadOnlyList<string> GroupAllowList { get; init; } = [];
    public IReadOnlyList<string> GroupDenyList { get; init; } = [];

    // Weights of the scoring terms (integer points contributed at full match).
    public int ResolutionWeight { get; init; } = 100;
    public int SourceWeight { get; init; } = 80;
    public int CodecWeight { get; init; } = 40;
    public int LanguageWeight { get; init; } = 60;
    public int AudioWeight { get; init; } = 30;
    public int SizeWeight { get; init; } = 20;
    public int ProperRepackBonus { get; init; } = 20;
    public int RecencyBonus { get; init; } = 10;
    public int GrabsBonus { get; init; } = 10;

    /// <summary>Added when a release group is on <see cref="GroupAllowList"/>.</summary>
    public int GroupAllowBonus { get; init; } = 50;

    /// <summary>
    /// Subtracted when a release group is on <see cref="GroupDenyList"/>. Large by
    /// default so a denied group sinks below every accepted release without being a
    /// hard rejection (BRIEF §7.3 keeps deny-list a ranking concern, not §7.2).
    /// </summary>
    public int GroupDenyPenalty { get; init; } = 100_000;

    /// <summary>
    /// Sonarr/Radarr custom-format scores. Matching formats contribute their exact source
    /// score in addition to Streamarr's native weighted terms.
    /// </summary>
    public IReadOnlyList<CustomFormatScore> CustomFormats { get; init; } = [];

    /// <summary>Reject a release when its summed custom-format score falls below this value.</summary>
    public int MinimumCustomFormatScore { get; init; }

    /// <summary>Global fallback bytes-per-minute band for size sanity (BRIEF §7.2).</summary>
    public long MinBytesPerMinute { get; init; } = 3_000_000;
    public long MaxBytesPerMinute { get; init; } = 1_500_000_000;

    /// <summary>
    /// Per-resolution bytes-per-minute bands overriding the global fallback. Keyed by
    /// the resolution token the parser emits ("2160p", "1080p", …).
    /// </summary>
    public IReadOnlyDictionary<string, SizeBand> SizeBands { get; init; }
        = new Dictionary<string, SizeBand>(StringComparer.OrdinalIgnoreCase);

    public bool IsDefault { get; init; }

    /// <summary>Whether this profile may be used for the requested media type.</summary>
    public bool AppliesToMediaType(MediaType? mediaType) =>
        AppliesTo.Equals("both", StringComparison.OrdinalIgnoreCase) ||
        mediaType == MediaType.Movie && AppliesTo.Equals("movies", StringComparison.OrdinalIgnoreCase) ||
        mediaType == MediaType.Tv && AppliesTo.Equals("shows", StringComparison.OrdinalIgnoreCase);

    /// <summary>Resolve the sane bytes-per-minute band for a claimed resolution.</summary>
    public SizeBand BandFor(string? resolution)
    {
        if (resolution is not null && SizeBands.TryGetValue(resolution, out var band))
        {
            return band;
        }

        return new SizeBand
        {
            MinBytesPerMinute = MinBytesPerMinute,
            MaxBytesPerMinute = MaxBytesPerMinute,
        };
    }
}
