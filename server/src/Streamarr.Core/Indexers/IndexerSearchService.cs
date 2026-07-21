using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;

namespace Streamarr.Core.Indexers;

/// <summary>
/// The Prowlarr role (BRIEF §6.1 module 1): fans a query out concurrently to every
/// enabled indexer with a per-indexer timeout and full error isolation (one dead
/// indexer never fails the search), rate-limits per indexer, dedupes results by
/// normalized title + size, and serves repeats from a short-lived cache.
/// </summary>
public sealed class IndexerSearchService(
    IIndexerConfigStore configStore,
    INewznabClient client,
    IIndexerRateLimiter rateLimiter,
    SearchCache cache,
    IndexerSearchOptions options,
    TimeProvider? timeProvider = null,
    ILogger<IndexerSearchService>? logger = null,
    IIndexerLatencyRecorder? latencyRecorder = null,
    Func<TimeSpan, CancellationToken, Task>? retryDelay = null)
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ILogger _logger = logger ?? NullLogger<IndexerSearchService>.Instance;
    private readonly SemaphoreSlim _requestGate = new(Math.Max(1, options.MaxConcurrentIndexerRequests));
    private readonly Func<TimeSpan, CancellationToken, Task> _delay =
        retryDelay ?? ((delay, ct) => Task.Delay(delay, ct));

    public async Task<IndexerSearchResult> SearchAsync(NewznabQuery query, CancellationToken cancellationToken)
    {
        var cacheKey = query.CacheKey();
        if (cache.TryGet(cacheKey, out var cached))
        {
            _logger.LogDebug("Search cache hit");
            return cached with { FromCache = true };
        }

        var indexers = configStore.GetEnabled()
            .Take(Math.Max(1, options.MaxIndexersPerSearch))
            .ToArray();
        if (indexers.Length == 0)
            return IndexerSearchResult.Empty;

        var effectiveQuery = query.Limit is null
            ? query with { Limit = options.DefaultLimit }
            : query;

        // Fan out; each task is fully isolated and never throws (except on caller
        // cancellation) so a single failure can't abort Task.WhenAll.
        var tasks = indexers
            .Select(indexer => QueryOneAsync(indexer, effectiveQuery, cancellationToken))
            .ToArray();

        var perIndexer = await Task.WhenAll(tasks);

        foreach (var r in perIndexer)
        {
            latencyRecorder?.Record(
                r.Outcome.IndexerId,
                r.Outcome.IndexerName,
                r.Outcome.Elapsed.TotalMilliseconds,
                r.Outcome.Status == IndexerOutcomeStatus.Succeeded);
        }

        var releases = Dedupe(perIndexer);
        var result = new IndexerSearchResult
        {
            Releases = releases,
            Outcomes = perIndexer.Select(r => r.Outcome).ToArray(),
        };

        // A partial fan-out is useful to this caller, but caching it would turn a transient
        // outage into a deterministic miss for the full cache TTL. Only cache complete runs.
        if (result.Outcomes.All(outcome => outcome.Succeeded))
            cache.Set(cacheKey, result);
        return result;
    }

    private async Task<IndexerResult> QueryOneAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        var started = _time.GetTimestamp();
        var maxAttempts = 1 + options.TransientRetryCount;
        for (var attempt = 1; ; attempt++)
        {
            try
            {
                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                timeoutCts.CancelAfter(options.PerIndexerTimeout);
                await rateLimiter.WaitAsync(indexer.Id, timeoutCts.Token);
                await _requestGate.WaitAsync(timeoutCts.Token);

                IReadOnlyList<Release> releases;
                try
                {
                    var response = await client.SearchAsync(indexer, query, timeoutCts.Token);
                    releases = response.Items
                        .Select(item => ToRelease(indexer, item))
                        .ToArray();
                }
                finally
                {
                    _requestGate.Release();
                }

                return new IndexerResult(indexer, releases, new IndexerOutcome
                {
                    IndexerId = indexer.Id,
                    IndexerName = indexer.Name,
                    Status = IndexerOutcomeStatus.Succeeded,
                    ItemCount = releases.Count,
                    Elapsed = _time.GetElapsedTime(started),
                });
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (OperationCanceledException) when (attempt < maxAttempts)
            {
                await WaitToRetryAsync(indexer, attempt, maxAttempts, "timeout", null, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("Indexer {Indexer} timed out after {Attempts} attempt(s)", indexer.Name, attempt);
                return Failure(indexer, IndexerOutcomeStatus.TimedOut, "Timed out", started);
            }
            catch (NewznabRequestException e) when (e.IsTransient && attempt < maxAttempts)
            {
                await WaitToRetryAsync(
                    indexer,
                    attempt,
                    maxAttempts,
                    e.GetType().Name,
                    e.RetryAfter,
                    cancellationToken);
            }
            catch (Exception e)
            {
                // Transport exception messages can contain the full Newznab URL, including
                // its API-key query parameter. Retain only the non-sensitive failure type.
                _logger.LogWarning(
                    "Indexer {Indexer} failed after {Attempts} attempt(s) with {FailureType}",
                    indexer.Name,
                    attempt,
                    e.GetType().Name);
                return Failure(indexer, IndexerOutcomeStatus.Failed, "Indexer request failed", started);
            }
        }
    }

    private async Task WaitToRetryAsync(
        IndexerConfig indexer,
        int attempt,
        int maxAttempts,
        string failureType,
        TimeSpan? retryAfter,
        CancellationToken cancellationToken)
    {
        var capMs = options.RetryMaxDelay.TotalMilliseconds;
        var exponentialMs = options.RetryBaseDelay.TotalMilliseconds * Math.Pow(2, attempt - 1);
        var jitteredMs = exponentialMs * (0.8 + Random.Shared.NextDouble() * 0.4);
        var requestedMs = retryAfter is { } advertised && advertised > TimeSpan.Zero
            ? advertised.TotalMilliseconds
            : jitteredMs;
        var delay = TimeSpan.FromMilliseconds(Math.Min(requestedMs, capMs));
        _logger.LogDebug(
            "Indexer {Indexer} transient {FailureType}; retrying (attempt {Attempt}/{Max}) after {DelayMs} ms",
            indexer.Name,
            failureType,
            attempt,
            maxAttempts,
            (int)delay.TotalMilliseconds);
        await _delay(delay, cancellationToken);
    }

    private IndexerResult Failure(IndexerConfig indexer, IndexerOutcomeStatus status, string error, long started)
        => new(indexer, [], new IndexerOutcome
        {
            IndexerId = indexer.Id,
            IndexerName = indexer.Name,
            Status = status,
            ItemCount = 0,
            Elapsed = _time.GetElapsedTime(started),
            Error = error,
        });

    /// <summary>
    /// Dedupe by normalized title + size, keeping the copy from the highest-priority
    /// indexer (results already arrive in priority order). Ties on title+size across
    /// indexers collapse to one release (BRIEF §6.1).
    /// </summary>
    private static IReadOnlyList<Release> Dedupe(IReadOnlyList<IndexerResult> perIndexer)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<Release>();

        foreach (var indexerResult in perIndexer)
        {
            foreach (var release in indexerResult.Releases)
            {
                var key = $"{NewznabQuery.NormalizeTerm(release.Title)}|{release.SizeBytes}";
                if (seen.Add(key))
                    result.Add(release);
            }
        }

        return result;
    }

    private Release ToRelease(IndexerConfig indexer, NewznabItem item)
    {
        var postedAt = item.UsenetDate ?? item.PublishDate;
        var ageDays = postedAt is { } posted
            ? Math.Max(0, (int)(_time.GetUtcNow() - posted).TotalDays)
            : 0;

        return new Release
        {
            ReleaseId = ReleaseId(indexer.Id, item.Guid),
            Title = item.Title,
            Indexer = indexer.Name,
            IndexerId = indexer.Id,
            SizeBytes = item.SizeBytes,
            Grabs = item.Grabs,
            AgeDays = ageDays,
            NzbUrl = item.NzbUrl,
        };
    }

    /// <summary>Stable release id: sha256 of the config id + indexer guid (BRIEF §6.2).</summary>
    internal static string ReleaseId(string indexerId, string guid)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{indexerId}\n{guid}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private sealed record IndexerResult(IndexerConfig Indexer, IReadOnlyList<Release> Releases, IndexerOutcome Outcome);
}
