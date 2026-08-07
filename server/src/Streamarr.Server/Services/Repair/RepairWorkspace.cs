using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Par2;

namespace Streamarr.Server.Services.Repair;

/// <summary>
/// Owns the on-disk layout of the repair pipeline. Every path is derived exclusively
/// from validated fingerprints and internal file indices — declared PAR2/NZB file names
/// never reach the filesystem. Layout:
/// <code>
///   &lt;root&gt;/partial/&lt;fingerprint&gt;/source-&lt;i&gt;.bin | volume-&lt;i&gt;.bin | manifest.json
///   &lt;root&gt;/artifacts/&lt;fingerprint&gt;/…               (published, validated)
/// </code>
/// </summary>
public sealed partial class RepairWorkspace
{
    private readonly IOptions<StreamarrOptions> options;
    private readonly IHostEnvironment environment;
    private readonly ILogger<RepairWorkspace> logger;
    private readonly Func<long>? _availableFreeBytesOverride;
    private readonly object _reservationSync = new();
    private long _reservedBytes;

    public RepairWorkspace(
        IOptions<StreamarrOptions> options,
        IHostEnvironment environment,
        ILogger<RepairWorkspace> logger)
        : this(options, environment, logger, availableFreeBytes: null)
    {
    }

    internal RepairWorkspace(
        IOptions<StreamarrOptions> options,
        IHostEnvironment environment,
        ILogger<RepairWorkspace> logger,
        Func<long>? availableFreeBytes)
    {
        this.options = options;
        this.environment = environment;
        this.logger = logger;
        _availableFreeBytesOverride = availableFreeBytes;
    }

    [GeneratedRegex("^[0-9a-f]{16,64}$")]
    private static partial Regex FingerprintShape();

    public string Root
    {
        get
        {
            var resolved = string.IsNullOrWhiteSpace(options.Value.Repair.WorkspacePath)
                ? Path.Combine(environment.ContentRootPath, "cache", "repair")
                : Path.GetFullPath(options.Value.Repair.WorkspacePath, environment.ContentRootPath);
            resolved = Path.GetFullPath(resolved);
            var volumeRoot = Path.GetPathRoot(resolved);
            var comparison = OperatingSystem.IsWindows()
                ? StringComparison.OrdinalIgnoreCase
                : StringComparison.Ordinal;
            if (!string.IsNullOrEmpty(volumeRoot)
                && string.Equals(
                    Path.TrimEndingDirectorySeparator(resolved),
                    Path.TrimEndingDirectorySeparator(volumeRoot),
                    comparison))
            {
                throw new InvalidOperationException("The repair workspace cannot be a filesystem root.");
            }
            return resolved;
        }
    }

    public string PartialRoot => Path.Combine(Root, "partial");
    public string ArtifactRoot => Path.Combine(Root, "artifacts");

    public string StagingDirectory(string fingerprint) => Path.Combine(PartialRoot, Validate(fingerprint));
    public string ArtifactDirectory(string fingerprint) => Path.Combine(ArtifactRoot, Validate(fingerprint));

    public static string SourceFileName(int fileIndex) => $"source-{fileIndex}.bin";
    public static string VolumeFileName(int volumeIndex) => $"volume-{volumeIndex}.bin";
    public const string ManifestFileName = "manifest.json";

    public void EnsureLayout()
    {
        CreatePrivateDirectory(Root);
        CreatePrivateDirectory(PartialRoot);
        CreatePrivateDirectory(ArtifactRoot);
    }

    /// <summary>Free bytes on the volume hosting the workspace.</summary>
    public long AvailableFreeBytes()
    {
        EnsureLayout();
        return _availableFreeBytesOverride?.Invoke()
               ?? new DriveInfo(
                   Path.GetPathRoot(Path.GetFullPath(Root)) ?? "/").AvailableFreeSpace;
    }

