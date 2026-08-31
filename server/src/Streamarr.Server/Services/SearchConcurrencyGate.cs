using System.Collections.Concurrent;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>
/// Immediate-admission gate around the whole search pipeline. One search fans out to
/// every enabled indexer and buffers bounded responses, so bounding each response alone
/// does not bound process-wide in-flight memory.
/// </summary>
public sealed class SearchConcurrencyGate
{
    private readonly SemaphoreSlim _gate;
    private readonly ConcurrentDictionary<long, ActiveSearch> _active = new();
    private readonly ILogger<SearchConcurrencyGate> _logger;
    private readonly TimeProvider _time;
    private readonly TimeSpan _deadline;
    private long _nextId;

    public SearchConcurrencyGate(
        IOptions<StreamarrOptions> options,
        ILogger<SearchConcurrencyGate>? logger = null,
        TimeProvider? time = null)
    {
        var capacity = Math.Max(1, options.Value.MaxConcurrentSearches);
        _gate = new SemaphoreSlim(capacity, capacity);
        _logger = logger ?? NullLogger<SearchConcurrencyGate>.Instance;
        _time = time ?? TimeProvider.System;
        _deadline = TimeSpan.FromSeconds(Math.Max(1, options.Value.SearchTimeoutSeconds));
        Capacity = capacity;
    }

    public int Capacity { get; }

    public async ValueTask<SearchAdmission?> TryEnterAsync(
        SearchOperation operation,
        CancellationToken cancellationToken)
    {
        if (!await _gate.WaitAsync(0, cancellationToken).ConfigureAwait(false))
        {
            var snapshot = GetSnapshot();
            var holders = string.Join(
                ',',
                _active.Values
                    .GroupBy(search => search.Operation)
                    .OrderBy(group => group.Key)
                    .Select(group => $"{group.Key}:{group.Count()}"));
            _logger.LogWarning(
                "Search capacity rejected for {Operation}: active={Active}, capacity={Capacity}, oldestAgeMs={OldestAgeMs}, holders={Holders}",
                operation,
                snapshot.Active,
                snapshot.Capacity,
                snapshot.OldestAge?.TotalMilliseconds,
                holders);
            return null;
        }

        var id = Interlocked.Increment(ref _nextId);
        var deadline = new CancellationTokenSource(_deadline);
        CancellationTokenSource? lifetime = null;
        try
        {
            lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, deadline.Token);
            _active[id] = new ActiveSearch(operation, _time.GetUtcNow());
            return new SearchAdmission(this, id, deadline, lifetime);
        }
        catch
        {
            lifetime?.Dispose();
            deadline.Dispose();
            _active.TryRemove(id, out _);
            _gate.Release();
            throw;
        }
    }

    public SearchCapacitySnapshot GetSnapshot()
    {
        var active = _active.Values.ToArray();
        var oldestStarted = active.Length == 0
            ? (DateTimeOffset?)null
            : active.Min(search => search.StartedAt);
        TimeSpan? oldestAge = oldestStarted is null ? null : _time.GetUtcNow() - oldestStarted.Value;
        if (oldestAge is { } age && age < TimeSpan.Zero)
            oldestAge = TimeSpan.Zero;
        return new SearchCapacitySnapshot(Capacity - _gate.CurrentCount, Capacity, oldestAge);
    }

    private void Exit(long id)
    {
        if (_active.TryRemove(id, out _))
            _gate.Release();
    }

    private sealed record ActiveSearch(SearchOperation Operation, DateTimeOffset StartedAt);

    public sealed class SearchAdmission : IDisposable
    {
        private SearchConcurrencyGate? _owner;
        private readonly long _id;
        private readonly CancellationTokenSource _deadline;
        private readonly CancellationTokenSource _lifetime;

        internal SearchAdmission(
            SearchConcurrencyGate owner,
            long id,
            CancellationTokenSource deadline,
            CancellationTokenSource lifetime)
        {
            _owner = owner;
            _id = id;
            _deadline = deadline;
            _lifetime = lifetime;
        }

        public CancellationToken CancellationToken => _lifetime.Token;

        public bool DeadlineExceeded => _deadline.IsCancellationRequested;

        public void Dispose()
        {
            var owner = Interlocked.Exchange(ref _owner, null);
            if (owner is null)
                return;

            owner.Exit(_id);
            _lifetime.Dispose();
            _deadline.Dispose();
        }
    }
}

public readonly record struct SearchCapacitySnapshot(
    int Active,
    int Capacity,
    TimeSpan? OldestAge);

public enum SearchOperation
{
    PublicSearch,
    DebugSearch,
    TvSeason,
}
