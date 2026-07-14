using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Rar;
using Streamarr.Usenet.Streams;

namespace Streamarr.Server.Services;

/// <summary>
/// A materialized primary media file: its true decoded size, container, and a
/// factory that opens fresh seekable streams over the media bytes. Each HTTP
/// request opens its own stream, so concurrent Range requests are independent.
/// </summary>
public sealed record ResolvedMediaFile
{
    public required string FileName { get; init; }

    /// <summary>Lowercase container/extension without the dot (e.g. "mkv").</summary>
    public required string Container { get; init; }

    public required long SizeBytes { get; init; }

    /// <summary>Opens a fresh stream using the given (per-session) NNTP client.</summary>
    public required Func<INntpClient, Stream> OpenStream { get; init; }
}

/// <summary>
/// Turns a <see cref="MediaFileCandidate"/> into a streamable file: probes the
/// decoded size from yEnc headers, and for RAR sets walks each volume's headers
/// to build the random-access slice map (seeking inside the RAR'd file is then
/// pure offset arithmetic — no unpacking).
/// </summary>
public class MediaFileMaterializer(INntpClient nntpClient, IOptions<StreamarrOptions> options)
{
    public Task<ResolvedMediaFile> MaterializeAsync(MediaFileCandidate candidate, CancellationToken ct)
        => candidate.IsRarWrapped ? MaterializeRarAsync(candidate, ct) : MaterializeDirectAsync(candidate, ct);

    private async Task<ResolvedMediaFile> MaterializeDirectAsync(MediaFileCandidate candidate, CancellationToken ct)
    {
        var file = candidate.Files[0];
        var segmentIds = file.GetSegmentIds();
        var size = await nntpClient.GetFileSizeAsync(file, ct);
        ValidateMediaSize(size);
        var readAhead = options.Value.ArticleReadAheadCount;

        return new ResolvedMediaFile
        {
            FileName = candidate.DisplayName,
            Container = Extension(candidate.DisplayName),
            SizeBytes = size,
            OpenStream = client => new NzbFileStream(segmentIds, size, client, readAhead),
        };
    }

    private async Task<ResolvedMediaFile> MaterializeRarAsync(MediaFileCandidate candidate, CancellationToken ct)
    {
        if (candidate.Files.Count > RarArchiveIndexer.MaxVolumes)
            throw new InvalidDataException($"RAR sets may contain at most {RarArchiveIndexer.MaxVolumes} volumes.");

        var readAhead = options.Value.ArticleReadAheadCount;
        var volumes = new (string[] SegmentIds, long Size)[candidate.Files.Count];
        var parsedVolumes = new List<RarVolume>(candidate.Files.Count);

        for (var i = 0; i < candidate.Files.Count; i++)
        {
            var file = candidate.Files[i];
            var segmentIds = file.GetSegmentIds();
            var size = await nntpClient.GetFileSizeAsync(file, ct);
            ValidateMediaSize(size);
            volumes[i] = (segmentIds, size);

            await using var headerStream = new NzbFileStream(segmentIds, size, nntpClient, articleBufferSize: 0);
            parsedVolumes.Add(await RarVolumeReader.ReadAsync(headerStream, file.GetSubjectFileName(), ct));
        }

        // Index() orders volumes by part number — the same order as the candidate's
        // volume list, so slice PartIndex values map 1:1 onto `volumes`.
        var storedFiles = RarArchiveIndexer.Index(parsedVolumes);
        var media = storedFiles.Where(f => MediaFileSelector.IsMediaFileName(f.PathWithinArchive)).MaxBy(f => f.Size)
                    ?? storedFiles.MaxBy(f => f.Size)
                    ?? throw new NoPlayableFileException("The RAR set contains no stored files.");
        ValidateMediaSize(media.Size);

        return new ResolvedMediaFile
        {
            FileName = media.PathWithinArchive,
            Container = Extension(media.PathWithinArchive),
            SizeBytes = media.Size,
            OpenStream = client => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(
                    new NzbFileStream(volumes[partIndex].SegmentIds, volumes[partIndex].Size, client, readAhead))),
        };
    }

    private static string Extension(string fileName)
        => Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();

    private void ValidateMediaSize(long size)
    {
        if (size is < 1 || size > options.Value.MaxMediaBytes)
            throw new InvalidDataException("The decoded media size is outside the configured safety limit.");
    }
}
