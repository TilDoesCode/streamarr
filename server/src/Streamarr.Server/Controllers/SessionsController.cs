using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Streamarr.Server.Auth;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Controllers;

/// <summary>GET /api/v1/sessions + POST /api/v1/sessions/{token}/close (BRIEF §6.2).</summary>
[ApiController]
[Route("api/v1/sessions")]
public class SessionsController(SessionManager sessionManager) : ControllerBase
{
    [HttpGet]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(IReadOnlyList<SessionResponse>), StatusCodes.Status200OK)]
    public ActionResult<IReadOnlyList<SessionResponse>> List()
        => Ok(sessionManager.ListSessions().Select(ToResponse).ToList());

    [HttpPost("{token}/close")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult Close(string token)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        return sessionManager.CloseSession(token)
            ? NoContent()
            : NotFound(ErrorResponse.Of("unknown_session", "No live session exists for this token."));
    }

    [HttpGet("{token}/articles")]
    [Authorize(Policy = AuthRoles.AdminPolicy)]
    [ProducesResponseType(typeof(ArticleMapResponse), StatusCodes.Status200OK)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public ActionResult<ArticleMapResponse> Articles(string token)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        var tracker = sessionManager.GetArticleTracker(token);
        if (tracker is not null)
        {
            var snapshot = tracker.Snapshot();
            if (sessionManager.TryGetSession(token, out var live))
                snapshot = snapshot with { DeliveredRanges = DeliveredRanges(live) };
            return Ok(snapshot);
        }

        if (sessionManager.TryGetSession(token, out var active))
        {
            return Ok(new ArticleMapResponse
            {
                ReleaseId = active.Session.ReleaseId,
                UpdatedAt = active.Session.LastAccessedAt,
            });
        }

        return NotFound(ErrorResponse.Of("unknown_session", "No live or retained session exists for this token."));
    }

    /// <summary>
    /// Appends client-observed spans (Jellyfin's PlaybackInfo→first delivered frame) to a live
    /// session's request→first-frame timeline so the stream page flamegraph spans both processes.
    /// The capability token is the authorization (same model as the anonymous close), so this
    /// stays player-agnostic and needs no machine credential in the player.
    /// </summary>
    [HttpPost("{token}/timeline")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status204NoContent)]
    [ProducesResponseType(typeof(ErrorResponse), StatusCodes.Status404NotFound)]
    public IActionResult AppendTimeline(string token, [FromBody] ClientTimelineRequest request)
    {
        Response.Headers.CacheControl = "private, no-store, max-age=0";
        if (!sessionManager.TryGetSession(token, out var session) || session.Timeline is null)
            return NotFound(ErrorResponse.Of("unknown_session", "No live session exists for this token."));

        foreach (var span in (request?.Spans ?? []).Take(TtffTimeline.MaxSpans))
        {
            session.Timeline.Add(
                span.Name,
                string.IsNullOrWhiteSpace(span.Category) ? "client" : span.Category!,
                span.StartMs,
                span.DurationMs,
                span.Detail,
                source: "client");
        }

        return NoContent();
    }

    private static SessionResponse ToResponse(ActiveSession active)
    {
        var articles = active.ArticleTracker?.Snapshot();
        return new()
        {
            Token = active.Token,
            ReleaseId = active.Session.ReleaseId,
            WorkId = active.Session.WorkId,
            Title = active.Title,
            FileName = active.File.FileName,
            State = active.Session.State.ToString().ToLowerInvariant(),
            Container = active.Session.Container,
            SizeBytes = active.Session.SizeBytes,
            BytesServed = active.BytesServed,
            IsStreaming = active.IsStreaming,
            RunTimeTicks = active.RunTimeTicks > 0 ? active.RunTimeTicks : null,
            RequiredBytesPerSecond = RequiredBytesPerSecond(active),
            DownloadBytesPerSecond = active.ArticleTracker?.RecentDownloadBytesPerSecond,
            FailedArticles = articles?.FailedArticles ?? 0,
            MissingArticles = articles?.MissingArticles ?? 0,
            ActiveArticles = articles?.ActiveArticles ?? 0,
            BufferedPercent = BufferedPercentFor(active, articles),
            BufferedRanges = BufferedRangesFor(active, articles),
            NntpConnectionsInFlight = active.NntpUsage.InFlight,
            NntpCommandsTotal = active.NntpUsage.TotalCommands,
            Client = active.Session.Client,
            RequestedById = active.Session.RequestedById,
            RequestedByName = active.Session.RequestedByName,
            CreatedAt = active.Session.CreatedAt,
            LastAccessedAt = active.Session.LastAccessedAt,
            ExpiresAt = active.ExpiresAt,
            RetentionPriority = active.RetentionPriority.ToString().ToLowerInvariant(),
            PreDownloadJobId = active.PreDownloadJobId,
            PreDownloadKind = active.PreDownloadKind,
            PreDownloadReason = active.PreDownloadReason,
            PreDownloadSourceToken = active.PreDownloadSourceToken,
            PreDownloadState = PreDownloadState(active),
            PreDownloadedBytes = active.PreDownloadCache?.DownloadedBytes ?? 0,
            PreDownloadTotalBytes = active.PreDownloadCache?.TotalBytes ?? 0,
            PreDownloadPercent = PreDownloadPercent(active),
            LocalCacheReady = active.PreDownloadCache?.IsComplete == true,
            TimelineStartedAt = active.Timeline?.StartedAt,
            Timeline = active.Timeline is null
                ? []
                : active.Timeline.Snapshot().Select(s => new TtffSpanResponse
                {
                    Name = s.Name,
                    Category = s.Category,
                    StartMs = s.StartMs,
                    DurationMs = s.DurationMs,
                    Detail = s.Detail,
                    Source = s.Source,
                }).ToList(),
        };
    }

    /// <summary>Share of the release payload buffered from Usenet; a completed pre-download is 100%.</summary>
    private static double? BufferedPercentFor(ActiveSession active, ArticleMapResponse? articles)
    {
        if (active.PreDownloadCache?.IsComplete == true)
            return 100;
        if (articles is null || articles.TotalExpectedBytes <= 0)
            return null;
        return Math.Min(100, articles.BufferedBytes * 100d / articles.TotalExpectedBytes);
    }

    private static IReadOnlyList<ByteRangeResponse> BufferedRangesFor(ActiveSession active, ArticleMapResponse? articles)
    {
        if (active.PreDownloadCache?.IsComplete == true)
            return [new ByteRangeResponse { Start = 0, End = 1 }];
        return articles is null ? [] : ArticleDownloadTracker.Coarsen(articles.BufferedRanges, 32);
    }

    /// <summary>Payload intervals the client actually pulled, mapped through the article manifest.</summary>
    private static IReadOnlyList<ByteRangeResponse> DeliveredRanges(ActiveSession active)
    {
        var manifest = active.File.ArticleManifest;
        if (manifest.Count == 0)
            return [];
        var queried = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in active.QueriedChunkIds)
        {
            queried.Add(id);
            queried.Add(id.Trim('<', '>'));
        }
        if (queried.Count == 0)
            return [];

        long offset = 0;
        var intervals = new List<(long Start, long End)>();
        foreach (var entry in manifest)
        {
            var weight = entry.ExpectedBytes > 0 ? entry.ExpectedBytes : 1;
            if (queried.Contains(entry.MessageId) || queried.Contains(entry.MessageId.Trim('<', '>')))
            {
                if (intervals.Count > 0 && intervals[^1].End == offset)
                    intervals[^1] = (intervals[^1].Start, offset + weight);
                else
                    intervals.Add((offset, offset + weight));
            }
            offset += weight;
        }
        return ArticleDownloadTracker.ToFractionRanges(intervals, offset, maxRanges: 128);
    }

    /// <summary>Average byte rate the media needs for realtime playback; null until probed.</summary>
    private static double? RequiredBytesPerSecond(ActiveSession active)
    {
        if (active.Session.SizeBytes <= 0 || active.RunTimeTicks <= 0)
            return null;
        var durationSeconds = active.RunTimeTicks / (double)TimeSpan.TicksPerSecond;
        var rate = active.Session.SizeBytes / durationSeconds;
        return double.IsFinite(rate) && rate > 0 ? rate : null;
    }

    private static string? PreDownloadState(ActiveSession active) => active.PreDownloadCache switch
    {
        null => null,
        { IsComplete: true } => "completed",
        { IsCancelled: true } => "cancelled",
        _ => "downloading",
    };

    private static double PreDownloadPercent(ActiveSession active)
        => active.PreDownloadCache is not { } cache || cache.TotalBytes <= 0
            ? 0
            : Math.Min(100, cache.DownloadedBytes * 100d / cache.TotalBytes);
}
