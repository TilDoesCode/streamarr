namespace Streamarr.Core.Indexers;

/// <summary>
/// One parsed <c>&lt;item&gt;</c> from a Newznab RSS/XML search response: the raw
/// facts an indexer reports about a release, before parsing/ranking (BRIEF §6.1).
/// The NZB URL stays server-side and is never exposed to clients.
/// </summary>
public sealed record NewznabItem
{
    /// <summary>Raw release name.</summary>
    public required string Title { get; init; }

    /// <summary>Indexer-scoped identity of the release (newznab:attr guid, else the &lt;guid&gt; element).</summary>
    public required string Guid { get; init; }

    /// <summary>NZB download URL from &lt;enclosure&gt; (or &lt;link&gt;). Server-side only.</summary>
    public string? NzbUrl { get; init; }

    public long SizeBytes { get; init; }

    /// <summary>All newznab:attr category ids reported for the item.</summary>
    public IReadOnlyList<int> Categories { get; init; } = [];

    public int Grabs { get; init; }

    /// <summary>RSS &lt;pubDate&gt; — when the indexer listed the release.</summary>
    public DateTimeOffset? PublishDate { get; init; }

    /// <summary>newznab:attr usenetdate — when the release was actually posted to Usenet.</summary>
    public DateTimeOffset? UsenetDate { get; init; }
}

/// <summary>Result of a single indexer's <c>t=search</c>/<c>movie</c>/<c>tvsearch</c> call.</summary>
public sealed record NewznabSearchResponse
{
    public IReadOnlyList<NewznabItem> Items { get; init; } = [];

    /// <summary>newznab:response total (may exceed <see cref="Items"/> when paged).</summary>
    public int? Total { get; init; }
}

/// <summary>A category (with optional subcategories) from a <c>t=caps</c> response.</summary>
public sealed record NewznabCategory
{
    public required int Id { get; init; }
    public required string Name { get; init; }
    public IReadOnlyList<NewznabCategory> Subcategories { get; init; } = [];
}

/// <summary>Parsed <c>t=caps</c> response: what an indexer supports (BRIEF §6.1 module 1).</summary>
public sealed record NewznabCapabilities
{
    public string? ServerTitle { get; init; }
    public string? ServerVersion { get; init; }

    public int? LimitMax { get; init; }
    public int? LimitDefault { get; init; }

    public bool SearchAvailable { get; init; }
    public bool MovieSearchAvailable { get; init; }
    public bool TvSearchAvailable { get; init; }

    public IReadOnlyList<NewznabCategory> Categories { get; init; } = [];
}
