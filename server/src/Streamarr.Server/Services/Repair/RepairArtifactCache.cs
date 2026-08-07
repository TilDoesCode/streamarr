using System.Buffers;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services.Repair;

/// <summary>One repaired source file inside an artifact (paths are internal, names display-only).</summary>
public sealed record RepairArtifactFile
{
    /// <summary>Declared PAR2/NZB file name — display and RAR-ordering only, never a path.</summary>
    public required string DisplayName { get; init; }

    /// <summary>Internal relative file name (source-&lt;i&gt;.bin).</summary>
    public required string RelativePath { get; init; }

    public required long Length { get; init; }

    /// <summary>Verified whole-file MD5 (from the PAR2 file description), hex.</summary>
    public required string Md5Hex { get; init; }
}

/// <summary>Validated description of a published artifact.</summary>
public sealed record RepairArtifactManifest
{
    public int Version { get; init; } = 1;
    public required string Fingerprint { get; init; }
    public required string ReleaseTitle { get; init; }
    public required string SetIdHex { get; init; }
    public required long SliceSize { get; init; }
    public required IReadOnlyList<RepairArtifactFile> Files { get; init; }
    public required string MediaFileDisplayName { get; init; }
    public required bool IsRarWrapped { get; init; }
    public required long MediaSizeBytes { get; init; }
    public required DateTimeOffset CreatedUtc { get; init; }
}

/// <summary>A published artifact plus its on-disk location.</summary>
public sealed record RepairArtifact(string Fingerprint, string Directory, RepairArtifactManifest Manifest)
{
    public string FilePath(RepairArtifactFile file) => Path.Combine(Directory, file.RelativePath);
}

/// <summary>An eviction-safe reference to one repair artifact.</summary>
public sealed class RepairArtifactLease : IDisposable
{
    private Action? _release;

    internal RepairArtifactLease(RepairArtifact artifact, Action release)
    {
        Artifact = artifact;
        _release = release;
    }

    public RepairArtifact Artifact { get; }

    public void Dispose() => Interlocked.Exchange(ref _release, null)?.Invoke();
}

/// <summary>Admin-facing artifact summary.</summary>
public sealed record RepairArtifactSnapshot(
    string Fingerprint,
    string ReleaseTitle,
    long Bytes,
    DateTimeOffset CreatedUtc,
    DateTimeOffset LastAccessUtc,
    int PinCount);

