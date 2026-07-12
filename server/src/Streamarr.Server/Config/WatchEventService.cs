using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Config;

/// <summary>
/// Ingests and stores playback events from any front-end (BRIEF §6.1 module 7 / §6.2
/// POST /events). A singleton over <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class WatchEventService(IDbContextFactory<StreamarrDbContext> dbFactory, TimeProvider time)
{
    public async Task<WatchEventEntity> RecordAsync(WatchEventWrite write, CancellationToken ct)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var entity = new WatchEventEntity
        {
            ReleaseId = write.ReleaseId,
            WorkId = write.WorkId ?? string.Empty,
            Event = write.Event,
            PositionTicks = write.PositionTicks ?? 0,
            Source = write.Source ?? string.Empty,
            ReceivedAt = time.GetUtcNow(),
        };
        db.WatchEvents.Add(entity);
        await db.SaveChangesAsync(ct);
        return entity;
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
