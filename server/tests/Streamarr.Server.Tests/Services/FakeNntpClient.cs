using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Yenc;
using Streamarr.Tests.Shared;

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
    public HashSet<string> FailingSegments { get; } = new(StringComparer.Ordinal);
    public HashSet<string> MissingBodySegments { get; } = new(StringComparer.Ordinal);
    public HashSet<string> FailingBodySegments { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, string> BodyOverrides { get; } = new(StringComparer.Ordinal);
    public List<string> StattedSegments { get; } = [];
    public List<string> BodyRequestedSegments { get; } = [];
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

            if (FailingSegments.Contains(segmentId))
                throw new IOException("simulated STAT failure");

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
        => DecodedBodyAsync(segmentId, onConnectionReadyAgain: null, cancellationToken);

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken)
    {
        lock (BodyRequestedSegments)
        {
            BodyRequestedSegments.Add(segmentId);
        }
        if (MissingBodySegments.Contains(segmentId))
            throw new UsenetArticleNotFoundException(segmentId);
        if (FailingBodySegments.Contains(segmentId))
            throw new IOException("simulated BODY failure");
        if (!ExistingSegments.Contains(segmentId))
            throw new UsenetArticleNotFoundException(segmentId);

        onConnectionReadyAgain?.Invoke(ArticleBodyResult.Retrieved);
        var encodedBody = BodyOverrides.TryGetValue(segmentId, out var body)
            ? body
            : YencTestEncoder.Encode(System.Text.Encoding.ASCII.GetBytes($"body:{segmentId}"), "body.bin");
        return Task.FromResult(new NntpDecodedBodyResponse
        {
            SegmentId = segmentId,
            ResponseCode = 222,
            ResponseMessage = "222 body follows",
            Stream = new YencStream(new MemoryStream(System.Text.Encoding.Latin1.GetBytes(encodedBody))),
        });
    }

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
