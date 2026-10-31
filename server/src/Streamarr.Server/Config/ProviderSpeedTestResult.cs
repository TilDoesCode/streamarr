namespace Streamarr.Server.Config;

/// <summary>Real NNTP payload-throughput result translated into video-streaming headroom.</summary>
public sealed record ProviderSpeedTestResult
{
    public required bool Success { get; init; }
    public required double MegabitsPerSecond { get; init; }
    public required double MegabytesPerSecond { get; init; }
    public required long BytesDownloaded { get; init; }
    public required int DurationMilliseconds { get; init; }
    public required int SetupMilliseconds { get; init; }
    public required int FirstByteMilliseconds { get; init; }
    public required int ConnectionsUsed { get; init; }

    /// <summary>The provider's configured maximum; the test only uses what is free of it.</summary>
    public required int RequestedConnections { get; init; }

    /// <summary>Connections the test was allowed to borrow (free ones, minus a reserve for active streams).</summary>
    public required int ConnectionsGranted { get; init; }

    /// <summary>Connections of the maximum that were not free (busy in the live pool, or open through another entry on the same account).</summary>
    public required int ConnectionsInUse { get; init; }

    /// <summary>Streams that were playing when the test started.</summary>
    public required int ActiveStreams { get; init; }

    /// <summary>Why fewer connections than requested were used (when none were free, <c>error</c> says the same).</summary>
    public string? Notice { get; init; }

    public required double RecommendedVideoBitrateMbps { get; init; }
    public required int Estimated4KStreams { get; init; }
    public required int Estimated1080pStreams { get; init; }

    /// <summary>One of insufficient, sd, 720p, 1080p, or 4k.</summary>
    public required string StreamingTier { get; init; }

    /// <summary>Where the article came from: <c>manual</c> (supplied by the operator), <c>recent-stream</c> (this provider recently served it to a stream), <c>recent-nzb</c> (a recently cached NZB), <c>newsgroup</c> (test group discovery) or <c>automatic</c> (none found).</summary>
    public required string ArticleSource { get; init; }
    public string? Error { get; init; }
}
