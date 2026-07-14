using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Minimal in-memory INntpClient for unit tests: STAT answers from a set of
/// known segment ids; everything else is unsupported.
/// </summary>
public sealed class FakeNntpClient(IEnumerable<string>? existingSegments = null) : NntpClientBase
{
    public HashSet<string> ExistingSegments { get; } = new(existingSegments ?? [], StringComparer.Ordinal);
    public List<string> StattedSegments { get; } = [];
    public NntpResponse AuthenticationResponse { get; set; } = new()
    {
        ResponseCode = 281,
        ResponseMessage = "281 authentication accepted",
    };

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
        => Task.CompletedTask;

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken)
        => Task.FromResult(AuthenticationResponse);

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        lock (StattedSegments)
        {
            StattedSegments.Add(segmentId);
        }

        var exists = ExistingSegments.Contains(segmentId);
        return Task.FromResult(new NntpStatResponse
        {
            ResponseCode = exists ? 223 : 430,
            ResponseMessage = exists ? "223 exists" : "430 no such article",
            ArticleExists = exists,
        });
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