    /// <summary>
    /// Reserves worst-case workspace capacity across concurrent jobs. The current free-space
    /// reading is deliberately combined with outstanding unconsumed reservations so two
    /// jobs cannot independently promise themselves the same future bytes. Successful sparse
    /// writes consume their newly covered bytes because the free-space reading then reflects them.
    /// </summary>
    internal RepairWorkspaceReservation? TryReserve(long workspaceBytes, long minimumFreeBytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(workspaceBytes);
        ArgumentOutOfRangeException.ThrowIfNegative(minimumFreeBytes);

        lock (_reservationSync)
        {
            var available = AvailableFreeBytes();
            if (minimumFreeBytes > available)
                return null;
            var availableForWork = available - minimumFreeBytes;
            if (_reservedBytes > availableForWork
                || workspaceBytes > availableForWork - _reservedBytes)
            {
                return null;
            }

            _reservedBytes += workspaceBytes;
            return new RepairWorkspaceReservation(workspaceBytes, ReleaseReservation);
        }
    }

    internal long ReservedBytes
    {
        get
        {
            lock (_reservationSync)
                return _reservedBytes;
        }
    }

    public RepairStaging CreateStaging(string fingerprint)
        => CreateStaging(fingerprint, reservation: null);

    internal RepairStaging CreateStaging(
        string fingerprint,
        RepairWorkspaceReservation? reservation)
    {
        EnsureLayout();
        var dir = StagingDirectory(fingerprint);
        DeleteBounded(dir);
        CreatePrivateDirectory(dir);
        return new RepairStaging(this, dir, reservation);
    }

    /// <summary>Startup hygiene: stale partial work is discarded, never resumed blindly.</summary>
    public void CleanStaleStaging()
    {
        EnsureLayout();
        foreach (var dir in Directory.EnumerateDirectories(PartialRoot))
        {
            EnsureNotLink(dir);
            if (IsValidFingerprint(Path.GetFileName(dir)))
                DeleteBounded(dir);
            else
                logger.LogWarning("Ignoring unexpected entry in the repair staging area");
        }
    }

    /// <summary>
    /// Deletes only a directory we created (fingerprint-shaped, inside our roots), without
    /// following symlinks out of the tree.
    /// </summary>
    public void DeleteBounded(string directory)
    {
        EnsureLayout();
        var full = Path.GetFullPath(directory);
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (!full.StartsWith(Path.GetFullPath(Root) + Path.DirectorySeparatorChar, comparison))
            throw new InvalidOperationException("Refusing to delete outside the repair workspace.");
        if (!Directory.Exists(full))
            return;
        DeleteTreeWithoutFollowingLinks(full);
    }