/// <summary>
/// Publishes fully verified repair artifacts atomically (staging dir → rename into the
/// artifact root) and serves them back under a byte budget with LRU eviction, TTL expiry
/// and pinning for active streams. Survives restarts through manifest validation.
/// </summary>
public sealed class RepairArtifactCache(
    RepairWorkspace workspace,
    IOptions<StreamarrOptions> options,
    ILogger<RepairArtifactCache> logger,
    TimeProvider? time = null)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly object _publishGate = new();

    private sealed class Entry
    {
        public required RepairArtifact Artifact { get; init; }
        public required long Bytes { get; init; }
        public long LastAccessTicks;
        public int PinCount;
    }

    public event Action<string>? ArtifactEvicted;

    /// <summary>Scans the artifact root, keeping only directories with a valid manifest.</summary>
    public void LoadExisting()
    {
        workspace.EnsureLayout();
        foreach (var dir in Directory.EnumerateDirectories(workspace.ArtifactRoot))
        {
            var fingerprint = Path.GetFileName(dir);
            try
            {
                RepairWorkspace.EnsureNotLink(dir);
                var manifest = ReadManifest(dir)
                    ?? throw new InvalidDataException("missing manifest");
                if (!string.Equals(manifest.Fingerprint, fingerprint, StringComparison.Ordinal))
                    throw new InvalidDataException("fingerprint mismatch");
                ValidateManifestAndFiles(
                    dir,
                    manifest,
                    verifyHashes: true,
                    CancellationToken.None);
                lock (_publishGate)
                {
                    _entries[fingerprint] = new Entry
                    {
                        Artifact = new RepairArtifact(fingerprint, dir, manifest),
                        Bytes = ManifestBytes(manifest),
                        LastAccessTicks = File.GetLastWriteTimeUtc(Path.Combine(dir, RepairWorkspace.ManifestFileName)).Ticks,
                    };
                }
                logger.LogInformation("Recovered repair artifact {Fingerprint} from disk", fingerprint);
            }
            catch (Exception e)
            {
                logger.LogWarning(
                    "Discarding invalid repair artifact directory ({FailureType})",
                    e.GetType().Name);
                TryDelete(dir);
            }
        }
        lock (_publishGate)
            EnforceBudgetLocked();
    }

    internal RepairArtifact? TryGetReady(string fingerprint)
    {
        lock (_publishGate)
        {
            if (!_entries.TryGetValue(fingerprint, out var entry))
                return null;
            Touch(entry);
            return entry.Artifact;
        }
    }

    public RepairArtifactLease? TryAcquire(string fingerprint)
    {
        lock (_publishGate)
        {
            if (!_entries.TryGetValue(fingerprint, out var entry))
                return null;
            entry.PinCount++;
            Touch(entry);
            return new RepairArtifactLease(entry.Artifact, () => Release(entry));
        }
    }

    internal IDisposable? TryPin(string fingerprint) => TryAcquire(fingerprint);

    /// <summary>
    /// Atomically publishes a fully verified staging directory. The staging directory must
    /// already contain the manifest; after the rename the artifact is immediately servable.
    /// </summary>
    public RepairArtifact Publish(
        string fingerprint,
        string stagingDirectory,
        RepairArtifactManifest manifest)
        => Publish(fingerprint, stagingDirectory, manifest, CancellationToken.None);

    public RepairArtifact Publish(
        string fingerprint,
        string stagingDirectory,
        RepairArtifactManifest manifest,
        CancellationToken cancellationToken)
    {
        var target = workspace.ArtifactDirectory(fingerprint);
        cancellationToken.ThrowIfCancellationRequested();

        RepairArtifact? existing;
        lock (_publishGate)
        {
            existing = _entries.TryGetValue(fingerprint, out var entry)
                ? entry.Artifact
                : null;
        }
        if (existing is not null)
        {
            workspace.DeleteBounded(stagingDirectory);
            return existing;
        }

        RepairWorkspace.EnsureNotLink(stagingDirectory);
        if (!string.Equals(fingerprint, manifest.Fingerprint, StringComparison.Ordinal))
            throw new InvalidDataException("artifact fingerprint does not match its publication key");
        WriteManifest(stagingDirectory, manifest);
        ValidateManifestAndFiles(stagingDirectory, manifest, verifyHashes: true, cancellationToken);

        // Cancellation is honored throughout validation and while waiting to commit. Once
        // the atomic directory move starts, publication completes so callers never observe
        // an artifact on disk that is absent from the in-memory index.
        cancellationToken.ThrowIfCancellationRequested();
        lock (_publishGate)
        {
            if (_entries.TryGetValue(fingerprint, out var entry))
            {
                existing = entry.Artifact;
            }
            else
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (Directory.Exists(target))
                    workspace.DeleteBounded(target);
                Directory.Move(stagingDirectory, target);

                var artifact = new RepairArtifact(fingerprint, target, manifest);
                _entries[fingerprint] = new Entry
                {
                    Artifact = artifact,
                    Bytes = ManifestBytes(manifest),
                    LastAccessTicks = _time.GetUtcNow().UtcTicks,
                };
                EnforceBudgetLocked();
                return artifact;
            }
        }

        workspace.DeleteBounded(stagingDirectory);
        return existing!;
    }

    /// <summary>Applies the TTL and the byte budget; called periodically by maintenance.</summary>
    public int Sweep()
    {
        var evicted = 0;
        var ttl = TimeSpan.FromSeconds(options.Value.Repair.ArtifactTtlSeconds);
        var cutoff = _time.GetUtcNow() - ttl;
        foreach (var (fingerprint, entry) in _entries)
        {
            if (Volatile.Read(ref entry.PinCount) > 0)
                continue;
            if (new DateTimeOffset(Volatile.Read(ref entry.LastAccessTicks), TimeSpan.Zero) < cutoff)
            {
                if (Evict(fingerprint))
                    evicted++;
            }
        }
        lock (_publishGate)
        {
            evicted += EnforceBudgetLocked();
        }
        return evicted;
    }

    public bool Evict(string fingerprint)
    {
        lock (_publishGate)
        {
            if (!_entries.TryGetValue(fingerprint, out var entry) || entry.PinCount > 0)
                return false;
            if (!_entries.TryRemove(new KeyValuePair<string, Entry>(fingerprint, entry)))
                return false;
            TryDelete(entry.Artifact.Directory);
            ArtifactEvicted?.Invoke(fingerprint);
            logger.LogInformation("Evicted repair artifact {Fingerprint}", fingerprint);
            return true;
        }
    }

    public IReadOnlyList<RepairArtifactSnapshot> Snapshots()
        => _entries.Values
            .Select(e => new RepairArtifactSnapshot(
                e.Artifact.Fingerprint,
                e.Artifact.Manifest.ReleaseTitle,
                e.Bytes,
                e.Artifact.Manifest.CreatedUtc,
                new DateTimeOffset(Volatile.Read(ref e.LastAccessTicks), TimeSpan.Zero),
                Volatile.Read(ref e.PinCount)))
            .OrderByDescending(s => s.LastAccessUtc)
            .ToList();

    public long TotalBytes
    {
        get
        {
            long total = 0;
            foreach (var entry in _entries.Values)
            {
                if (entry.Bytes > long.MaxValue - total)
                    return long.MaxValue;
                total += entry.Bytes;
            }
            return total;
        }
    }

    private int EnforceBudgetLocked()
    {
        var budget = options.Value.Repair.CacheBudgetBytes;
        var evicted = 0;
        while (TotalBytes > budget)
        {
            // The most recently used artifact is never a victim: a just-published
            // artifact is about to be served and must not evict itself.
            var newest = _entries.Values.MaxBy(e => Volatile.Read(ref e.LastAccessTicks));
            var victim = _entries.Values
                .Where(e => Volatile.Read(ref e.PinCount) == 0 && !ReferenceEquals(e, newest))
                .MinBy(e => Volatile.Read(ref e.LastAccessTicks));
            if (victim is null || !Evict(victim.Artifact.Fingerprint))
                break;
            evicted++;
        }
        return evicted;
    }

    private void Touch(Entry entry)
    {
        Volatile.Write(ref entry.LastAccessTicks, _time.GetUtcNow().UtcTicks);
        try
        {
            File.SetLastWriteTimeUtc(
                Path.Combine(entry.Artifact.Directory, RepairWorkspace.ManifestFileName),
                _time.GetUtcNow().UtcDateTime);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or NotSupportedException)
        {
            // LRU persistence is best-effort.
        }
    }

    private void TryDelete(string directory)
    {
        try
        {
            workspace.DeleteBounded(directory);
        }
        catch (Exception e)
        {
            logger.LogWarning("Could not delete artifact directory: {Reason}", e.GetType().Name);
        }
    }

    private void Release(Entry entry)
    {
        lock (_publishGate)
        {
            if (entry.PinCount > 0)
                entry.PinCount--;
        }
    }

    private void ValidateManifestAndFiles(
        string directory,
        RepairArtifactManifest manifest,
        bool verifyHashes,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (manifest.Version != 1
            || manifest.Fingerprint is null
            || !RepairWorkspace.IsValidFingerprint(manifest.Fingerprint)
            || string.IsNullOrWhiteSpace(manifest.ReleaseTitle)
            || manifest.ReleaseTitle.Length > 1_024
            || manifest.SliceSize <= 0
            || manifest.SliceSize > options.Value.Repair.MaxPar2SliceBytes
            || string.IsNullOrWhiteSpace(manifest.MediaFileDisplayName)
            || manifest.MediaFileDisplayName.Length > 1_024
            || manifest.MediaSizeBytes <= 0)
        {
            throw new InvalidDataException("invalid artifact manifest");
        }
        if (manifest.SetIdHex is null
            || manifest.SetIdHex.Length != 32
            || !manifest.SetIdHex.All(Uri.IsHexDigit))
            throw new InvalidDataException("invalid PAR2 set id");
        if (manifest.Files is null
            || manifest.Files.Count == 0
            || manifest.Files.Count > options.Value.Repair.MaxPar2Files)
            throw new InvalidDataException("artifact has no files");
        var paths = new HashSet<string>(StringComparer.Ordinal)
        {
            RepairWorkspace.ManifestFileName,
        };
        if (ManifestBytes(manifest) > options.Value.Repair.MaxArtifactBytes)
            throw new InvalidDataException("artifact exceeds the configured size limit");
        foreach (var file in manifest.Files)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (file is null
                || string.IsNullOrWhiteSpace(file.DisplayName)
                || file.DisplayName.Length > 1_024
                || string.IsNullOrEmpty(file.RelativePath)
                || !IsInternalSourceName(file.RelativePath)
                || !paths.Add(file.RelativePath)
                || file.Length <= 0
                || file.Md5Hex is null
                || file.Md5Hex.Length != 32
                || !file.Md5Hex.All(Uri.IsHexDigit))
            {
                throw new InvalidDataException("invalid artifact file path");
            }
            var info = new FileInfo(Path.Combine(directory, file.RelativePath));
            if (!info.Exists
                || info.Length != file.Length
                || info.LinkTarget is not null
                || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException("artifact file missing or wrong size");
            }
            if (verifyHashes)
            {
                using var input = new FileStream(info.FullName, FileMode.Open, FileAccess.Read, FileShare.Read);
                var actual = Convert.ToHexString(ComputeMd5(input, cancellationToken)).ToLowerInvariant();
                if (!string.Equals(actual, file.Md5Hex, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("artifact file checksum mismatch");
            }
        }
        foreach (var path in Directory.EnumerateFileSystemEntries(directory))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var name = Path.GetFileName(path);
            var info = new FileInfo(path);
            if (!paths.Contains(name)
                || Directory.Exists(path)
                || info.LinkTarget is not null
                || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new InvalidDataException("artifact contains an unexpected filesystem entry");
            }
        }
    }

    internal static byte[] ComputeMd5(Stream input, CancellationToken cancellationToken)
    {
        var buffer = ArrayPool<byte>.Shared.Rent(1024 * 1024);
        try
        {
            using var hash = IncrementalHash.CreateHash(HashAlgorithmName.MD5);
            while (true)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var read = input.Read(buffer, 0, buffer.Length);
                if (read == 0)
                    return hash.GetHashAndReset();
                hash.AppendData(buffer, 0, read);
            }
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }

    private static bool IsInternalSourceName(string value)
    {
        if (!value.StartsWith("source-", StringComparison.Ordinal) || !value.EndsWith(".bin", StringComparison.Ordinal))
            return false;
        var digits = value.AsSpan(7, value.Length - 11);
        return digits.Length > 0 && digits.Length <= 10 && digits.IndexOfAnyExceptInRange('0', '9') < 0;
    }

    private static long ManifestBytes(RepairArtifactManifest manifest)
    {
        try
        {
            long total = 0;
            foreach (var file in manifest.Files)
            {
                if (file is null)
                    throw new InvalidDataException("artifact contains a null file entry");
                total = checked(total + file.Length);
            }
            return total;
        }
        catch (OverflowException e)
        {
            throw new InvalidDataException("artifact byte accounting overflow", e);
        }
    }

    private static RepairArtifactManifest? ReadManifest(string directory)
    {
        var path = Path.Combine(directory, RepairWorkspace.ManifestFileName);
        if (!File.Exists(path))
            return null;
        var info = new FileInfo(path);
        if (info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new InvalidDataException("manifest links are not allowed");
        using var stream = File.OpenRead(path);
        if (stream.Length > 1024 * 1024)
            throw new InvalidDataException("manifest too large");
        return JsonSerializer.Deserialize<RepairArtifactManifest>(stream, JsonOptions);
    }

    private static void WriteManifest(string directory, RepairArtifactManifest manifest)
    {
        var path = Path.Combine(directory, RepairWorkspace.ManifestFileName);
        var info = new FileInfo(path);
        if (Directory.Exists(path)
            || info.LinkTarget is not null
            || info.Exists && (info.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            throw new InvalidDataException("manifest links are not allowed");
        }
        using var stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None);
        JsonSerializer.Serialize(stream, manifest, JsonOptions);
        stream.Flush(flushToDisk: true);
    }
}
