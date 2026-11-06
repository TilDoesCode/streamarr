using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Server.Services;

/// <summary>
/// Marks the async flow of a device-download preparation (resolve, materialization, health check): its NNTP commands go through the
/// download connection share at low priority, and its resolves leave a slot for live playback.
/// </summary>
public static class DownloadPreparation
{
    private static readonly AsyncLocal<bool> Flag = new();

    public static bool Active => Flag.Value;

    public static IDisposable Enter()
    {
        var prior = Flag.Value;
        Flag.Value = true;
        return new Scope(prior);
    }

    private sealed class Scope(bool prior) : IDisposable
    {
        public void Dispose() => Flag.Value = prior;
    }
}

/// <summary>The shared NNTP client: playback's gated client, or the download client inside a <see cref="DownloadPreparation"/> flow.</summary>
public sealed class PreparationAwareNntpClient(INntpClient playback, Func<INntpClient?> download) : NntpClientBase
{
    private INntpClient Current => DownloadPreparation.Active && download() is { } preparation ? preparation : playback;

    public override Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
        => throw new NotSupportedException("Please connect within the connectionFactory");

    public override Task<NntpResponse> AuthenticateAsync(string user, string pass, CancellationToken cancellationToken)
        => throw new NotSupportedException("Please authenticate within the connectionFactory");

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken ct) => Current.StatAsync(segmentId, ct);

    public override Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken ct) => Current.HeadAsync(segmentId, ct);

    public override Task<NntpDateResponse> DateAsync(CancellationToken ct) => Current.DateAsync(ct);

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, CancellationToken ct) => Current.DecodedBodyAsync(segmentId, ct);

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken ct)
        => Current.DecodedBodyAsync(segmentId, onConnectionReadyAgain, ct);

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, CancellationToken ct) => Current.DecodedArticleAsync(segmentId, ct);

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken ct)
        => Current.DecodedArticleAsync(segmentId, onConnectionReadyAgain, ct);

    public override void Dispose() => playback.Dispose();
}
