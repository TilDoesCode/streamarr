namespace Streamarr.Core.Providers;

/// <summary>Configuration of one Newznab indexer (BRIEF.md §6.3).</summary>
public sealed record IndexerConfig
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public required string BaseUrl { get; init; }

    /// <summary>Secret: encrypted at rest, never returned in plaintext by the config API.</summary>
    public string ApiKey { get; init; } = string.Empty;

    /// <summary>Newznab category ids to search (e.g. 2000 movies, 5000 tv).</summary>
    public IReadOnlyList<int> Categories { get; init; } = [];

    public bool Enabled { get; init; } = true;

    /// <summary>Lower value = preferred.</summary>
    public int Priority { get; init; }
}
