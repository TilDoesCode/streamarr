using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Minimal in-memory INntpClient for unit tests: STAT answers from a set of
/// known segment ids; everything else is unsupported.
/// </summary>
public sealed class FakeNntpClient(IEnumerable<string>? existingSegments = null) : NntpClientBase
{
    private int _activeStats;
    private int _maxConcurrentStats;
    public HashSet<string> ExistingSegments { get; } = new(existingSegments ?? [], StringComparer.Ordinal);
    public List<string> StattedSegments { get; } = [];
    public NntpResponse AuthenticationResponse { get; set; } = new()
    {
        ResponseCode = 281,
        ResponseMessage = "281 authentication accepted",
    };
    public TimeSpan StatDelay { get; set; }
    public int MaxConcurrentStats => Volatile.Read(ref _maxConcurrentStats);

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
        => Task.CompletedTask;

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken)
        => Task.FromResult(AuthenticationResponse);

    public override async Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        var active = Interlocked.Increment(ref _activeStats);
        UpdateMax(ref _maxConcurrentStats, active);
        try
        {
            if (StatDelay > TimeSpan.Zero)
                await Task.Delay(StatDelay, cancellationToken);
        lock (StattedSegments)
        {
            StattedSegments.Add(segmentId);
        }

        var exists = ExistingSegments.Contains(segmentId);
        return new NntpStatResponse
        {
            ResponseCode = exists ? 223 : 430,
            ResponseMessage = exists ? "223 exists" : "430 no such article",
            ArticleExists = exists,
        };
        }
        finally
        {
            Interlocked.Decrement(ref _activeStats);
        }
    }

    private static void UpdateMax(ref int location, int value)
    {
        var current = Volatile.Read(ref location);
        while (value > current)
        {
            var observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current) return;
            current = observed;
        }
    }

    public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
        SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
        => throw new NotSupportedException();

    public override void Dispose()
    {
    }
}