    internal static void CreatePrivateDirectory(string path)
    {
        if (!Directory.Exists(path))
        {
            if (File.Exists(path))
                throw new IOException("The repair workspace path is not a directory.");
            if (OperatingSystem.IsWindows())
                Directory.CreateDirectory(path);
            else
                Directory.CreateDirectory(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        EnsureNotLink(path);
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    internal static bool IsValidFingerprint(string fingerprint)
        => fingerprint.Length is >= 16 and <= 64
           && fingerprint.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')
           && FingerprintShape().IsMatch(fingerprint);

    internal static void EnsureNotLink(string path)
    {
        var info = new DirectoryInfo(path);
        if (info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Repair workspace links are not allowed.");
    }

    internal void TryDeleteStaging(string directory)
    {
        try
        {
            DeleteBounded(directory);
        }
        catch (Exception e)
        {
            logger.LogWarning(
                "Could not clean a repair staging directory ({FailureType})",
                e.GetType().Name);
        }
    }

    private static void DeleteTreeWithoutFollowingLinks(string directory)
    {
        var root = new DirectoryInfo(directory);
        if (root.LinkTarget is not null || (root.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            root.Delete();
            return;
        }

        foreach (var entry in root.EnumerateFileSystemInfos())
        {
            if ((entry.Attributes & FileAttributes.Directory) != 0
                && entry.LinkTarget is null
                && (entry.Attributes & FileAttributes.ReparsePoint) == 0)
            {
                DeleteTreeWithoutFollowingLinks(entry.FullName);
            }
            else if ((entry.Attributes & FileAttributes.Directory) != 0)
            {
                new DirectoryInfo(entry.FullName).Delete();
            }
            else
            {
                entry.Delete();
            }
        }
        root.Delete();
    }

    private static string Validate(string fingerprint)
        => IsValidFingerprint(fingerprint)
            ? fingerprint
            : throw new ArgumentException("Invalid repair fingerprint.", nameof(fingerprint));

    private void ReleaseReservation(long workspaceBytes)
    {
        lock (_reservationSync)
            _reservedBytes = checked(_reservedBytes - workspaceBytes);
    }
}

/// <summary>An idempotent lease on worst-case repair workspace capacity.</summary>
internal sealed class RepairWorkspaceReservation(long reservedBytes, Action<long> release) : IDisposable
{
    private readonly object _sync = new();
    private Action<long>? _release = release;
    private long _remainingBytes = reservedBytes;

    internal long RemainingBytes
    {
        get
        {
            lock (_sync)
                return _remainingBytes;
        }
    }

    internal void Consume(long bytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(bytes);
        if (bytes == 0)
            return;

        Action<long> releaseCallback;
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(_release is null, this);
            if (bytes > _remainingBytes)
                throw new InvalidOperationException("Repair workspace consumption exceeded its reservation.");
            _remainingBytes -= bytes;
            releaseCallback = _release;
        }
        releaseCallback(bytes);
    }

    public void Dispose()
    {
        Action<long>? releaseCallback;
        long remainingBytes;
        lock (_sync)
        {
            releaseCallback = _release;
            if (releaseCallback is null)
                return;
            _release = null;
            remainingBytes = _remainingBytes;
            _remainingBytes = 0;
        }
        if (remainingBytes > 0)
            releaseCallback(remainingBytes);
    }
}

/// <summary>A private staging directory holding sparse files while a job runs.</summary>
public sealed class RepairStaging : IDisposable
{
    private readonly RepairWorkspace workspace;
    private readonly RepairWorkspaceReservation? reservation;
    private readonly Dictionary<string, SparseRepairFile> _files = new(StringComparer.Ordinal);
    private readonly object _sync = new();
    private int _disposed;

    public RepairStaging(RepairWorkspace workspace, string directory)
        : this(workspace, directory, reservation: null)
    {
    }

    internal RepairStaging(
        RepairWorkspace workspace,
        string directory,
        RepairWorkspaceReservation? reservation)
    {
        this.workspace = workspace;
        this.reservation = reservation;
        Directory = directory;
    }

    public string Directory { get; }

    public SparseRepairFile OpenFile(string name, long length)
    {
        lock (_sync)
        {
            ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
            if (!IsInternalRepairFileName(name))
                throw new ArgumentException("Invalid internal repair file name.", nameof(name));
            if (_files.TryGetValue(name, out var existing))
                return existing;
            var file = new SparseRepairFile(Path.Combine(Directory, name), length, reservation);
            _files[name] = file;
            return file;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0)
            return;
        CloseFiles();
        workspace.TryDeleteStaging(Directory);
    }

    public void CloseFiles()
    {
        lock (_sync)
        {
            foreach (var file in _files.Values)
                file.Dispose();
            _files.Clear();
        }
    }

    private static bool IsInternalRepairFileName(string name)
    {
        if (!string.Equals(Path.GetFileName(name), name, StringComparison.Ordinal)
            || !name.EndsWith(".bin", StringComparison.Ordinal))
        {
            return false;
        }
        var prefixLength = name.StartsWith("source-", StringComparison.Ordinal)
            ? 7
            : name.StartsWith("volume-", StringComparison.Ordinal)
                ? 7
                : -1;
        if (prefixLength < 0)
            return false;
        var digits = name.AsSpan(prefixLength, name.Length - prefixLength - 4);
        return digits.Length is > 0 and <= 10
               && digits.IndexOfAnyExceptInRange('0', '9') < 0;
    }
}

/// <summary>
/// A fixed-length sparse file plus an in-memory coverage map. Writers place decoded
/// article payloads at their validated offsets; readers see exactly which byte ranges
/// are real. Thread-safe; reads of uncovered ranges return zeroes (callers consult
/// the coverage map — zeroes are never passed off as content).
/// </summary>
public sealed class SparseRepairFile : IPar2ScanSource, IDisposable
{
    private readonly FileStream _stream;
    private readonly RepairWorkspaceReservation? _reservation;
    private readonly List<LongRange> _covered = [];
    private readonly object _sync = new();

    public SparseRepairFile(string path, long length)
        : this(path, length, reservation: null)
    {
    }

    internal SparseRepairFile(
        string path,
        long length,
        RepairWorkspaceReservation? reservation)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(length);
        var fileOptions = new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.ReadWrite,
            Share = FileShare.Read,
            Options = FileOptions.Asynchronous,
        };
        if (!OperatingSystem.IsWindows())
            fileOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        _stream = new FileStream(path, fileOptions);
        _stream.SetLength(length);
        _reservation = reservation;
        Length = length;
        Path = path;
    }

    public string Path { get; }

    public long Length { get; }

    public long CoveredBytes
    {
        get
        {
            lock (_sync)
            {
                return _covered.Sum(r => r.Count);
            }
        }
    }

    public IReadOnlyList<LongRange> CoveredRanges
    {
        get
        {
            lock (_sync)
            {
                return [.. _covered];
            }
        }
    }

    public void WriteAt(long offset, ReadOnlySpan<byte> data)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(offset);
        if (data.Length > Length || offset > Length - data.Length)
            throw new ArgumentOutOfRangeException(nameof(data), "Write beyond the declared file length.");
        if (data.IsEmpty)
            return;
        lock (_sync)
        {
            _stream.Seek(offset, SeekOrigin.Begin);
            _stream.Write(data);
            var newlyCoveredBytes = AddCoveredLocked(new LongRange(offset, offset + data.Length));
            _reservation?.Consume(newlyCoveredBytes);
        }
    }

    public void ReadAt(long offset, Span<byte> destination)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(offset);
        if (destination.Length > Length || offset > Length - destination.Length)
            throw new ArgumentOutOfRangeException(nameof(destination), "Read beyond the declared file length.");
        lock (_sync)
        {
            _stream.Seek(offset, SeekOrigin.Begin);
            _stream.ReadExactly(destination);
        }
    }

