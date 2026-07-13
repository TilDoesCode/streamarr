namespace Streamarr.Core.Indexers;

/// <summary>
/// Optional sink the indexer fan-out reports per-indexer latency + outcome to, so the
/// server's metrics endpoint can surface per-indexer latency (BRIEF §10-M7 observability)
/// without the Core taking a dependency on the server's metrics collector.
/// </summary>
public interface IIndexerLatencyRecorder
{
    void Record(string indexerId, string indexerName, double elapsedMs, bool success);
}
