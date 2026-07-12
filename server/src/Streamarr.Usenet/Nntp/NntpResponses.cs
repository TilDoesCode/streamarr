// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Models/* @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr (consolidated + renamed).

using Streamarr.Usenet.Models;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Usenet.Nntp;

public enum NntpResponseType
{
    Unknown = 0,
    DateAndTime = 111,
    ServerReadyPostingAllowed = 200,
    ServerReadyNoPostingAllowed = 201,
    ArticleRetrievedHeadAndBodyFollow = 220,
    ArticleRetrievedHeadFollows = 221,
    ArticleRetrievedBodyFollows = 222,
    ArticleExists = 223,
    AuthenticationAccepted = 281,
    PasswordRequired = 381,
    NoGroupSelected = 412,
    CurrentArticleInvalid = 420,
    NoArticleWithThatNumber = 423,
    NoArticleWithThatMessageId = 430,
    AuthenticationRequired = 480,
    AuthenticationRejected = 481,
    AuthenticationOutOfSequence = 482,
    AccessPermanentlyForbidden = 502,
}

/// <summary>Signals whether an article body was fully retrieved once a pooled connection frees up.</summary>
public enum ArticleBodyResult
{
    Retrieved,
    NotRetrieved,
}

public record NntpResponse
{
    public required int ResponseCode { get; init; }
    public required string ResponseMessage { get; init; }

    public NntpResponseType ResponseType => Enum.IsDefined(typeof(NntpResponseType), ResponseCode)
        ? (NntpResponseType)ResponseCode
        : NntpResponseType.Unknown;

    public bool Success => ResponseCode is >= 100 and < 400;
}

public record NntpStatResponse : NntpResponse
{
    public required bool ArticleExists { get; init; }
}

public record NntpDateResponse : NntpResponse
{
    public DateTimeOffset? DateTime { get; init; }
}

public record NntpArticleHeaders
{
    public required IReadOnlyDictionary<string, string> Headers { get; init; }
}

public record NntpHeadResponse : NntpResponse
{
    public required SegmentId SegmentId { get; init; }
    public NntpArticleHeaders? ArticleHeaders { get; init; }
}

/// <summary>Raw (still yEnc-encoded, dot-unstuffed) body stream response.</summary>
public record NntpBodyResponse : NntpResponse
{
    public required SegmentId SegmentId { get; init; }
    public required Stream? Stream { get; init; }
}

public record NntpArticleResponse : NntpResponse
{
    public required SegmentId SegmentId { get; init; }
    public required NntpArticleHeaders? ArticleHeaders { get; init; }
    public required Stream? Stream { get; init; }
}

/// <summary>yEnc-decoded body stream response.</summary>
public record NntpDecodedBodyResponse : NntpResponse
{
    public required SegmentId SegmentId { get; init; }
    public required YencStream Stream { get; init; }
}

public record NntpDecodedArticleResponse : NntpResponse
{
    public required SegmentId SegmentId { get; init; }
    public required NntpArticleHeaders ArticleHeaders { get; init; }
    public required YencStream Stream { get; init; }
}
