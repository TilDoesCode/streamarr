using Streamarr.Core.Providers;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Source of the configured Newznab indexers (BRIEF §6.3). In-memory for now;
/// a SQLite-backed store CRUD'd by the Management UI replaces it in M3 without
/// touching the fan-out. Implementations must be thread-safe.
/// </summary>
public interface IIndexerConfigStore
{
    /// <summary>All configured indexers, enabled or not, ordered by priority.</summary>
    IReadOnlyList<IndexerConfig> GetAll();

    /// <summary>Only the enabled indexers, ordered by priority (lower = preferred).</summary>
    IReadOnlyList<IndexerConfig> GetEnabled();
}

/// <summary>
/// Trivial thread-safe in-memory <see cref="IIndexerConfigStore"/>. Seeded from
/// config at startup; also mutable (<see cref="Replace"/>) so tests and, later,
/// the config API can swap the indexer set at runtime.
/// </summary>
public sealed class InMemoryIndexerConfigStore : IIndexerConfigStore
{
    private volatile IReadOnlyList<IndexerConfig> _indexers;

    public InMemoryIndexerConfigStore(IEnumerable<IndexerConfig>? indexers = null)
        => _indexers = Order(indexers ?? []);

    public IReadOnlyList<IndexerConfig> GetAll() => _indexers;

    public IReadOnlyList<IndexerConfig> GetEnabled()
        => _indexers.Where(i => i.Enabled).ToArray();

    public void Replace(IEnumerable<IndexerConfig> indexers)
        => _indexers = Order(indexers);

    private static IReadOnlyList<IndexerConfig> Order(IEnumerable<IndexerConfig> indexers)
        => indexers.OrderBy(i => i.Priority).ThenBy(i => i.Name, StringComparer.OrdinalIgnoreCase).ToArray();
}
