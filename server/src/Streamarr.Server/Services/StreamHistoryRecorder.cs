using System.Security.Cryptography;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Services;

/// <summary>Everything known about a resolve attempt at the moment it starts.</summary>
public sealed record StreamAttemptBegin
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }
    public string? Title { get; init; }
    public string? Client { get; init; }
    public string? RequestedById { get; init; }
    public string? RequestedByName { get; init; }
}

/// <summary>One chronological diagnostic entry to append to an in-flight attempt.</summary>
public sealed record StreamEventWrite(
    DateTimeOffset AtUtc,
    string Source,
    string Category,
    string Name,
    string? Detail = null,
    double? StartMs = null,
    double? DurationMs = null);

/// <summary>Terminal snapshot applied when an attempt/session reaches the end of its life.</summary>
public sealed record StreamRecordFinalize
{
    public required string FinalState { get; init; }
    public string? CloseReason { get; init; }
    public string? ResolvedReleaseId { get; init; }
    public string? ResolvedTitle { get; init; }
    public string? Container { get; init; }
    public long? SizeBytes { get; init; }
    public long? BytesServed { get; init; }
    public long? NntpCommandsTotal { get; init; }
}

/// <summary>Small projection used by high-frequency log polling; intentionally excludes events.</summary>
internal sealed record StreamCorrelationRecord(
    string AttemptId,
    string ReleaseId,
    string? WorkId);

/// <summary>
/// The write-side, hot-path-safe surface of <see cref="StreamHistoryRecorder"/> — extracted
/// purely as a test seam (mirrors <c>IReleaseHealthCache</c>/<c>IRepairStreamGateway</c>) so
/// <c>SessionManager</c>/<c>ResolveService</c> tests can inject a synchronous fake instead of
/// standing up the real background consumer and SQLite. Every method is non-blocking.
/// </summary>
public interface IStreamHistoryRecorder
{
    string BeginAttempt(StreamAttemptBegin begin);
    void AttachToken(string attemptId, string sessionToken);
    void AppendEvents(string? attemptId, IReadOnlyList<StreamEventWrite> events);
    void Finalize(string? attemptId, StreamRecordFinalize finalize);
}

