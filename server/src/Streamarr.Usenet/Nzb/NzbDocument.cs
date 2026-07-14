// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Models/Nzb/NzbDocument.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// also parses file attributes (poster/date), groups, and segment number/bytes.

using System.Xml;
using System.Globalization;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Nzb;

public class NzbDocument
{
    private static readonly XmlReaderSettings XmlSettings = new()
    {
        Async = true,
        // Standard NZBs commonly include the public NZB DTD declaration. Ignore the
        // declaration while keeping XmlResolver null so no external entity is fetched.
        DtdProcessing = DtdProcessing.Ignore,
        XmlResolver = null,
        MaxCharactersFromEntities = 0,
    };

    public Dictionary<string, string> Metadata { get; } = new();

    public List<NzbFile> Files { get; } = [];

    public static async Task<NzbDocument> LoadAsync(
        Stream stream,
        CancellationToken cancellationToken = default,
        NzbDocumentLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(stream);
        limits ??= NzbDocumentLimits.Default;
        limits.Validate();

        try
        {
            var document = new NzbDocument();
            using var reader = XmlReader.Create(stream, XmlSettings);
            var totalSegments = 0;

            while (await reader.ReadAsync().ConfigureAwait(false))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (reader.NodeType != XmlNodeType.Element) continue;
                switch (reader.LocalName)
                {
                    case "head":
                        await ReadHeadAsync(reader, document.Metadata, limits, cancellationToken).ConfigureAwait(false);
                        break;
                    case "file":
                        if (document.Files.Count >= limits.MaxFiles)
                            throw new InvalidDataException($"The NZB exceeds the {limits.MaxFiles} file limit.");
                        var file = await ReadFileAsync(reader, limits, cancellationToken).ConfigureAwait(false);
                        totalSegments = checked(totalSegments + file.Segments.Count);
                        if (totalSegments > limits.MaxSegments)
                            throw new InvalidDataException($"The NZB exceeds the {limits.MaxSegments} segment limit.");
                        document.Files.Add(file);
                        break;
                }
            }

            return document;
        }
        catch (XmlException e)
        {
            throw new InvalidDataException("Could not parse the nzb document (malformed nzb)", e);
        }
    }

    private static async Task ReadHeadAsync(
        XmlReader reader,
        Dictionary<string, string> metadata,
        NzbDocumentLimits limits,
        CancellationToken ct)
    {
        if (reader.IsEmptyElement)
            return;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (reader is { NodeType: XmlNodeType.EndElement, LocalName: "head" })
                break;

            if (reader is { NodeType: XmlNodeType.Element, LocalName: "meta" })
            {
                var type = reader.GetAttribute("type") ?? string.Empty;
                var value = await reader.ReadElementContentAsStringAsync().ConfigureAwait(false);
                if (metadata.Count >= limits.MaxMetadataEntries && !metadata.ContainsKey(type))
                    throw new InvalidDataException($"The NZB exceeds the {limits.MaxMetadataEntries} metadata-entry limit.");
                if (type.Length > limits.MaxTextLength || value.Length > limits.MaxTextLength)
                    throw new InvalidDataException("The NZB contains an oversized metadata value.");
                metadata[type] = value;

                // ReadElementContentAsStringAsync advances the reader - continue to check current position
                continue;
            }

            // Only read if we haven't processed an element that advanced us
            if (!await reader.ReadAsync().ConfigureAwait(false))
                break;
        }
    }

    private static async Task<NzbFile> ReadFileAsync(XmlReader reader, NzbDocumentLimits limits, CancellationToken ct)
    {
        DateTimeOffset? date = null;
        var dateAttr = reader.GetAttribute("date");
        if (long.TryParse(dateAttr, NumberStyles.Integer, CultureInfo.InvariantCulture, out var unixSeconds))
        {
            if (unixSeconds is < -62_135_596_800 or > 253_402_300_799)
                throw new InvalidDataException("The NZB contains an invalid file date.");
            date = DateTimeOffset.FromUnixTimeSeconds(unixSeconds);
        }

        var subject = reader.GetAttribute("subject") ?? string.Empty;
        var poster = reader.GetAttribute("poster");
        if (subject.Length > limits.MaxTextLength || poster?.Length > limits.MaxTextLength)
            throw new InvalidDataException("The NZB contains an oversized file attribute.");

        var file = new NzbFile
        {
            Subject = subject,
            Poster = poster,
            Date = date,
        };

        if (reader.IsEmptyElement)
            return file;

        while (await reader.ReadAsync().ConfigureAwait(false))
        {
            ct.ThrowIfCancellationRequested();
            if (reader is { NodeType: XmlNodeType.EndElement, LocalName: "file" })
                break;

            if (reader is { NodeType: XmlNodeType.Element, LocalName: "segments" })
            {
                await ReadSegmentsAsync(reader, file, limits, ct).ConfigureAwait(false);
            }
            else if (reader is { NodeType: XmlNodeType.Element, LocalName: "groups" })
            {
                await ReadGroupsAsync(reader, file, limits, ct).ConfigureAwait(false);
            }
        }

        if (file.Segments.Count > 0)
        {
            if (file.Segments.Select(s => s.Number).Distinct().Count() != file.Segments.Count)
                throw new InvalidDataException("The NZB file contains duplicate segment numbers.");
            file.Segments.Sort((a, b) => a.Number.CompareTo(b.Number));
            for (var i = 0; i < file.Segments.Count; i++)
            {
                if (file.Segments[i].Number != i + 1)
                    throw new InvalidDataException("The NZB file segment numbers must be contiguous and start at 1.");
            }
        }

        return file;
    }

    private static async Task ReadGroupsAsync(XmlReader reader, NzbFile file, NzbDocumentLimits limits, CancellationToken ct)
    {
        if (reader.IsEmptyElement)
            return;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (reader is { NodeType: XmlNodeType.EndElement, LocalName: "groups" })
                break;

            if (reader is { NodeType: XmlNodeType.Element, LocalName: "group" })
            {
                var group = await reader.ReadElementContentAsStringAsync().ConfigureAwait(false);
                group = group.Trim();
                if (file.Groups.Count >= limits.MaxGroupsPerFile)
                    throw new InvalidDataException($"An NZB file exceeds the {limits.MaxGroupsPerFile} group limit.");
                if (group.Length > limits.MaxTextLength)
                    throw new InvalidDataException("The NZB contains an oversized group name.");
                file.Groups.Add(group);
                continue;
            }

            if (!await reader.ReadAsync().ConfigureAwait(false))
                break;
        }
    }

    private static async Task ReadSegmentsAsync(XmlReader reader, NzbFile file, NzbDocumentLimits limits, CancellationToken ct)
    {
        if (reader.IsEmptyElement)
            return;

        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (reader is { NodeType: XmlNodeType.EndElement, LocalName: "segments" })
                break;

            if (reader is { NodeType: XmlNodeType.Element, LocalName: "segment" })
            {
                var bytesAttr = reader.GetAttribute("bytes");
                var numberAttr = reader.GetAttribute("number");
                if (file.Segments.Count >= limits.MaxSegmentsPerFile)
                    throw new InvalidDataException($"An NZB file exceeds the {limits.MaxSegmentsPerFile} segment limit.");

                var messageIdText = await reader.ReadElementContentAsStringAsync().ConfigureAwait(false);
                string messageId;
                try
                {
                    messageId = SegmentId.Normalize(messageIdText.Trim());
                }
                catch (ArgumentException e)
                {
                    throw new InvalidDataException("The NZB contains an invalid or unsafe message-id.", e);
                }

                if (!long.TryParse(bytesAttr, NumberStyles.None, CultureInfo.InvariantCulture, out var bytes) ||
                    bytes is < 1 or > 1024L * 1024 * 1024 ||
                    !int.TryParse(numberAttr, NumberStyles.None, CultureInfo.InvariantCulture, out var number) ||
                    number is < 1 or > 5_000_000)
                {
                    throw new InvalidDataException("The NZB contains invalid segment size or number fields.");
                }

                var segment = new NzbSegment
                {
                    Bytes = bytes,
                    Number = number,
                    MessageId = messageId,
                };
                file.Segments.Add(segment);

                // ReadElementContentAsStringAsync advances the reader - continue to check current position
                continue;
            }

            // Only read if we haven't processed an element that advanced us
            if (!await reader.ReadAsync().ConfigureAwait(false))
                break;
        }
    }
}

/// <summary>Hard parsing limits for untrusted NZB XML.</summary>
public sealed record NzbDocumentLimits
{
    public static NzbDocumentLimits Default { get; } = new();

    public int MaxFiles { get; init; } = 10_000;
    public int MaxSegments { get; init; } = 1_000_000;
    public int MaxSegmentsPerFile { get; init; } = 250_000;
    public int MaxGroupsPerFile { get; init; } = 100;
    public int MaxMetadataEntries { get; init; } = 100;
    public int MaxTextLength { get; init; } = 16_384;

    internal void Validate()
    {
        if (MaxFiles <= 0 || MaxSegments <= 0 || MaxSegmentsPerFile <= 0 ||
            MaxGroupsPerFile <= 0 || MaxMetadataEntries <= 0 || MaxTextLength <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(NzbDocumentLimits), "All NZB limits must be positive.");
        }
    }
}
