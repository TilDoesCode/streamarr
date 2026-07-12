using System.Collections.Concurrent;

namespace Streamarr.Core.Indexers;

/// <summary>Spaces out requests to a single indexer to honour its rate limit.</summary>
public interface IIndexerRateLimiter
{
    /// <summary>
    /// Completes once it is this indexer's turn to make a request — immediately if
    /// enough time has elapsed since the previous one, otherwise after the residual
    /// interval. Requests to the same indexer are serialized; different indexers
    /// never block each other.
    /// </summary>
    Task WaitAsync(string indexerId, CancellationToken cancellationToken);
}

/// <summary>
/// Per-indexer minimum-interval rate limiter (BRIEF §6.1: "respect per-indexer rate
/// limits"). Uses an injected <see cref="TimeProvider"/> so both the clock and the
/// wait are testable. A non-positive interval disables limiting entirely.
/// </summary>
public sealed class IndexerRateLimiter(TimeSpan minInterval, TimeProvider? timeProvider = null) : IIndexerRateLimiter
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ConcurrentDictionary<string, Gate> _gates = new(StringComparer.OrdinalIgnoreCase);

    public async Task WaitAsync(string indexerId, CancellationToken cancellationToken)
    {
        if (minInterval <= TimeSpan.Zero)
            return;

        var gate = _gates.GetOrAdd(indexerId, _ => new Gate());

        await gate.Mutex.WaitAsync(cancellationToken);
        try
        {
            var now = _time.GetUtcNow();
            var earliest = gate.LastRequestUtc + minInterval;
            if (earliest > now)
                await Task.Delay(earliest - now, _time, cancellationToken);

            gate.LastRequestUtc = _time.GetUtcNow();
        }
        finally
        {
            gate.Mutex.Release();
        }
    }

    private sealed class Gate
    {
        public readonly SemaphoreSlim Mutex = new(1, 1);
        public DateTimeOffset LastRequestUtc = DateTimeOffset.MinValue;
    }
}