    public bool IsCovered(long start, long endExclusive)
    {
        if (endExclusive <= start)
            return true;
        lock (_sync)
        {
            foreach (var range in _covered)
            {
                if (range.StartInclusive <= start && endExclusive <= range.EndExclusive)
                    return true;
                if (range.StartInclusive > start)
                    break;
            }
            return false;
        }
    }

    /// <summary>Byte ranges of the declared length that no validated article covered.</summary>
    public IReadOnlyList<LongRange> MissingRanges()
    {
        lock (_sync)
        {
            var missing = new List<LongRange>();
            long cursor = 0;
            foreach (var range in _covered)
            {
                if (range.StartInclusive > cursor)
                    missing.Add(new LongRange(cursor, range.StartInclusive));
                cursor = Math.Max(cursor, range.EndExclusive);
            }
            if (cursor < Length)
                missing.Add(new LongRange(cursor, Length));
            return missing;
        }
    }

    public void Flush()
    {
        lock (_sync)
        {
            _stream.Flush(flushToDisk: true);
        }
    }

    private long AddCoveredLocked(LongRange range)
    {
        var original = range;
        long alreadyCoveredBytes = 0;
        var merged = new List<LongRange>(_covered.Count + 1);
        var added = false;
        foreach (var existing in _covered)
        {
            var overlapStart = Math.Max(existing.StartInclusive, original.StartInclusive);
            var overlapEnd = Math.Min(existing.EndExclusive, original.EndExclusive);
            if (overlapEnd > overlapStart)
                alreadyCoveredBytes = checked(alreadyCoveredBytes + overlapEnd - overlapStart);

            if (existing.EndExclusive < range.StartInclusive)
            {
                merged.Add(existing);
            }
            else if (existing.StartInclusive > range.EndExclusive)
            {
                if (!added)
                {
                    merged.Add(range);
                    added = true;
                }
                merged.Add(existing);
            }
            else
            {
                range = new LongRange(
                    Math.Min(existing.StartInclusive, range.StartInclusive),
                    Math.Max(existing.EndExclusive, range.EndExclusive));
            }
        }
        if (!added)
            merged.Add(range);
        _covered.Clear();
        _covered.AddRange(merged);
        return checked(original.Count - alreadyCoveredBytes);
    }

    public void Dispose() => _stream.Dispose();
}
