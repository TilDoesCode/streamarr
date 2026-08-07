using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Services;

public sealed record HealthCheckResult(
    ReleaseHealth Health,
    int SampledCount,
    int ConfirmedMissingCount,
    int IndeterminateCount)
{
    public int UnavailableCount => ConfirmedMissingCount + IndeterminateCount;

    /// <summary>API status label per BRIEF §6.2 ("ready" | "degraded" | "dead").</summary>
    public string StatusLabel => Health switch
    {
        ReleaseHealth.Ready => "ready",
        ReleaseHealth.Degraded => "degraded",
        _ => "dead",
    };
}

/// <summary>Checks the startup prefix through BODY and an evenly-spread remainder through STAT.</summary>
public class HealthChecker(
    INntpClient nntpClient,
    IOptions<StreamarrOptions> options,
    ILogger<HealthChecker> logger,
    SegmentCache? segmentCache = null,
    SegmentMetadataCache? segmentMetadata = null)
{
    public async Task<HealthCheckResult> CheckAsync(IReadOnlyList<string> segmentIds, CancellationToken ct)
    {
        var o = options.Value.HealthCheck;
        var sample = SelectSamples(segmentIds, o.SampleCount, o.StartupSampleCount);
        if (sample.Count == 0)
            return new HealthCheckResult(ReleaseHealth.Dead, 0, 0, 0);
        var startupIds = segmentIds.Take(Math.Max(0, o.StartupSampleCount)).ToArray();
        var startupSet = startupIds.ToHashSet(StringComparer.Ordinal);
        var statSample = sample.Where(segmentId => !startupSet.Contains(segmentId)).ToArray();

        var confirmedMissing = 0;
        var failedChecks = 0;
        var startupVerificationFailed = false;
        var statConcurrency = Math.Min(
            Math.Max(1, o.Concurrency),
            Math.Max(1, options.Value.ConnectionBudget));
        var startupBodyConcurrency = Math.Min(
            Math.Max(1, o.StartupBodyConcurrency),
            Math.Max(1, options.Value.ConnectionBudget));
        var parallelOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = statConcurrency,
            CancellationToken = ct,
        };

        var startupTask = VerifyStartupBodiesAsync(startupIds, startupBodyConcurrency, ct);
        var statTask = Parallel.ForEachAsync(statSample, parallelOptions, async (segmentId, token) =>
        {
            try
            {
                var response = await nntpClient.StatAsync(segmentId, token).ConfigureAwait(false);
                if (!response.ArticleExists)
                    Interlocked.Increment(ref confirmedMissing);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (UsenetArticleNotFoundException)
            {
                Interlocked.Increment(ref confirmedMissing);
            }
            catch (Exception e)
            {
                logger.LogWarning(
                    "NNTP availability probe failed with {FailureType}; counting the sampled segment as indeterminate",
                    e.GetType().Name);
                Interlocked.Increment(ref failedChecks);
            }
        });

        await Task.WhenAll(statTask, startupTask).ConfigureAwait(false);
        var startup = await startupTask.ConfigureAwait(false);
        confirmedMissing += startup.ConfirmedMissingCount;
        failedChecks += startup.IndeterminateCount;
        startupVerificationFailed = startup.IndeterminateCount > 0;

        var failedRatio = (double)failedChecks / sample.Count;
        var health = confirmedMissing > 0 || startupVerificationFailed
            ? ReleaseHealth.Dead
            : failedChecks == 0
                ? ReleaseHealth.Ready
                : failedRatio >= o.DeadMissingRatio
                ? ReleaseHealth.Dead
                : ReleaseHealth.Degraded;

        return new HealthCheckResult(health, sample.Count, confirmedMissing, failedChecks);
    }

    private async Task<StartupVerificationResult> VerifyStartupBodiesAsync(
        string[] segmentIds,
        int maxConcurrency,
        CancellationToken ct)
    {
        if (segmentIds.Length == 0)
            return default;

        try
        {
            await using var stream = MultiSegmentStream.Create(
                segmentIds.AsMemory(),
                nntpClient,
                maxConcurrency,
                ct,
                segmentCache,
                options.Value.ArticleDownloadRetryCount,
                segmentMetadata: segmentMetadata);
            await stream.CopyToAsync(Stream.Null, ct).ConfigureAwait(false);
            return default;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (UsenetArticleNotFoundException)
        {
            return new StartupVerificationResult(1, 0);
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "NNTP startup BODY verification failed with {FailureType}; the release cannot be admitted",
                e.GetType().Name);
            return new StartupVerificationResult(0, 1);
        }
    }

    private readonly record struct StartupVerificationResult(
        int ConfirmedMissingCount,
        int IndeterminateCount);

    internal static IReadOnlyList<string> SelectSamples(
        IReadOnlyList<string> segmentIds,
        int evenlySpreadSamples,
        int startupSamples)
    {
        if (segmentIds.Count == 0)
            return [];

        var selected = new List<string>(Math.Min(
            segmentIds.Count,
            Math.Max(0, startupSamples) + Math.Max(0, evenlySpreadSamples)));
        var seen = new HashSet<string>(StringComparer.Ordinal);

        foreach (var segmentId in segmentIds.Take(Math.Max(0, startupSamples)))
        {
            if (seen.Add(segmentId))
                selected.Add(segmentId);
        }

        foreach (var segmentId in SampleEvenly(segmentIds, evenlySpreadSamples))
        {
            if (seen.Add(segmentId))
                selected.Add(segmentId);
        }

        return selected;
    }

    /// <summary>Evenly-spread sample including the first and last segment.</summary>
    internal static IReadOnlyList<string> SampleEvenly(IReadOnlyList<string> segmentIds, int maxSamples)
    {
        if (maxSamples <= 0 || segmentIds.Count == 0)
            return [];
        if (segmentIds.Count <= maxSamples)
            return segmentIds;
        if (maxSamples == 1)
            return [segmentIds[0]];

        var sample = new List<string>(maxSamples);
        var previousIndex = -1;
        for (var i = 0; i < maxSamples; i++)
        {
            var index = (int)Math.Round((double)i * (segmentIds.Count - 1) / (maxSamples - 1));
            if (index == previousIndex)
                continue;
            previousIndex = index;
            sample.Add(segmentIds[index]);
        }

        return sample;
    }
}
