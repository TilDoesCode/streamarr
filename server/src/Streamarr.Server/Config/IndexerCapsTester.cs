using System.Diagnostics;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
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

    /// <summary>Diagnostics only: <c>timeout</c>, <c>auth_failed</c>, <c>http_error</c>, <c>invalid_response</c> or <c>unreachable</c>.</summary>
    [JsonIgnore]
    public string? ErrorCode { get; init; }

    /// <summary>Diagnostics only: the indexer error message (names the indexer and HTTP status, never the URL or key).</summary>
    [JsonIgnore]
    public string? ErrorDetail { get; init; }
}

/// <summary>
/// Runs a <c>t=caps</c> roundtrip against an indexer and reports the measured latency
/// (BRIEF §6.2). Used by the config API's per-indexer "Test" action.
/// </summary>
public sealed partial class IndexerCapsTester(INewznabClient client)
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
                ErrorCode = Classify(e),
                ErrorDetail = e is NewznabException ? e.Message : e.GetType().Name,
            };
        }
    }

    private static string Classify(Exception e)
    {
        if (e is OperationCanceledException or TimeoutException || e.Message.Contains("timed out", StringComparison.OrdinalIgnoreCase))
            return "timeout";
        if (e is NewznabParseException)
            return "invalid_response";
        if (e is NewznabRequestException request)
        {
            var status = HttpStatus().Match(request.Message);
            if (status.Success)
                return status.Groups[1].Value is "401" or "403" ? "auth_failed" : "http_error";
            if (request.Message.StartsWith("Newznab error 1", StringComparison.Ordinal))
                return "auth_failed";
            if (request.Message.StartsWith("Newznab error", StringComparison.Ordinal))
                return "http_error";
        }
        return "unreachable";
    }

    [GeneratedRegex(@"returned HTTP (\d{3})")]
    private static partial Regex HttpStatus();
}
