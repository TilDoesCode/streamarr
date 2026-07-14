using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>
/// Ingests and stores playback events from any front-end (BRIEF §6.1 module 7 / §6.2
/// POST /events). A singleton over <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class WatchEventService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    TimeProvider time,
    IOptions<StreamarrOptions> options)
{
    private readonly SemaphoreSlim _writeGate = new(1, 1);

    public async Task<WatchEventEntity> RecordAsync(WatchEventWrite write, CancellationToken ct)
    {
        await _writeGate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var workId = write.WorkId ?? string.Empty;
            var source = write.Source ?? string.Empty;
            var receivedAt = time.GetUtcNow();

            // Progress is mutable watch state, not an audit log. Keep one row per
            // source/work/release and update it instead of growing on every heartbeat.
            if (string.Equals(write.Event, "progress", StringComparison.Ordinal))
            {
                var existing = await db.WatchEvents
                    .Where(e => e.Event == "progress" &&
                                e.ReleaseId == write.ReleaseId &&
                                e.WorkId == workId &&
                                e.Source == source)
                    .OrderByDescending(e => e.Id)
                    .FirstOrDefaultAsync(ct);
                if (existing is not null)
                {
                    existing.PositionTicks = write.PositionTicks ?? 0;
                    existing.ReceivedAt = receivedAt;
                    await db.SaveChangesAsync(ct);
                    await PruneAsync(db, ct);
                    return existing;
                }
            }

            var entity = new WatchEventEntity
            {
                ReleaseId = write.ReleaseId,
                WorkId = workId,
                Event = write.Event,
                PositionTicks = write.PositionTicks ?? 0,
                Source = source,
                ReceivedAt = receivedAt,
            };
            db.WatchEvents.Add(entity);
            await db.SaveChangesAsync(ct);

            await PruneAsync(db, ct);

            return entity;
        }
        finally
        {
            _writeGate.Release();
        }
    }

    private async Task PruneAsync(StreamarrDbContext db, CancellationToken ct)
    {
        var overflow = await db.WatchEvents.LongCountAsync(ct) - options.Value.MaxWatchEvents;
        if (overflow <= 0)
            return;

        await db.Database.ExecuteSqlInterpolatedAsync($"""
            DELETE FROM "WatchEvents"
            WHERE "Id" IN (
                SELECT "Id" FROM "WatchEvents"
                ORDER BY "ReceivedAt", "Id" LIMIT {overflow}
            )
            """, ct);
    }

    public async Task<IReadOnlyList<WatchEventEntity>> RecentAsync(int limit, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.WatchEvents.AsNoTracking()
            .OrderByDescending(e => e.Id)
            .Take(Math.Clamp(limit, 1, 500))
            .ToListAsync(ct);
    }

    public async Task<int> CountAsync(CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return await db.WatchEvents.CountAsync(ct);
    }
}

/// <summary>Validated playback event (BRIEF §6.2).</summary>
public sealed record WatchEventWrite
{
    public required string ReleaseId { get; init; }
    public string? WorkId { get; init; }
    public required string Event { get; init; }
    public long? PositionTicks { get; init; }
    public string? Source { get; init; }
}
