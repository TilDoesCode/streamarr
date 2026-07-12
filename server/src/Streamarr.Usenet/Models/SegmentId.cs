// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Models/SegmentId.cs @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr.

namespace Streamarr.Usenet.Models;

/// <summary>
/// An NZB segment id / NNTP message-id, normalized without angle brackets.
/// </summary>
public readonly struct SegmentId(string? value)
{
    private readonly string _value = value ?? string.Empty;

    public ReadOnlySpan<char> Value
    {
        get
        {
            if (string.IsNullOrEmpty(_value))
                return ReadOnlySpan<char>.Empty;

            var span = _value.AsSpan();

            // Remove leading '<' if present
            if (span.Length > 0 && span[0] == '<')
                span = span[1..];

            // Remove trailing '>' if present
            if (span.Length > 0 && span[^1] == '>')
                span = span[..^1];

            return span;
        }
    }

    public static implicit operator SegmentId(string value) => new(value);

    public static implicit operator string(SegmentId segmentId)
    {
        var value = segmentId.Value;
        return value.IsEmpty ? string.Empty : new string(value);
    }

    public override string ToString()
    {
        var value = Value;
        return value.IsEmpty ? string.Empty : new string(value);
    }
}
