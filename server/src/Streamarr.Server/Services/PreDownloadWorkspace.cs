using Microsoft.Extensions.Options;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services;

/// <summary>Owns the bounded, internal-only on-disk layout for ephemeral pre-downloads.</summary>
public sealed class PreDownloadWorkspace(
    IOptions<StreamarrOptions> options,
    IHostEnvironment environment,
    ILogger<PreDownloadWorkspace> logger)
{
    public string Root
    {
        get
        {
            var configured = options.Value.PreDownload.CachePath;
            var resolved = string.IsNullOrWhiteSpace(configured)
                ? Path.Combine(environment.ContentRootPath, "cache", "pre-download")
                : Path.GetFullPath(configured, environment.ContentRootPath);
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
                throw new InvalidOperationException("The pre-download cache cannot be a filesystem root.");
            }
            return resolved;
        }
    }

    public void EnsureCreated()
    {
        if (!Directory.Exists(Root))
        {
            if (OperatingSystem.IsWindows())
                Directory.CreateDirectory(Root);
            else
                Directory.CreateDirectory(
                    Root,
                    UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }

        var info = new DirectoryInfo(Root);
        if (info.LinkTarget is not null || (info.Attributes & FileAttributes.ReparsePoint) != 0)
            throw new IOException("The pre-download cache directory cannot be a link.");
    }

    public (string Partial, string Complete) Paths(string token)
    {
        if (token.Length != 48 || token.Any(c => !char.IsAsciiHexDigit(c)))
            throw new ArgumentException("Invalid session token.", nameof(token));
        EnsureCreated();
        var key = token.ToLowerInvariant();
        return (
            Path.Combine(Root, $"{key}.partial"),
            Path.Combine(Root, $"{key}.cache"));
    }

    public bool HasSpaceFor(long bytes)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(bytes);
        EnsureCreated();
        var root = Path.GetPathRoot(Path.GetFullPath(Root));
        if (string.IsNullOrEmpty(root))
            return false;
        var reserve = Math.Max(0, options.Value.PreDownload.MinimumFreeDiskBytes);
        var available = new DriveInfo(root).AvailableFreeSpace;
        return available >= reserve && bytes <= available - reserve;
    }

    public void CleanStaleFiles()
    {
        EnsureCreated();
        foreach (var path in Directory.EnumerateFiles(Root))
        {
            var name = Path.GetFileName(path);
            if (!name.EndsWith(".partial", StringComparison.Ordinal)
                && !name.EndsWith(".cache", StringComparison.Ordinal))
            {
                continue;
            }

            try
            {
                File.Delete(path);
            }
            catch (Exception e)
            {
                logger.LogWarning(
                    "Could not remove a stale pre-download file ({FailureType})",
                    e.GetType().Name);
            }
        }
    }
}
