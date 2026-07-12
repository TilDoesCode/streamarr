// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Exceptions/* @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (consolidated).

namespace Streamarr.Usenet.Exceptions;

/// <summary>Base type for all Usenet/NNTP related errors.</summary>
public class UsenetException : Exception
{
    public UsenetException(string message) : base(message) { }
    public UsenetException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The NNTP server could not be reached or rejected the connection.</summary>
public class UsenetConnectionException : UsenetException
{
    public int ResponseCode { get; init; }
    public UsenetConnectionException(string message) : base(message) { }
    public UsenetConnectionException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The NNTP server sent a response we could not understand.</summary>
public class UsenetProtocolException : UsenetException
{
    public UsenetProtocolException(string message) : base(message) { }
}

/// <summary>An NNTP command was issued before a connection was established.</summary>
public class UsenetNotConnectedException : UsenetException
{
    public UsenetNotConnectedException(string message) : base(message) { }
}

/// <summary>Could not connect to the usenet host (wraps socket/TLS errors).</summary>
public class CouldNotConnectToUsenetException : UsenetException
{
    public CouldNotConnectToUsenetException(string message) : base(message) { }
    public CouldNotConnectToUsenetException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>Authentication against the usenet host failed.</summary>
public class CouldNotLoginToUsenetException : UsenetException
{
    public CouldNotLoginToUsenetException(string message) : base(message) { }
    public CouldNotLoginToUsenetException(string message, Exception inner) : base(message, inner) { }
}

/// <summary>The requested article is missing on the provider (NNTP 430).</summary>
public class UsenetArticleNotFoundException : UsenetException
{
    public string SegmentId { get; }

    public UsenetArticleNotFoundException(string segmentId)
        : base($"Usenet article <{segmentId}> was not found.")
    {
        SegmentId = segmentId;
    }
}

/// <summary>A byte position could not be mapped to a segment (corrupt yEnc offsets).</summary>
public class SeekPositionNotFoundException : UsenetException
{
    public SeekPositionNotFoundException(string message) : base(message) { }
}

/// <summary>A yEnc article failed CRC32 validation.</summary>
public class YencCrcMismatchException : UsenetException
{
    public YencCrcMismatchException(string message) : base(message) { }
}

/// <summary>The RAR archive uses a compression method other than store (m0).</summary>
public class UnsupportedRarCompressionMethodException : UsenetException
{
    public UnsupportedRarCompressionMethodException(string message) : base(message) { }
}
