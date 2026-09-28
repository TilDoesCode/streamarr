using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Transcoding;

/// <summary>Owns every directory the transcoder writes to; session and scratch directories never contain caller-supplied path parts.</summary>
public sealed partial class TranscodingWorkspace(IOptions<TranscodingOptions> options, IHostEnvironment environment)
{
    public string Root => Resolve(options.Value.WorkspacePath, Path.Combine("cache", "transcode"));

    public string SamplesRoot => Resolve(options.Value.SamplesPath, Path.Combine("cache", "transcoding-samples"));

    public string SessionsRoot => Path.Combine(Root, "sessions");

    public string ScratchRoot => Path.Combine(Root, "scratch");

    public string SessionDirectory(string sessionId)
    {
        if (!SafeName().IsMatch(sessionId))
            throw new ArgumentException("Invalid session id.", nameof(sessionId));
        return Path.Combine(SessionsRoot, sessionId);
    }

    public string CreateSessionDirectory(string sessionId)
    {
        var path = SessionDirectory(sessionId);
        Directory.CreateDirectory(path);
        return path;
    }

    public string CreateScratchDirectory(string purpose)
    {
        if (!SafeName().IsMatch(purpose))
            throw new ArgumentException("Invalid scratch purpose.", nameof(purpose));
        var path = Path.Combine(ScratchRoot, $"{purpose}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    /// <summary>Removes leftovers of a previous process; sessions never survive a restart.</summary>
    public void ResetVolatileState()
    {
        foreach (var directory in new[] { SessionsRoot, ScratchRoot })
        {
            TryDelete(directory);
            Directory.CreateDirectory(directory);
        }
    }

    public long SessionBytes()
    {
        try
        {
            return Directory.Exists(SessionsRoot)
                ? new DirectoryInfo(SessionsRoot).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length)
                : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    public static void TryDelete(string directory)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                if (Directory.Exists(directory))
                    Directory.Delete(directory, recursive: true);
                return;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Thread.Sleep(50);
            }
        }
    }

    private string Resolve(string configured, string fallback)
    {
        var path = string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, fallback)
            : Path.GetFullPath(configured, environment.ContentRootPath);
        path = Path.GetFullPath(path);
        var root = Path.GetPathRoot(path);
        if (!string.IsNullOrEmpty(root) && Path.TrimEndingDirectorySeparator(path) == Path.TrimEndingDirectorySeparator(root))
            throw new InvalidOperationException("The transcoding workspace cannot be a filesystem root.");
        return path;
    }

    [GeneratedRegex("^[A-Za-z0-9_-]{1,96}$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeName();
}
