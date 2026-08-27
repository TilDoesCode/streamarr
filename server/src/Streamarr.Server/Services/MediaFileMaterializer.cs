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

    /// <summary>Telemetry-capable stream factory; old callers can keep using OpenStream.</summary>
    public Func<INntpClient, Action<string>?, Stream>? OpenObservedStream { get; init; }

    public Func<INntpClient, Action<string>?, Action<SegmentTransferEvent>?, Stream>? OpenTelemetryStream { get; init; }

    /// <summary>Low-read-ahead factory that bypasses the hot in-memory playback cache.</summary>
    public Func<INntpClient, Action<string>?, Action<SegmentTransferEvent>?, Stream>? OpenPreDownloadStream { get; init; }

    /// <summary>All article ids that may back this ephemeral media file.</summary>
    public IReadOnlyList<string> SegmentIds { get; init; } = [];

    public IReadOnlyList<ArticleManifestEntry> ArticleManifest { get; init; } = [];

    /// <summary>
    /// Conservative size of the object graph retained by the materialization delegates.
    /// This is metadata only; media bytes remain remote and are not included.
    /// </summary>
    internal long EstimatedCacheWeightBytes { get; init; }
}

/// <summary>
/// Turns a <see cref="MediaFileCandidate"/> into a streamable file: probes the
/// decoded size from yEnc headers, and for RAR sets walks each volume's headers
/// to build the random-access slice map (seeking inside the RAR'd file is then
/// pure offset arithmetic — no unpacking).
/// </summary>
public class MediaFileMaterializer(
    INntpClient nntpClient,
    IOptions<StreamarrOptions> options,
    SegmentCache? segmentCache = null,
    SegmentMetadataCache? segmentMetadata = null)
{
    public Task<ResolvedMediaFile> MaterializeAsync(MediaFileCandidate candidate, CancellationToken ct)
        => MaterializeAsync(candidate, target: null, strictEpisodeMatch: false, ct);

    /// <param name="target">
    /// The episode to select inside a multi-file RAR set (season pack support); the
    /// direct-file case was already narrowed by <see cref="MediaFileSelector.SelectForEpisode"/>.
    /// </param>
    /// <param name="strictEpisodeMatch">
    /// When true (the release is known to carry multiple episodes), an archive holding
    /// several media files none of which matches <paramref name="target"/> fails instead
    /// of silently streaming the largest — never play the wrong episode.
    /// </param>
    public Task<ResolvedMediaFile> MaterializeAsync(
        MediaFileCandidate candidate,
        EpisodeTarget? target,
        bool strictEpisodeMatch,
        CancellationToken ct)
        => candidate.IsRarWrapped
            ? MaterializeRarAsync(candidate, target, strictEpisodeMatch, ct)
            : MaterializeDirectAsync(candidate, ct);

    private async Task<ResolvedMediaFile> MaterializeDirectAsync(MediaFileCandidate candidate, CancellationToken ct)
    {
        var file = candidate.Files[0];
        var segmentIds = file.GetSegmentIds();
        var manifest = file.Segments
            .Select(segment => new ArticleManifestEntry(
                segment.MessageId,
                candidate.DisplayName,
                segment.Number,
                segment.Bytes))
            .ToArray();
        var size = await nntpClient.GetFileSizeAsync(file, ct);
        ValidateMediaSize(size);
        var readAhead = options.Value.ArticleReadAheadCount;
        var startupReadAhead = options.Value.ArticleStartupReadAheadCount;
        var startupSegments = options.Value.ArticleStartupReadAheadSegments;
        var retryCount = options.Value.ArticleDownloadRetryCount;
        var container = Extension(candidate.DisplayName);

        return new ResolvedMediaFile
        {
            FileName = candidate.DisplayName,
            Container = container,
            SizeBytes = size,
            SegmentIds = segmentIds,
            ArticleManifest = manifest,
            EstimatedCacheWeightBytes = EstimateCacheWeightBytes(
                candidate.DisplayName,
                container,
                [segmentIds],
                hasFlattenedSegmentArray: false,
                rarSliceCount: 0),
            OpenStream = client => new NzbFileStream(
                segmentIds, size, client, readAhead, segmentCache, retryCount,
                startupArticleBufferSize: startupReadAhead,
                startupReadAheadSegments: startupSegments,
                segmentMetadata: segmentMetadata),
            OpenObservedStream = (client, onSegmentRequested) => new NzbFileStream(
                segmentIds, size, client, readAhead, segmentCache, retryCount, onSegmentRequested,
                startupReadAhead,
                startupSegments,
                segmentMetadata: segmentMetadata),
            OpenTelemetryStream = (client, onSegmentRequested, onTransfer) => new NzbFileStream(
                segmentIds, size, client, readAhead, segmentCache, retryCount, onSegmentRequested,
                startupReadAhead,
                startupSegments,
                segmentMetadata: segmentMetadata,
                onTransfer: onTransfer),
            OpenPreDownloadStream = (client, onSegmentRequested, onTransfer) => new NzbFileStream(
                segmentIds, size, client, articleBufferSize: 1, segmentCache: null, retryCount,
                onSegmentRequested,
                startupArticleBufferSize: 1,
                startupReadAheadSegments: 1,
                segmentMetadata: segmentMetadata,
                onTransfer: onTransfer),
        };
    }

    private async Task<ResolvedMediaFile> MaterializeRarAsync(
        MediaFileCandidate candidate,
        EpisodeTarget? target,
        bool strictEpisodeMatch,
        CancellationToken ct)
    {
        if (candidate.Files.Count > RarArchiveIndexer.MaxVolumes)
            throw new InvalidDataException($"RAR sets may contain at most {RarArchiveIndexer.MaxVolumes} volumes.");

        var readAhead = options.Value.ArticleReadAheadCount;
        var startupReadAhead = options.Value.ArticleStartupReadAheadCount;
        var startupSegments = options.Value.ArticleStartupReadAheadSegments;
        var retryCount = options.Value.ArticleDownloadRetryCount;
        var volumeFileNames = candidate.Files
            .Select(file => file.GetSubjectFileName())
            .ToArray();
        var volumes = new (string[] SegmentIds, long Size)[candidate.Files.Count];
        var parsedVolumes = new RarVolume[candidate.Files.Count];
        var parallelOptions = new ParallelOptions
        {
            MaxDegreeOfParallelism = Math.Min(
                options.Value.RarMaterializationConcurrency,
                Math.Max(1, options.Value.ConnectionBudget)),
            CancellationToken = ct,
        };

        await Parallel.ForEachAsync(Enumerable.Range(0, candidate.Files.Count), parallelOptions, async (i, token) =>
        {
            var file = candidate.Files[i];
            var segmentIds = file.GetSegmentIds();
            var sizeTask = nntpClient.GetFileSizeAsync(file, token);
            var firstBodyTask = nntpClient.DecodedBodyAsync(segmentIds[0], token);
            var firstBodyTransferred = false;
            try
            {
                await Task.WhenAll(sizeTask, firstBodyTask).ConfigureAwait(false);
                var size = await sizeTask.ConfigureAwait(false);
                ValidateMediaSize(size);
                volumes[i] = (segmentIds, size);

                var firstBody = await firstBodyTask.ConfigureAwait(false);
                await using var headerStream = new NzbFileStream(
                    segmentIds,
                    size,
                    nntpClient,
                    articleBufferSize: 0,
                    openedFirstSegment: firstBody.Stream);
                firstBodyTransferred = true;
                parsedVolumes[i] = await RarVolumeReader.ReadAsync(
                    headerStream, volumeFileNames[i], token, candidate.Password);
            }
            finally
            {
                if (!firstBodyTransferred && firstBodyTask.IsCompletedSuccessfully)
                    await DisposeQuietlyAsync(firstBodyTask.Result.Stream).ConfigureAwait(false);
            }
        });

        // Index() orders volumes by part number — the same order as the candidate's
        // volume list, so slice PartIndex values map 1:1 onto `volumes`.
        var storedFiles = RarArchiveIndexer.Index(parsedVolumes);
        var media = SelectStoredFile(storedFiles, target, strictEpisodeMatch);
        ValidateMediaSize(media.Size);
        var segmentIds = volumes.SelectMany(volume => volume.SegmentIds).ToArray();
        var manifest = candidate.Files
            .SelectMany((file, fileIndex) => file.Segments.Select(segment => new ArticleManifestEntry(
                segment.MessageId,
                volumeFileNames[fileIndex],
                segment.Number,
                segment.Bytes)))
            .ToArray();
        var container = Extension(media.PathWithinArchive);

        return new ResolvedMediaFile
        {
            FileName = media.PathWithinArchive,
            Container = container,
            SizeBytes = media.Size,
            SegmentIds = segmentIds,
            ArticleManifest = manifest,
            EstimatedCacheWeightBytes = EstimateCacheWeightBytes(
                media.PathWithinArchive,
                container,
                volumes.Select(volume => (IReadOnlyList<string>)volume.SegmentIds),
                hasFlattenedSegmentArray: true,
                rarSliceCount: media.Slices.Count,
                manifestFileNames: volumeFileNames),
            OpenStream = client => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(
                    new NzbFileStream(
                        volumes[partIndex].SegmentIds,
                        volumes[partIndex].Size,
                        client,
                        readAhead,
                        segmentCache,
                        retryCount,
                        startupArticleBufferSize: startupReadAhead,
                        startupReadAheadSegments: startupSegments,
                        segmentMetadata: segmentMetadata)),
                candidate.Password),
            OpenObservedStream = (client, onSegmentRequested) => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(
                    new NzbFileStream(
                        volumes[partIndex].SegmentIds,
                        volumes[partIndex].Size,
                        client,
                        readAhead,
                        segmentCache,
                        retryCount,
                        onSegmentRequested,
                        startupReadAhead,
                        startupSegments,
                        segmentMetadata: segmentMetadata)),
                candidate.Password),
            OpenTelemetryStream = (client, onSegmentRequested, onTransfer) => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(
                    new NzbFileStream(
                        volumes[partIndex].SegmentIds,
                        volumes[partIndex].Size,
                        client,
                        readAhead,
                        segmentCache,
                        retryCount,
                        onSegmentRequested,
                        startupReadAhead,
                        startupSegments,
                        segmentMetadata: segmentMetadata,
                        onTransfer: onTransfer)),
                candidate.Password),
            OpenPreDownloadStream = (client, onSegmentRequested, onTransfer) => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(
                    new NzbFileStream(
                        volumes[partIndex].SegmentIds,
                        volumes[partIndex].Size,
                        client,
                        articleBufferSize: 1,
                        segmentCache: null,
                        retryCount,
                        onSegmentRequested,
                        startupArticleBufferSize: 1,
                        startupReadAheadSegments: 1,
                        segmentMetadata: segmentMetadata,
                        onTransfer: onTransfer)),
                candidate.Password),
        };
    }

    /// <summary>
    /// Estimates all result-owned strings/reference arrays plus the RAR random-access map.
    /// The fixed allowance covers the result, delegates, closures, and small collection objects.
    /// Shared strings are deliberately counted for every entry so the cache cannot under-budget
    /// when an upstream NZB document is released before the materialization.
    /// </summary>
    internal static long EstimateCacheWeightBytes(
        string fileName,
        string container,
        IEnumerable<IReadOnlyList<string>> segmentIdArrays,
        bool hasFlattenedSegmentArray,
        int rarSliceCount,
        IEnumerable<string>? manifestFileNames = null)
    {
        const long fixedObjectGraphBytes = 4 * 1024;
        const long rarSliceObjectGraphBytes = 192;

        var estimate = fixedObjectGraphBytes;
        estimate = SaturatingAdd(estimate, EstimatedStringBytes(fileName));
        estimate = SaturatingAdd(estimate, EstimatedStringBytes(container));

        long segmentCount = 0;
        long arrayCount = 0;
        foreach (var ids in segmentIdArrays)
        {
            arrayCount++;
            segmentCount = SaturatingAdd(segmentCount, ids.Count);
            estimate = SaturatingAdd(estimate, EstimatedReferenceArrayBytes(ids.Count));
            foreach (var id in ids)
                estimate = SaturatingAdd(estimate, EstimatedStringBytes(id));
        }

        if (hasFlattenedSegmentArray)
        {
            // RAR results retain both one message-id array per volume and one flattened
            // SegmentIds array, plus the (array-reference, decoded-size) volume tuple array.
            estimate = SaturatingAdd(estimate, EstimatedReferenceArrayBytes(segmentCount));
            estimate = SaturatingAdd(
                estimate,
                SaturatingAdd(24, SaturatingMultiply(arrayCount, 16)));
        }

        // One manifest array plus one ArticleManifestEntry record per segment; strings are shared.
        estimate = SaturatingAdd(estimate, EstimatedReferenceArrayBytes(segmentCount));
        estimate = SaturatingAdd(estimate, SaturatingMultiply(segmentCount, 56));
        if (manifestFileNames is not null)
        {
            foreach (var manifestFileName in manifestFileNames)
                estimate = SaturatingAdd(estimate, EstimatedStringBytes(manifestFileName));
        }

        if (rarSliceCount > 0)
        {
            // Each map entry retains the slice record, two LongRange records, and a list
            // reference. This deliberately rounds above their current managed layout.
            estimate = SaturatingAdd(estimate, 256);
            estimate = SaturatingAdd(estimate, EstimatedReferenceArrayBytes(rarSliceCount));
            estimate = SaturatingAdd(
                estimate,
                SaturatingMultiply(rarSliceCount, rarSliceObjectGraphBytes));
        }

        return estimate;
    }

    private static string Extension(string fileName)
        => Path.GetExtension(fileName).TrimStart('.').ToLowerInvariant();

    private static long EstimatedStringBytes(string? value)
    {
        if (value is null)
            return 0;

        // Object header + length + UTF-16 payload and terminator, aligned to 8 bytes.
        return Align8(SaturatingAdd(24, SaturatingMultiply(value.Length + 1L, sizeof(char))));
    }

    private static long EstimatedReferenceArrayBytes(long count)
        => Align8(SaturatingAdd(24, SaturatingMultiply(count, IntPtr.Size)));

    /// <summary>
    /// Chooses the stored file to stream out of an indexed RAR set. With an episode
    /// target, a media file whose path carries that episode's numbering wins (largest
    /// on ties — a same-episode sample is smaller than the feature). Without a match,
    /// a strict multi-file archive fails; everything else keeps the legacy largest-file
    /// behavior so single-episode releases are untouched.
    /// </summary>
    internal static RarStoredFile SelectStoredFile(
        IReadOnlyList<RarStoredFile> storedFiles,
        EpisodeTarget? target,
        bool strictEpisodeMatch)
    {
        var mediaFiles = storedFiles
            .Where(f => MediaFileSelector.IsMediaFileName(f.PathWithinArchive))
            .ToList();

        if (target is { } episode && mediaFiles.Count > 0)
        {
            var match = mediaFiles
                .Where(f => episode.MatchesFileName(f.PathWithinArchive))
                .MaxBy(f => f.Size);
            if (match is not null)
                return match;
            if (strictEpisodeMatch && mediaFiles.Count > 1)
            {
                throw new NoPlayableFileException(
                    $"The RAR set contains {mediaFiles.Count} media files but none is named for {episode}.");
            }
        }

        return mediaFiles.MaxBy(f => f.Size)
               ?? storedFiles.MaxBy(f => f.Size)
               ?? throw new NoPlayableFileException("The RAR set contains no stored files.");
    }

    private static long Align8(long value)
        => value >= long.MaxValue - 7 ? long.MaxValue : (value + 7) & ~7L;

    private static long SaturatingAdd(long left, long right)
        => left >= long.MaxValue - right ? long.MaxValue : left + right;

    private static long SaturatingMultiply(long left, long right)
        => left == 0 || right == 0
            ? 0
            : left >= long.MaxValue / right
                ? long.MaxValue
                : left * right;

    private void ValidateMediaSize(long size)
    {
        if (size is < 1 || size > options.Value.MaxMediaBytes)
            throw new InvalidDataException("The decoded media size is outside the configured safety limit.");
    }

    private static async ValueTask DisposeQuietlyAsync(Stream stream)
    {
        try
        {
            await stream.DisposeAsync().ConfigureAwait(false);
        }
        catch
        {
            // Preserve the materialization failure while still attempting to release
            // the pooled NNTP connection owned by an opened article body.
        }
    }
}
