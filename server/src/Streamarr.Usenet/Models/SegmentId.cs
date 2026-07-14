// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Models/SegmentId.cs @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root. Modified for Streamarr.

namespace Streamarr.Usenet.Models;

/// <summary>
/// An NZB segment id / NNTP message-id, normalized without angle brackets.
/// </summary>
public readonly struct SegmentId
{
    private const int MaxLength = 998;
    private readonly string? _value;

    public SegmentId(string? value)
    {
        _value = Normalize(value);
    }

    public ReadOnlySpan<char> Value
    {
        get
        {
            if (string.IsNullOrEmpty(_value))
                return ReadOnlySpan<char>.Empty;
            return _value.AsSpan();
        }
    }

    /// <summary>
    /// Normalizes one optional pair of surrounding angle brackets and rejects any
    /// value that could escape the NNTP command argument. Message IDs are ASCII,
    /// contain exactly one logical <c>@</c>-separated address, and never contain
    /// whitespace, control characters, or nested angle brackets.
    /// </summary>
    public static string Normalize(string? value)
    {
        if (string.IsNullOrEmpty(value))
            throw new ArgumentException("An NNTP message-id is required.", nameof(value));

        var candidate = value;
        if (candidate.Length >= 2 && candidate[0] == '<' && candidate[^1] == '>')
            candidate = candidate[1..^1];

        if (candidate.Length is 0 or > MaxLength ||
            candidate.IndexOf('@') <= 0 ||
            candidate.LastIndexOf('@') != candidate.IndexOf('@') ||
            candidate.LastIndexOf('@') >= candidate.Length - 1)
        {
            throw new ArgumentException("The NNTP message-id is invalid.", nameof(value));
        }

        foreach (var c in candidate)
        {
            // RFC message-ids are printable ASCII and angle brackets are delimiters,
            // not part of the id. This also excludes CR/LF and every whitespace form.
            if (c is < '!' or > '~' or '<' or '>')
                throw new ArgumentException("The NNTP message-id contains unsafe characters.", nameof(value));
        }

        return candidate;
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
