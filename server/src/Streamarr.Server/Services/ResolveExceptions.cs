namespace Streamarr.Server.Services;

/// <summary>The requested releaseId is not registered with the server.</summary>
public sealed class ReleaseNotFoundException(string releaseId)
    : Exception($"No release '{releaseId}' is registered.")
{
    public string ReleaseId { get; } = releaseId;
}

/// <summary>The NZB carries nothing we can stream (no media file, empty RAR, …).</summary>
public sealed class NoPlayableFileException(string message) : Exception(message);
