// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Clients/Usenet/BaseNntpClient.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// renamed BaseNntpClient -> SingleConnectionNntpClient; wraps NntpConnection.

using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Nntp;

/// <summary>
/// This class has four responsibilities that differ from the underlying NntpConnection:
///   1. throw <see cref="CouldNotConnectToUsenetException"/> after any connection error.
///   2. throw <see cref="CouldNotLoginToUsenetException"/> after any login error.
///   3. Provide yEnc-decoded data for articles retrieved through article/body commands.
///   4. throw <see cref="UsenetArticleNotFoundException"/> when articles do not exist.
/// </summary>
public class SingleConnectionNntpClient : NntpClientBase
{
    private readonly NntpConnection _connection = new();

    public override async Task ConnectAsync(string host, int port, bool useSsl, CancellationToken cancellationToken)
    {
        try
        {
            await _connection.ConnectAsync(host, port, useSsl, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception e) when (!IsCancellation(e))
        {
            const string message = "Could not connect to usenet host. Check connection settings.";
            throw new CouldNotConnectToUsenetException(message, e);
        }
    }

    public override async Task<NntpResponse> AuthenticateAsync
    (
        string user,
        string pass,
        CancellationToken cancellationToken
    )
    {
        try
        {
            var response = await _connection.AuthenticateAsync(user, pass, cancellationToken).ConfigureAwait(false);
            if (!response.Success)
            {
                var message = $"Could not login to usenet host: {response.ResponseMessage}";
                throw new CouldNotLoginToUsenetException(message);
            }

            return response;
        }
        catch (Exception e) when (e is not CouldNotLoginToUsenetException && !IsCancellation(e))
        {
            throw new CouldNotLoginToUsenetException("Could not login to usenet host.", e);
        }
    }

    public override Task<NntpStatResponse> StatAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        return _connection.StatAsync(segmentId, cancellationToken);
    }

    public override async Task<NntpHeadResponse> HeadAsync(SegmentId segmentId, CancellationToken cancellationToken)
    {
        var headResponse = await _connection.HeadAsync(segmentId, cancellationToken).ConfigureAwait(false);

        if (headResponse.ResponseType != NntpResponseType.ArticleRetrievedHeadFollows)
            throw new UsenetArticleNotFoundException(segmentId);

        return headResponse;
    }

    public override Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        CancellationToken cancellationToken
    )
    {
        return DecodedBodyAsync(segmentId, onConnectionReadyAgain: null, cancellationToken);
    }

    public override async Task<NntpDecodedBodyResponse> DecodedBodyAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        var bodyResponse = await _connection
            .BodyAsync(segmentId, onConnectionReadyAgain, cancellationToken)
            .ConfigureAwait(false);

        if (bodyResponse.ResponseType != NntpResponseType.ArticleRetrievedBodyFollows)
            throw new UsenetArticleNotFoundException(segmentId);

        return new NntpDecodedBodyResponse
        {
            SegmentId = bodyResponse.SegmentId,
            ResponseCode = bodyResponse.ResponseCode,
            ResponseMessage = bodyResponse.ResponseMessage,
            Stream = new YencStream(bodyResponse.Stream!),
        };
    }

    public override Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        CancellationToken cancellationToken
    )
    {
        return DecodedArticleAsync(segmentId, onConnectionReadyAgain: null, cancellationToken);
    }

    public override async Task<NntpDecodedArticleResponse> DecodedArticleAsync
    (
        SegmentId segmentId,
        Action<ArticleBodyResult>? onConnectionReadyAgain,
        CancellationToken cancellationToken
    )
    {
        var articleResponse = await _connection
            .ArticleAsync(segmentId, onConnectionReadyAgain, cancellationToken)
            .ConfigureAwait(false);

        if (articleResponse.ResponseType != NntpResponseType.ArticleRetrievedHeadAndBodyFollow)
            throw new UsenetArticleNotFoundException(segmentId);

        return new NntpDecodedArticleResponse
        {
            SegmentId = articleResponse.SegmentId,
            ResponseCode = articleResponse.ResponseCode,
            ResponseMessage = articleResponse.ResponseMessage,
            ArticleHeaders = articleResponse.ArticleHeaders!,
            Stream = new YencStream(articleResponse.Stream!),
        };
    }

    public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
    {
        return _connection.DateAsync(cancellationToken);
    }

    internal static bool IsCancellation(Exception e) =>
        e is OperationCanceledException ||
        (e is AggregateException agg && agg.InnerExceptions.All(x => x is OperationCanceledException));

    public override void Dispose()
    {
        _connection.Dispose();
        GC.SuppressFinalize(this);
    }
}
