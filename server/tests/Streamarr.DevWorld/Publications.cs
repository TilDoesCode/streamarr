using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld;

/// <summary>One file of one release as posted to the mock Usenet: a message-id prefix over a cached media file.</summary>
public sealed record Publication(
    string Prefix,
    string FilePath,
    string FileName,
    long FileSize,
    int PartSize,
    int TotalParts,
    IReadOnlySet<int> MissingParts,
    IReadOnlySet<int> StatDisconnectParts)
{
    public string MessageId(int part) => $"{Prefix}.{part}@devworld";
}

public sealed record PublishedRelease(PlannedRelease Plan, string NzbPath, IReadOnlyList<Publication> Files, string ReleaseId);

/// <summary>Lazy article source: parts are read and yEnc-encoded per request; dead lacks even parts, degraded drops STAT of its last part.</summary>
public sealed class PublicationStore : IMockArticleSource, IDisposable
{
    private readonly Dictionary<string, Publication> _byPrefix = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Lazy<SafeFileHandle>> _handles = new(StringComparer.Ordinal);

    public IReadOnlyList<PublishedRelease> Releases { get; }

    public PublicationStore(WorldPlan plan, IReadOnlyDictionary<string, GeneratedMedia> media, string nzbDir, int defaultPartSize)
    {
        Directory.CreateDirectory(nzbDir);
        var releases = new List<PublishedRelease>();
        foreach (var release in plan.Releases)
        {
            var files = new List<Publication>();
            for (var i = 0; i < release.Files.Count; i++)
            {
                var (planned, fileName) = release.Files[i];
                var generated = media[planned.Key];
                var partSize = release.Entry.Health == "degraded"
                    ? (int)Math.Clamp(generated.SizeBytes / 200 / 4096 * 4096, 4_096, defaultPartSize)
                    : defaultPartSize;
                var totalParts = (int)((generated.SizeBytes + partSize - 1) / partSize);
                var missing = release.Entry.Health == "dead"
                    ? Enumerable.Range(1, totalParts).Where(p => p % 2 == 0).ToHashSet()
                    : [];
                var statDisconnect = release.Entry.Health == "degraded" && totalParts > 80
                    ? new HashSet<int> { totalParts }
                    : [];
                if (release.Entry.Health == "degraded" && statDisconnect.Count == 0)
                    throw new InvalidDataException($"{release.Name}: a degraded release needs more than 80 articles.");

                var prefix = "dw" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{release.Guid}\n{i}")))[..16].ToLowerInvariant();
                var publication = new Publication(prefix, generated.Path, fileName, generated.SizeBytes, partSize, totalParts, missing, statDisconnect);
                _byPrefix[prefix] = publication;
                files.Add(publication);
            }

            if (release.Entry.RecoveryPercent is { } percent)
                files.AddRange(PublishRecovery(release, files[0], percent, defaultPartSize));

            var nzbPath = Path.Combine(nzbDir, $"{Slug(release.Name)}.nzb");
            releases.Add(new PublishedRelease(release, nzbPath, files, DevWorldIds.ReleaseId(release.Guid)));
        }

        Releases = releases;
        Parallel.ForEach(Releases, release => File.WriteAllText(
            release.NzbPath,
            NzbTestFixtures.BuildNzbXml(release.Files.Select(ToNzbFile).ToArray())));
    }

    /// <summary>A PAR2 index plus recovery volumes for the release's file (cached next to the media), so the server's repair can run against Dev World.</summary>
    private IEnumerable<Publication> PublishRecovery(PlannedRelease release, Publication media, int percent, int partSize)
    {
        var sliceSize = (int)Math.Max(65_536, (media.FileSize / 64 + 3) / 4 * 4);
        var dir = Path.Combine(Path.GetDirectoryName(media.FilePath)!, "..", "par2", $"{Path.GetFileNameWithoutExtension(media.FilePath)}-r{percent}-s{sliceSize}");
        var stem = Path.GetFileNameWithoutExtension(media.FileName);
        if (!File.Exists(Path.Combine(dir, "complete")))
        {
            Directory.CreateDirectory(dir);
            var data = File.ReadAllBytes(media.FilePath);
            var slices = (data.Length + sliceSize - 1) / sliceSize;
            var set = Par2TestWriter.Create([(media.FileName, data)], sliceSize, Math.Max(1, slices * percent / 100), recoverySlicesPerVolume: 4);
            File.WriteAllBytes(Path.Combine(dir, $"{stem}.par2"), set.IndexBytes);
            foreach (var (name, bytes) in set.Volumes)
                File.WriteAllBytes(Path.Combine(dir, $"{stem}.{name["testset.".Length..]}"), bytes);
            File.WriteAllText(Path.Combine(dir, "complete"), string.Empty);
        }
        foreach (var path in Directory.GetFiles(dir, "*.par2").Order(StringComparer.Ordinal))
        {
            var name = Path.GetFileName(path);
            var size = new FileInfo(path).Length;
            var prefix = "dw" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{release.Guid}\npar2\n{name}")))[..16].ToLowerInvariant();
            var publication = new Publication(prefix, path, name, size, partSize, (int)((size + partSize - 1) / partSize), new HashSet<int>(), new HashSet<int>());
            _byPrefix[prefix] = publication;
            yield return publication;
        }
    }

