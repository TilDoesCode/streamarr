// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Models/Nzb/NzbFile.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (groups/poster/date kept).

using System.Text.RegularExpressions;

namespace Streamarr.Usenet.Nzb;

public partial class NzbFile
{
    public required string Subject { get; init; }
    public string? Poster { get; init; }
    public DateTimeOffset? Date { get; init; }
    public List<string> Groups { get; } = [];
    public List<NzbSegment> Segments { get; } = [];

    public string[] GetSegmentIds()
    {
        return Segments
            .Select(x => x.MessageId)
            .ToArray();
    }

    public long GetTotalYencodedSize()
    {
        return Segments
            .Select(x => x.Bytes)
            .Sum();
    }

    public string GetSubjectFileName()
    {
        return GetFirstValidNonEmptyFilename(
            TryParseSubjectFilename1,
            TryParseSubjectFilename2
        );
    }

    private string TryParseSubjectFilename1()
    {
        // The most common format is when filename appears in double quotes
        // example: `[1/8] - "file.mkv" yEnc 12345 (1/54321)`
        var match = QuotedFilenameRegex().Match(Subject);
        return match.Success ? match.Groups[1].Value : "";
    }

    private string TryParseSubjectFilename2()
    {
        // Otherwise, use sabnzbd's regex
        // https://github.com/sabnzbd/sabnzbd/blob/b6b0d10367fd4960bad73edd1d3812cafa7fc002/sabnzbd/nzbstuff.py#L106
        var match = SabnzbdFilenameRegex().Match(Subject);
        return match.Success ? match.Groups[1].Value : "";
    }

    private static string GetFirstValidNonEmptyFilename(params Func<string>[] funcs)
    {
        return funcs
            .Select(x => x.Invoke())
            .Where(x => x == Path.GetFileName(x))
            .FirstOrDefault(x => x != "") ?? "";
    }

    [GeneratedRegex("\\\"(.*)\\\"")]
    private static partial Regex QuotedFilenameRegex();

    [GeneratedRegex(@"\b([\w\-+()' .,]+(?:\[[\w\-\/+()' .,]*][\w\-+()' .,]*)*\.[A-Za-z0-9]{2,4})\b")]
    private static partial Regex SabnzbdFilenameRegex();
}
