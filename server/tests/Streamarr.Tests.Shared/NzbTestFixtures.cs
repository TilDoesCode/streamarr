using System.Xml.Linq;

namespace Streamarr.Tests.Shared;

/// <summary>One file entry of a test NZB: its name and published segment ids.</summary>
public sealed record PublishedNzbFile
{
    public required string FileName { get; init; }
    public required string[] SegmentIds { get; init; }
    public required long[] SegmentEncodedBytes { get; init; }
}

/// <summary>
/// Publishes files as yEnc-split multi-part articles on a <see cref="MockNntpServer"/>
/// and builds real-shaped NZB documents referencing them — the canned-fixture path
/// mandated by DECISIONS.md until real provider credentials exist.
/// </summary>
public static class NzbTestFixtures
{
    private static readonly XNamespace Ns = "http://www.newzbin.com/DTD/2003/nzb";

    /// <summary>
    /// yEnc-encodes <paramref name="bytes"/> into <c>partSize</c>-byte articles and
    /// publishes them to the mock server. <paramref name="publishArticle"/> can veto
    /// publication per part index to simulate missing (DMCA'd/expired) articles —
    /// the segment still appears in the NZB either way, like real dead releases.
    /// </summary>
    public static PublishedNzbFile PublishFile(
        MockNntpServer server,
        string fileName,
        byte[] bytes,
        string messageIdPrefix,
        int partSize = 64_000,
        Func<int, bool>? publishArticle = null)
    {
        var totalParts = (bytes.Length + partSize - 1) / partSize;
        var ids = new string[totalParts];
        var encodedSizes = new long[totalParts];

        for (var i = 0; i < totalParts; i++)
        {
            var begin = (long)i * partSize + 1;
            var end = Math.Min(begin + partSize - 1, bytes.Length);
            var article = YencTestEncoder.EncodePart(bytes, fileName, i + 1, totalParts, begin, end);

            ids[i] = $"{messageIdPrefix}-{i + 1}@mock";
            encodedSizes[i] = article.Length;

            if (publishArticle?.Invoke(i) ?? true)
                server.Articles[ids[i]] = article;
        }

        return new PublishedNzbFile
        {
            FileName = fileName,
            SegmentIds = ids,
            SegmentEncodedBytes = encodedSizes,
        };
    }

    /// <summary>Builds an NZB document (XML string) referencing the given files.</summary>
    public static string BuildNzbXml(params PublishedNzbFile[] files)
    {
        var fileElements = files.Select((file, fileIndex) =>
            new XElement(Ns + "file",
                new XAttribute("poster", "tester <tester@example.com>"),
                new XAttribute("date", 1751000000 + fileIndex),
                new XAttribute("subject",
                    $"[{fileIndex + 1}/{files.Length}] - \"{file.FileName}\" yEnc (1/{file.SegmentIds.Length})"),
                new XElement(Ns + "groups",
                    new XElement(Ns + "group", "alt.binaries.test")),
                new XElement(Ns + "segments",
                    file.SegmentIds.Select((id, i) =>
                        new XElement(Ns + "segment",
                            new XAttribute("bytes", file.SegmentEncodedBytes[i]),
                            new XAttribute("number", i + 1),
                            id)))));

        var doc = new XDocument(
            new XDeclaration("1.0", "utf-8", null),
            new XElement(Ns + "nzb", fileElements));

        return doc.Declaration + Environment.NewLine + doc;
    }
}
