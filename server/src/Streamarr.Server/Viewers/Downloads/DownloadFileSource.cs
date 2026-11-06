using System.Collections.Concurrent;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Usenet.Exceptions;

namespace Streamarr.Server.Viewers.Downloads;

/// <summary>The prepared file of a download: which release and work, and the file it must be (identical bytes).</summary>
public sealed record DownloadFileTarget(string DownloadId, string ViewerId, string ViewerName, string ReleaseId, string WorkId, string FileName, long SizeBytes);

/// <summary>Why the bytes of a download cannot be served right now.</summary>
public sealed class DownloadSourceException(int status, string code, string message, TimeSpan? retryAfter = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public TimeSpan? RetryAfter { get; } = retryAfter;
}

/// <summary>An open source of a download's bytes; dispose when the request ends.</summary>
public interface IDownloadFileLease : IAsyncDisposable
{
    /// <summary>A read-only stream positioned at <paramref name="offset"/>.</summary>
    Stream Open(long offset);
}

/// <summary>Opens the bytes of a download on demand (a live stream session, else a fresh resolve of the same release without fallback).</summary>
public interface IDownloadFileSource
{
    Task<IDownloadFileLease> OpenAsync(DownloadFileTarget target, CancellationToken ct);

    /// <summary>Lets go of the download's server resources (its stream session) once nothing needs them.</summary>
    void Release(string releaseId, string workId, string viewerId) { }
}

/// <summary>
/// Download bytes from a stream session of the transfer client: reused while alive, else resolved again (same release, no fallback,
/// one resolve per download at a time) and checked to be the prepared file; pinned while a request reads it.
/// </summary>
public sealed class SessionDownloadFileSource(
    SessionManager sessions,
    IPlaybackResolver resolver,
    DownloadNntpClient transferClient,
    IOptions<StreamarrOptions> options,
    ILogger<SessionDownloadFileSource> logger) : IDownloadFileSource
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> _resolving = new(StringComparer.Ordinal);

    public async Task<IDownloadFileLease> OpenAsync(DownloadFileTarget target, CancellationToken ct)
    {
        var session = Find(target) ?? await ResolveAsync(target, ct);
        if (session.File.SizeBytes != target.SizeBytes || !string.Equals(session.File.FileName, target.FileName, StringComparison.Ordinal))
        {
            logger.LogWarning("Download {DownloadId}: release {ReleaseId} now resolves to another file ({FileName}, {Size} bytes)",
                target.DownloadId, target.ReleaseId, session.File.FileName, session.File.SizeBytes);
            throw new DownloadSourceException(StatusCodes.Status409Conflict, "download_source_changed",
                "The release no longer resolves to the prepared file; prepare the download again.");
        }
        if (!session.TryPin())
            throw new DownloadSourceException(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable", "The stream session closed; retry.", TimeSpan.FromSeconds(2));
        return new Lease(sessions, session, transferClient, ReadAhead());
    }

    public void Release(string releaseId, string workId, string viewerId)
    {
        if (sessions.FindReusableSession(releaseId, workId, SessionManager.TransferClient, viewerId) is { IsPinned: false } session)
            sessions.CloseSession(session.Token);
    }

    private ActiveSession? Find(DownloadFileTarget target)
        => sessions.FindReusableSession(target.ReleaseId, target.WorkId, SessionManager.TransferClient, target.ViewerId) is { } found
           && found.Session.State == Core.Sessions.SessionState.Ready
            ? found
            : null;

    private async Task<ActiveSession> ResolveAsync(DownloadFileTarget target, CancellationToken ct)
    {
        var gate = _resolving.GetOrAdd(target.DownloadId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            if (Find(target) is { } raced)
                return raced;
            ResolveResponse response;
            try
            {
                response = await resolver.ResolveAsync(
                    new PlaybackResolveCall(target.ReleaseId, target.WorkId, target.ViewerId, target.ViewerName, AutoFallback: false, SessionManager.TransferClient),
                    NoObserver.Instance, ct);
            }
            catch (ResourceCapacityException)
            {
                throw new DownloadSourceException(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable",
                    "The server is busy opening other streams; retry shortly.", TimeSpan.FromSeconds(5));
            }
            catch (Exception e) when (e is UsenetException or HttpRequestException or IOException or TimeoutException)
            {
                throw new DownloadSourceException(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable",
                    "Usenet or the indexer cannot be reached right now; retry shortly.", TimeSpan.FromSeconds(30));
            }
            catch (Exception e) when (e is ReleaseNotFoundException or NoPlayableFileException or InvalidDataException)
            {
                throw new DownloadSourceException(StatusCodes.Status410Gone, "download_source_gone", "The release of this download is no longer available.");
            }
            if (response.Status == "dead")
                throw new DownloadSourceException(StatusCodes.Status410Gone, "download_source_gone", "The release of this download is missing data on Usenet now.");
            var token = response.StreamUrl is { Length: > 0 } url ? Uri.UnescapeDataString(url[(url.LastIndexOf('/') + 1)..]) : null;
            if (token is null || !sessions.TryGetSession(token, out var session))
                throw new DownloadSourceException(StatusCodes.Status503ServiceUnavailable, "download_source_unavailable", "The stream session closed; retry.", TimeSpan.FromSeconds(2));
            return session;
        }
        finally
        {
            gate.Release();
            if (gate.CurrentCount == 1)
                _resolving.TryRemove(new KeyValuePair<string, SemaphoreSlim>(target.DownloadId, gate));
        }
    }

    private int ReadAhead() => Math.Clamp(options.Value.ArticleReadAheadCount * 2, 2, 16);

    private sealed class Lease(SessionManager sessions, ActiveSession session, DownloadNntpClient client, int readAhead) : IDownloadFileLease
    {
        private int _disposed;

        public Stream Open(long offset)
        {
            var stream = sessions.OpenTransferStream(session, client, readAhead);
            if (offset > 0)
                stream.Seek(offset, SeekOrigin.Begin);
            return stream;
        }

        public ValueTask DisposeAsync()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
                session.Unpin();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class NoObserver : IResolveObserver
    {
        public static readonly NoObserver Instance = new();

        public void HopStarted(string releaseId, int hop)
        {
        }

        public void HopFinished(string releaseId, string status)
        {
        }
    }
}