/// <summary>
/// Permanent, bounded (<see cref="StreamarrOptions.MaxRetainedStreams"/>) history of
/// stream attempts and their full diagnostic timeline (TTFF spans, folded-in PAR2
/// repair events, session lifecycle, errors) — so a stream can be dissected after the
/// fact even once its in-memory session/timeline is long gone (the Management UI's
/// per-stream console, BRIEF §11).
///
/// Every producer-facing method is a non-blocking bounded-channel write: no caller on
/// the resolve or byte-serving hot path ever touches SQLite directly. A single
/// background consumer applies operations strictly in enqueue order, so a
/// <see cref="BeginAttempt"/> is always durable-queued before any later op referencing
/// its id can be. Modeled after <see cref="PushoverNotificationService"/>.
/// </summary>
public sealed class StreamHistoryRecorder(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<StreamHistoryRecorder> logger) : BackgroundService, IStreamHistoryRecorder
{
    private readonly Channel<StreamHistoryOp> _queue = Channel.CreateBounded<StreamHistoryOp>(
        new BoundedChannelOptions(512)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

    /// <summary>Allocates the attempt id in-process and returns immediately — zero I/O.</summary>
    public string BeginAttempt(StreamAttemptBegin begin)
    {
        var attemptId = "attempt-" + RandomNumberGenerator.GetHexString(32, lowercase: true);
        _queue.Writer.TryWrite(new BeginOp(attemptId, begin, time.GetUtcNow()));
        return attemptId;
    }

    /// <summary>Records the real session token once <see cref="SessionManager"/> mints one for this attempt.</summary>
    public void AttachToken(string attemptId, string sessionToken)
        => _queue.Writer.TryWrite(new AttachTokenOp(attemptId, sessionToken));

    public void AppendEvents(string? attemptId, IReadOnlyList<StreamEventWrite> events)
    {
        if (string.IsNullOrEmpty(attemptId) || events.Count == 0)
            return;
        _queue.Writer.TryWrite(new AppendEventsOp(attemptId, events));
    }

    /// <summary>Closes the row out. Also triggers retention pruning once applied.</summary>
    public void Finalize(string? attemptId, StreamRecordFinalize finalize)
    {
        if (string.IsNullOrEmpty(attemptId))
            return;
        _queue.Writer.TryWrite(new FinalizeOp(attemptId, finalize, time.GetUtcNow()));
    }

    /// <summary>
    /// Newest-first summaries with only failure evidence eagerly loaded. Ordered by <c>Id</c>
    /// rather than <c>CreatedAt</c> — rows are inserted in arrival order so the two agree in
    /// practice, and SQLite's EF provider cannot translate an ORDER BY over a DateTimeOffset
    /// column.
    /// </summary>
    public async Task<IReadOnlyList<StreamRecordEntity>> ListAsync(int limit, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.StreamRecords
            .AsNoTracking()
            .Include(r => r.Events.Where(e =>
                e.Source == "error" || (e.Source == "repair" && e.Name == "Failed")))
            .OrderByDescending(r => r.Id)
            .Take(Math.Clamp(limit, 1, 500))
            .ToListAsync(ct);
    }

    /// <summary>Converts a TTFF span snapshot into writes anchored to the timeline's wall-clock t0.</summary>
    public static IReadOnlyList<StreamEventWrite> EventsFromTimeline(TtffTimeline? timeline)
    {
        if (timeline is null)
            return [];
        return [.. timeline.Snapshot().Select(span => new StreamEventWrite(
            AtUtc: timeline.StartedAt.AddMilliseconds(span.StartMs),
            Source: "ttff",
            Category: span.Category,
            Name: span.Name,
            Detail: span.Detail,
            StartMs: span.StartMs,
            DurationMs: span.DurationMs))];
    }

    /// <summary>One record with its full, time-ordered event timeline. Matches a live token or a synthetic attempt id.</summary>
    public async Task<StreamRecordEntity?> GetAsync(string tokenOrAttemptId, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var record = await db.StreamRecords
            .AsNoTracking()
            // Sorted client-side below: SQLite's EF provider cannot translate an ORDER BY over
            // a DateTimeOffset column, including inside a filtered Include.
            .Include(r => r.Events)
            .FirstOrDefaultAsync(r => r.Token == tokenOrAttemptId || r.AttemptId == tokenOrAttemptId, ct);
        record?.Events.Sort((a, b) => a.AtUtc.CompareTo(b.AtUtc));
        return record;
    }

    /// <summary>
    /// Resolves a live-token or attempt id without loading the potentially large event
    /// collection. The log viewer polls frequently, so its correlation lookup must stay cheap.
    /// </summary>
    internal async Task<StreamCorrelationRecord?> GetCorrelationAsync(
        string tokenOrAttemptId,
        CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.StreamRecords
            .AsNoTracking()
            .Where(record => record.Token == tokenOrAttemptId || record.AttemptId == tokenOrAttemptId)
            .Select(record => new StreamCorrelationRecord(
                record.AttemptId,
                record.ReleaseId,
                record.WorkId))
            .FirstOrDefaultAsync(ct);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await foreach (var op in _queue.Reader.ReadAllAsync(stoppingToken))
            {
                try
                {
                    await ApplyAsync(op, stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    break;
                }
                catch (Exception exception)
                {
                    logger.LogWarning(exception, "Stream history write failed ({FailureType})", exception.GetType().Name);
                }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // ReadAllAsync observes host shutdown before a queued item reaches the loop body.
        }
    }

    private async Task ApplyAsync(StreamHistoryOp op, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        switch (op)
        {
            case BeginOp begin:
                db.StreamRecords.Add(new StreamRecordEntity
                {
                    AttemptId = begin.AttemptId,
                    CreatedAt = begin.At,
                    ReleaseId = begin.Begin.ReleaseId,
                    WorkId = begin.Begin.WorkId ?? string.Empty,
                    Title = begin.Begin.Title,
                    Client = begin.Begin.Client,
                    RequestedById = begin.Begin.RequestedById,
                    RequestedByName = begin.Begin.RequestedByName,
                    TimelineStartedAt = begin.At,
                });
                await db.SaveChangesAsync(ct);
                return;

            case AttachTokenOp attach:
            {
                var record = await db.StreamRecords.FirstOrDefaultAsync(r => r.AttemptId == attach.AttemptId, ct);
                if (record is null)
                {
                    logger.LogDebug("Stream history: AttachToken for unknown attempt {AttemptId}", attach.AttemptId);
                    return;
                }
                record.Token = attach.Token;
                await db.SaveChangesAsync(ct);
                return;
            }

            case AppendEventsOp append:
            {
                var recordId = await db.StreamRecords
                    .Where(r => r.AttemptId == append.AttemptId)
                    .Select(r => (long?)r.Id)
                    .FirstOrDefaultAsync(ct);
                if (recordId is null)
                {
                    logger.LogDebug("Stream history: AppendEvents for unknown attempt {AttemptId}", append.AttemptId);
                    return;
                }
                foreach (var e in append.Events)
                {
                    db.StreamEvents.Add(new StreamEventEntity
                    {
                        StreamRecordId = recordId.Value,
                        AtUtc = e.AtUtc,
                        Source = e.Source,
                        Category = e.Category,
                        Name = e.Name,
                        Detail = e.Detail,
                        StartMs = e.StartMs,
                        DurationMs = e.DurationMs,
                    });
                }
                await db.SaveChangesAsync(ct);
                return;
            }

            case FinalizeOp finalize:
            {
                var record = await db.StreamRecords.FirstOrDefaultAsync(r => r.AttemptId == finalize.AttemptId, ct);
                if (record is null)
                {
                    logger.LogDebug("Stream history: Finalize for unknown attempt {AttemptId}", finalize.AttemptId);
                    return;
                }
                record.FinalState = finalize.Finalize.FinalState;
                record.CloseReason = finalize.Finalize.CloseReason;
                record.ClosedAt = finalize.At;
                if (finalize.Finalize.ResolvedReleaseId is not null)
                    record.ResolvedReleaseId = finalize.Finalize.ResolvedReleaseId;
                if (finalize.Finalize.ResolvedTitle is not null)
                    record.ResolvedTitle = finalize.Finalize.ResolvedTitle;
                if (finalize.Finalize.Container is not null) record.Container = finalize.Finalize.Container;
                if (finalize.Finalize.SizeBytes is not null) record.SizeBytes = finalize.Finalize.SizeBytes;
                if (finalize.Finalize.BytesServed is not null) record.BytesServed = finalize.Finalize.BytesServed.Value;
                if (finalize.Finalize.NntpCommandsTotal is not null) record.NntpCommandsTotal = finalize.Finalize.NntpCommandsTotal.Value;
                await db.SaveChangesAsync(ct);
                await PruneAsync(db, ct);
                return;
            }
        }
    }

    /// <summary>
    /// Deletes the oldest rows beyond the retention cap. Only ever considers *closed*
    /// rows (<c>FinalState != null</c>) — a still-open/live row can never be pruned out
    /// from under it, so the table may transiently exceed the cap by the number of
    /// currently-open sessions and converges back down as they close.
    /// </summary>
    private async Task PruneAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var cap = Math.Max(1, options.Value.MaxRetainedStreams);
        var closedCount = await db.StreamRecords.CountAsync(r => r.FinalState != null, ct);
        var overflow = closedCount - cap;
        if (overflow <= 0)
            return;

        // Ordered by Id (arrival order), not CreatedAt — see the ListAsync doc comment.
        var victims = await db.StreamRecords
            .Where(r => r.FinalState != null)
            .OrderBy(r => r.Id)
            .Take(overflow)
            .ToListAsync(ct);
        if (victims.Count == 0)
            return;

        db.StreamRecords.RemoveRange(victims);
        await db.SaveChangesAsync(ct);
    }

    private abstract record StreamHistoryOp;
    private sealed record BeginOp(string AttemptId, StreamAttemptBegin Begin, DateTimeOffset At) : StreamHistoryOp;
    private sealed record AttachTokenOp(string AttemptId, string Token) : StreamHistoryOp;
    private sealed record AppendEventsOp(string AttemptId, IReadOnlyList<StreamEventWrite> Events) : StreamHistoryOp;
    private sealed record FinalizeOp(string AttemptId, StreamRecordFinalize Finalize, DateTimeOffset At) : StreamHistoryOp;
}
