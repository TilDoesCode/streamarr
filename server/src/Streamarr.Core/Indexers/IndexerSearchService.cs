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
    IIndexerLatencyRecorder? latencyRecorder = null)
{
    private readonly TimeProvider _time = timeProvider ?? TimeProvider.System;
    private readonly ILogger _logger = logger ?? NullLogger<IndexerSearchService>.Instance;

    public async Task<IndexerSearchResult> SearchAsync(NewznabQuery query, CancellationToken cancellationToken)
    {
        var cacheKey = query.CacheKey();
        if (cache.TryGet(cacheKey, out var cached))
        {
            _logger.LogDebug("Search cache hit for {CacheKey}", cacheKey);
            return cached with { FromCache = true };
        }

        var indexers = configStore.GetEnabled();
        if (indexers.Count == 0)
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

        cache.Set(cacheKey, result);
        return result;
    }

    private async Task<IndexerResult> QueryOneAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        var started = _time.GetTimestamp();

        try
        {
            await rateLimiter.WaitAsync(indexer.Id, cancellationToken);

            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(options.PerIndexerTimeout);

            var response = await client.SearchAsync(indexer, query, timeoutCts.Token);
            var releases = response.Items
                .Select(item => ToRelease(indexer, item))
                .ToArray();

            return new IndexerResult(indexer, releases, new IndexerOutcome
            {
                IndexerId = indexer.Id,
                IndexerName = indexer.Name,
                Status = IndexerOutcomeStatus.Succeeded,
                ItemCount = releases.Length,
                Elapsed = _time.GetElapsedTime(started),
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // the whole search was cancelled by the caller — propagate.
            throw;
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning("Indexer {Indexer} timed out after {Timeout}s", indexer.Name, options.PerIndexerTimeoutSeconds);
            return Failure(indexer, IndexerOutcomeStatus.TimedOut, "Timed out", started);
        }
        catch (Exception e)
        {
            _logger.LogWarning(e, "Indexer {Indexer} failed: {Message}", indexer.Name, e.Message);
            return Failure(indexer, IndexerOutcomeStatus.Failed, e.Message, started);
        }
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
            ReleaseId = ReleaseId(indexer.Name, item.Guid),
            Title = item.Title,
            Indexer = indexer.Name,
            SizeBytes = item.SizeBytes,
            Grabs = item.Grabs,
            AgeDays = ageDays,
            NzbUrl = item.NzbUrl,
        };
    }

    /// <summary>Stable release id: sha256 of the indexer name + indexer guid (BRIEF §6.2).</summary>
    internal static string ReleaseId(string indexerName, string guid)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{indexerName}\n{guid}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private sealed record IndexerResult(IndexerConfig Indexer, IReadOnlyList<Release> Releases, IndexerOutcome Outcome);
}
