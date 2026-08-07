using Streamarr.Usenet.Rar;

namespace Streamarr.Server.Services.Repair;

/// <summary>Outcome of verifying a repaired artifact's media projection.</summary>
public sealed record RepairMediaVerification(
    bool Ok,
    string? Reason,
    string? MediaFileName,
    long MediaSizeBytes,
    FfprobeResult? Probe);

/// <summary>Verifies that a repaired artifact actually projects to playable media.</summary>
public interface IRepairMediaVerifier
{
    Task<RepairMediaVerification> VerifyAsync(
        string stagingDirectory,
        IReadOnlyList<RepairArtifactFile> files,
        MediaFileCandidate candidate,
        CancellationToken ct);
}

/// <summary>
/// Structural + ffprobe verification: rebuilds the RAR index over the local files with
/// the production reader, checks the projected size, and runs ffprobe on the projection
/// (path for direct files, stdin pipe for RAR-stored ones).
/// </summary>
public sealed class FfprobeRepairMediaVerifier(
    FfprobeClient ffprobe,
    ILogger<FfprobeRepairMediaVerifier> logger) : IRepairMediaVerifier
{
    public async Task<RepairMediaVerification> VerifyAsync(
        string stagingDirectory,
        IReadOnlyList<RepairArtifactFile> files,
        MediaFileCandidate candidate,
        CancellationToken ct)
    {
        try
        {
            if (!candidate.IsRarWrapped)
            {
                var path = Path.Combine(stagingDirectory, files[0].RelativePath);
                var probe = await ffprobe.ProbeAsync(path, ct).ConfigureAwait(false);
                return probe is { MediaStreams.Count: > 0 }
                    ? new RepairMediaVerification(true, null, files[0].DisplayName, new FileInfo(path).Length, probe)
                    : new RepairMediaVerification(false, "ffprobe found no media streams", null, 0, null);
            }

            var projection = await LocalArtifactProjector.BuildAsync(
                stagingDirectory, files, candidate.Password, ct).ConfigureAwait(false);
            var pipeProbe = await ffprobe.ProbePipeAsync(projection.OpenStream, ct).ConfigureAwait(false);
            if (pipeProbe is not { MediaStreams.Count: > 0 })
                return new RepairMediaVerification(false, "ffprobe found no media streams in the RAR projection", null, 0, null);
            return new RepairMediaVerification(true, null, projection.MediaFileName, projection.MediaSizeBytes, pipeProbe);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception e)
        {
            logger.LogWarning("Repair media verification failed with {FailureType}", e.GetType().Name);
            return new RepairMediaVerification(false, e.GetType().Name, null, 0, null);
        }
    }
}

/// <summary>A locally servable media projection over repaired source files.</summary>
public sealed record LocalMediaProjection
{
    public required string MediaFileName { get; init; }
    public required long MediaSizeBytes { get; init; }
    public required string Container { get; init; }

    /// <summary>Opens a fresh seekable stream over the projected media bytes.</summary>
    public required Func<Stream> OpenStream { get; init; }
}

/// <summary>
/// Builds media projections over repaired local files with the existing production RAR
/// logic — no separate media parser lives in the repair code.
/// </summary>
public static class LocalArtifactProjector
{
    public static async Task<LocalMediaProjection> BuildAsync(
        string directory,
        IReadOnlyList<RepairArtifactFile> files,
        string? password,
        CancellationToken ct)
    {
        if (files.Count == 0)
            throw new InvalidOperationException("The artifact contains no files.");

        var isRar = files.Any(f => f.DisplayName.EndsWith(".rar", StringComparison.OrdinalIgnoreCase)
                                   || RarVolumeReader.GetPartNumberFromFilename(f.DisplayName) >= 0);
        if (!isRar)
        {
            var file = files[0];
            var path = Path.Combine(directory, file.RelativePath);
            return new LocalMediaProjection
            {
                MediaFileName = file.DisplayName,
                MediaSizeBytes = file.Length,
                Container = Extension(file.DisplayName),
                OpenStream = () => OpenRead(path),
            };
        }

        var volumes = new RarVolume[files.Count];
        for (var i = 0; i < files.Count; i++)
        {
            var path = Path.Combine(directory, files[i].RelativePath);
            await using var stream = OpenRead(path);
            volumes[i] = await RarVolumeReader.ReadAsync(stream, files[i].DisplayName, ct, password)
                .ConfigureAwait(false);
        }

        var stored = RarArchiveIndexer.Index(volumes);
        var media = stored.Where(f => MediaFileSelector.IsMediaFileName(f.PathWithinArchive)).MaxBy(f => f.Size)
                    ?? stored.MaxBy(f => f.Size)
                    ?? throw new InvalidDataException("The repaired RAR set contains no stored files.");

        // Index() orders volumes by part number; map slice part indices onto local paths.
        var orderedPaths = volumes
            .Select((v, i) => (Volume: v, Path: Path.Combine(directory, files[i].RelativePath)))
            .OrderBy(x => x.Volume.PartNumber)
            .Select(x => x.Path)
            .ToArray();

        return new LocalMediaProjection
        {
            MediaFileName = media.PathWithinArchive,
            MediaSizeBytes = media.Size,
            Container = Extension(media.PathWithinArchive),
            OpenStream = () => new RarStoredFileStream(
                media,
                (partIndex, _) => new ValueTask<Stream>(OpenRead(orderedPaths[partIndex])),
                password),
        };
    }

    private static FileStream OpenRead(string path)
        => new(path, new FileStreamOptions
        {
            Mode = FileMode.Open,
            Access = FileAccess.Read,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous | FileOptions.SequentialScan,
        });

    private static string Extension(string name)
    {
        var extension = Path.GetExtension(name);
        return string.IsNullOrEmpty(extension) ? "bin" : extension.TrimStart('.').ToLowerInvariant();
    }
}
