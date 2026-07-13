using System.Collections.Concurrent;
using Streamarr.Core.Indexers;

namespace Streamarr.Server.Services;

/// <summary>
/// Process-wide counters behind <c>GET /api/v1/metrics</c> (BRIEF §10-M7 observability):
/// cumulative bytes streamed, session churn, resolve/fallback counts, and per-indexer
/// latency. Live gauges (active sessions, in-flight NNTP connections, cache hit rate,
/// provider connections) are read straight from their owning singletons when the
/// snapshot is assembled — this type only owns the cumulative counters. Thread-safe.
/// </summary>
public sealed class StreamarrMetrics : IIndexerLatencyRecorder
{
    private long _bytesServedTotal;
    private long _sessionsOpenedTotal;
    private long _sessionsClosedTotal;
    private long _resolvesTotal;
    private long _resolveFallbacksTotal;

    private readonly ConcurrentDictionary<string, IndexerLatency> _indexers = new(StringComparer.Ordinal);

    public void AddBytesServed(long count)
    {
        if (count > 0)
            Interlocked.Add(ref _bytesServedTotal, count);
    }

    public void SessionOpened() => Interlocked.Increment(ref _sessionsOpenedTotal);
    public void SessionClosed() => Interlocked.Increment(ref _sessionsClosedTotal);

    public void ResolveCompleted(bool viaFallback)
    {
        Interlocked.Increment(ref _resolvesTotal);
        if (viaFallback)
            Interlocked.Increment(ref _resolveFallbacksTotal);
    }

    public void Record(string indexerId, string indexerName, double elapsedMs, bool success)
        => _indexers.AddOrUpdate(
            indexerId,
            _ => IndexerLatency.First(indexerName, elapsedMs, success),
            (_, existing) => existing.With(indexerName, elapsedMs, success));

    public long BytesServedTotal => Interlocked.Read(ref _bytesServedTotal);
    public long SessionsOpenedTotal => Interlocked.Read(ref _sessionsOpenedTotal);
    public long SessionsClosedTotal => Interlocked.Read(ref _sessionsClosedTotal);
    public long ResolvesTotal => Interlocked.Read(ref _resolvesTotal);
    public long ResolveFallbacksTotal => Interlocked.Read(ref _resolveFallbacksTotal);

    public IReadOnlyList<IndexerLatencySnapshot> IndexerLatencies()
        => _indexers
            .Select(kv => kv.Value.Snapshot(kv.Key))
            .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();

    /// <summary>Mutable per-indexer latency accumulator; guarded by its own lock.</summary>
    private sealed class IndexerLatency
    {
        private readonly object _lock = new();
        private string _name = string.Empty;
        private long _requests;
        private long _failures;
        private double _lastMs;
        private double _avgMs;

        public static IndexerLatency First(string name, double ms, bool success)
        {
            var stat = new IndexerLatency();
            stat.With(name, ms, success);
            return stat;
        }

        public IndexerLatency With(string name, double ms, bool success)
        {
            lock (_lock)
            {
                _name = name;
                _requests++;
                if (!success)
                    _failures++;
                _lastMs = ms;
                // exponential moving average — cheap, no history retained
                _avgMs = _requests == 1 ? ms : (_avgMs * 0.7) + (ms * 0.3);
            }

            return this;
        }

        public IndexerLatencySnapshot Snapshot(string id)
        {
            lock (_lock)
            {
                return new IndexerLatencySnapshot
                {
                    Id = id,
                    Name = _name,
                    Requests = _requests,
                    Failures = _failures,
                    LastLatencyMs = Math.Round(_lastMs, 1),
                    AvgLatencyMs = Math.Round(_avgMs, 1),
                };
            }
        }
    }
}

/// <summary>Per-indexer latency figures projected into the metrics response.</summary>
public sealed record IndexerLatencySnapshot
{
    public required string Id { get; init; }
    public required string Name { get; init; }
    public long Requests { get; init; }
    public long Failures { get; init; }
    public double LastLatencyMs { get; init; }
    public double AvgLatencyMs { get; init; }
}