    public static bool IsRecoveryVolume(Publication file)
        => file.FileName.EndsWith(".par2", StringComparison.OrdinalIgnoreCase) && file.FileName.Contains(".vol", StringComparison.OrdinalIgnoreCase);

    /// <summary>Message-ids whose STAT must drop the connection (degraded releases).</summary>
    public IEnumerable<string> StatDisconnectIds
        => _byPrefix.Values.SelectMany(p => p.StatDisconnectParts.Select(p.MessageId));

    public bool Contains(string messageId) => Locate(messageId) is not null;

    public string? Get(string messageId)
    {
        if (Locate(messageId) is not { } hit)
            return null;
        var (publication, part) = hit;
        var begin = (long)(part - 1) * publication.PartSize;
        var length = (int)Math.Min(publication.PartSize, publication.FileSize - begin);
        var buffer = new byte[length];
        var handle = _handles.GetOrAdd(publication.FilePath, path => new Lazy<SafeFileHandle>(
            () => File.OpenHandle(path, FileMode.Open, FileAccess.Read, FileShare.Read))).Value;
        var read = 0;
        while (read < length)
        {
            var n = RandomAccess.Read(handle, buffer.AsSpan(read), begin + read);
            if (n == 0)
                throw new EndOfStreamException($"{publication.FilePath} is shorter than expected.");
            read += n;
        }

        return YencTestEncoder.EncodePartSlice(buffer, publication.FileName, part, publication.TotalParts, begin + 1, publication.FileSize);
    }

    private (Publication, int)? Locate(string messageId)
    {
        var at = messageId.IndexOf('@', StringComparison.Ordinal);
        var dot = messageId.LastIndexOf('.', at < 0 ? messageId.Length - 1 : at);
        if (at < 0 || dot < 0 || !int.TryParse(messageId.AsSpan(dot + 1, at - dot - 1), out var part))
            return null;
        if (!_byPrefix.TryGetValue(messageId[..dot], out var publication))
            return null;
        if (part < 1 || part > publication.TotalParts || publication.MissingParts.Contains(part))
            return null;
        return (publication, part);
    }

    private static PublishedNzbFile ToNzbFile(Publication publication)
    {
        var ids = new string[publication.TotalParts];
        var sizes = new long[publication.TotalParts];
        var buffer = new byte[publication.PartSize];
        using var stream = File.OpenRead(publication.FilePath);
        for (var part = 1; part <= publication.TotalParts; part++)
        {
            var length = stream.ReadAtLeast(buffer, (int)Math.Min(publication.PartSize, publication.FileSize - (long)(part - 1) * publication.PartSize));
            ids[part - 1] = publication.MessageId(part);
            sizes[part - 1] = YencTestEncoder.EncodedPartLength(
                buffer.AsSpan(0, length), publication.FileName, part, publication.TotalParts,
                (long)(part - 1) * publication.PartSize + 1, publication.FileSize);
        }

        return new PublishedNzbFile { FileName = publication.FileName, SegmentIds = ids, SegmentEncodedBytes = sizes };
    }

    public static string Slug(string name)
        => new(name.Select(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' ? c : '_').ToArray());

    public void Dispose()
    {
        foreach (var handle in _handles.Values.Where(h => h.IsValueCreated))
            handle.Value.Dispose();
    }
}

public static class DevWorldIds
{
    public const string IndexerId = "devworld";

    /// <summary>Same derivation as IndexerSearchService.ReleaseId (sha256 of indexer id + guid).</summary>
    public static string ReleaseId(string guid)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes($"{IndexerId}\n{guid}"))).ToLowerInvariant();
}
