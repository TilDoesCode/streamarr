using System.Diagnostics;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;

namespace Streamarr.Server.Config;

/// <summary>Outcome of an indexer connectivity test (BRIEF §6.2 /config/indexers/{id}/test).</summary>
public sealed record IndexerTestResult
{
    public required bool Success { get; init; }
    public required double LatencyMs { get; init; }
    public string? ServerTitle { get; init; }
    public string? ServerVersion { get; init; }
    public int CategoryCount { get; init; }
    public bool SearchAvailable { get; init; }
    public bool MovieSearchAvailable { get; init; }
    public bool TvSearchAvailable { get; init; }
    public string? Error { get; init; }
}

/// <summary>
/// Runs a <c>t=caps</c> roundtrip against an indexer and reports the measured latency
/// (BRIEF §6.2). Used by the config API's per-indexer "Test" action.
/// </summary>
public sealed class IndexerCapsTester(INewznabClient client)
{
    public async Task<IndexerTestResult> TestAsync(IndexerConfig indexer, CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();
        try
        {
            var caps = await client.GetCapabilitiesAsync(indexer, ct);
            sw.Stop();
            return new IndexerTestResult
            {
                Success = true,
                LatencyMs = sw.Elapsed.TotalMilliseconds,
                ServerTitle = caps.ServerTitle,
                ServerVersion = caps.ServerVersion,
                CategoryCount = caps.Categories.Count,
                SearchAvailable = caps.SearchAvailable,
                MovieSearchAvailable = caps.MovieSearchAvailable,
                TvSearchAvailable = caps.TvSearchAvailable,
            };
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            sw.Stop();
            return new IndexerTestResult
            {
                Success = false,
                LatencyMs = sw.Elapsed.TotalMilliseconds,
                Error = "Indexer request failed.",
            };
        }
    }
}
