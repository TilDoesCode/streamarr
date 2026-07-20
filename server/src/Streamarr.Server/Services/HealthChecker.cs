using Microsoft.Extensions.Options;
using Streamarr.Core.Media;
using Streamarr.Server.Options;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Services;

public sealed record HealthCheckResult(ReleaseHealth Health, int SampledCount, int MissingCount)
{
    /// <summary>API status label per BRIEF §6.2 ("ready" | "degraded" | "dead").</summary>
    public string StatusLabel => Health switch
    {
        ReleaseHealth.Ready => "ready",
        ReleaseHealth.Degraded => "degraded",
        _ => "dead",
    };
}

/// <summary>
/// Verifies article availability via NNTP STAT (223 = present, 430 = missing) on
/// an evenly-spread sample of the primary media file's segments — never par2 —
/// and classifies ready / degraded / dead (BRIEF §6.1 module 5).
/// </summary>
public class HealthChecker(INntpClient nntpClient, IOptions<StreamarrOptions> options, ILogger<HealthChecker> logger)
{
    public async Task<HealthCheckResult> CheckAsync(IReadOnlyList<string> segmentIds, CancellationToken ct)
    {
        var o = options.Value.HealthCheck;
        var sample = SampleEvenly(segmentIds, o.SampleCount);
        if (sample.Count == 0)
            return new HealthCheckResult(ReleaseHealth.Dead, 0, 0);

        var missing = 0;
        var parallelOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = Math.Min(
                Math.Max(1, o.Concurrency),
                Math.Max(1, options.Value.ConnectionBudget)),
            CancellationToken = ct,
        };

        await Parallel.ForEachAsync(sample, parallelOptions, async (segmentId, token) =>
        {
            try
            {
                var response = await nntpClient.StatAsync(segmentId, token);
                if (!response.ArticleExists)
                    Interlocked.Increment(ref missing);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (Exception e)
            {
                // a segment we cannot STAT is a segment we cannot stream
                logger.LogWarning(
                    "NNTP STAT failed with {FailureType}; counting the sampled segment as missing",
                    e.GetType().Name);
                Interlocked.Increment(ref missing);
            }
        });

        var missingRatio = (double)missing / sample.Count;
        var health = missing == 0
            ? ReleaseHealth.Ready
            : missingRatio >= o.DeadMissingRatio
                ? ReleaseHealth.Dead
                : ReleaseHealth.Degraded;

        return new HealthCheckResult(health, sample.Count, missing);
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
