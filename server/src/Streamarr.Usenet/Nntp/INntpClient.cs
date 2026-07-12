// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/INntpClient.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// exclusive-connection and article-caching APIs dropped (not needed for streaming M1).

using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Streams;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Nntp;

public interface INntpClient : IDisposable
{
    // core methods
    Task ConnectAsync(
        string host, int port, bool useSsl, CancellationToken cancellationToken);

    Task<NntpResponse> AuthenticateAsync(
        string user, string pass, CancellationToken cancellationToken);

    Task<NntpStatResponse> StatAsync(
        SegmentId segmentId, CancellationToken cancellationToken);

    Task<NntpHeadResponse> HeadAsync(
        SegmentId segmentId, CancellationToken cancellationToken);

    Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId, CancellationToken cancellationToken);

    Task<NntpDecodedBodyResponse> DecodedBodyAsync(
        SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken);

    Task<NntpDecodedArticleResponse> DecodedArticleAsync(
        SegmentId segmentId, CancellationToken cancellationToken);

    Task<NntpDecodedArticleResponse> DecodedArticleAsync(
        SegmentId segmentId, Action<ArticleBodyResult>? onConnectionReadyAgain, CancellationToken cancellationToken);

    Task<NntpDateResponse> DateAsync(
        CancellationToken cancellationToken);

    // helpers
    Task<YencHeader> GetYencHeadersAsync(
        string segmentId, CancellationToken ct);

    Task<long> GetFileSizeAsync(
        NzbFile file, CancellationToken ct);

    Task<NzbFileStream> GetFileStreamAsync(
        NzbFile nzbFile, int articleBufferSize, CancellationToken ct);

    NzbFileStream GetFileStream(
        NzbFile nzbFile, long fileSize, int articleBufferSize);

    NzbFileStream GetFileStream(
        string[] segmentIds, long fileSize, int articleBufferSize);

    Task CheckAllSegmentsAsync(
        IEnumerable<string> segmentIds, int concurrency, IProgress<int>? progress, CancellationToken cancellationToken);
}
