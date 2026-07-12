// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Models/Nzb/NzbSegment.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root.

namespace Streamarr.Usenet.Nzb;

public class NzbSegment
{
    /// <summary>The yEnc-encoded size in bytes, as declared by the NZB.</summary>
    public required long Bytes { get; init; }

    /// <summary>One-based segment number within the file, as declared by the NZB.</summary>
    public required int Number { get; init; }

    /// <summary>The NNTP message-id (without angle brackets).</summary>
    public required string MessageId { get; init; }
}
