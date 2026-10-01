using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>The real container family (<c>mp4</c>, <c>mkv</c>, …) of releases the server has opened, so predictions stop assuming it; persisted, least recently used evicted.</summary>
public sealed class ReleaseContainerStore(
    IDbContextFactory<StreamarrDbContext>? dbFactory = null,
    SessionManager? sessions = null,
    TimeProvider? time = null,
    ILogger<ReleaseContainerStore>? logger = null) : BackgroundService
{
    public const int DefaultMaxEntries = 20_000;
    private static readonly TimeSpan TouchInterval = TimeSpan.FromHours(6);

    private sealed class Entry(string family, DateTimeOffset used)
    {
        public string Family { get; } = family;
        public DateTimeOffset LastUsed { get; set; } = used;
        public DateTimeOffset Persisted { get; set; } = used;
    }

    private sealed record Write(ReleaseContainerEntity? Upsert, IReadOnlyList<string>? Delete);

    private readonly ConcurrentDictionary<string, Entry> _known = new(StringComparer.Ordinal);
    private readonly Channel<Write> _writes = Channel.CreateUnbounded<Write>(new UnboundedChannelOptions { SingleReader = true });
    private readonly object _evict = new();
    private readonly TimeProvider _time = time ?? TimeProvider.System;
    private readonly FailureLog? _failures = logger is null ? null : new FailureLog(logger);

    public int MaxEntries { get; init; } = DefaultMaxEntries;

    public int Count => _known.Count;

    /// <summary>Records a file extension (<c>mp4</c>) or an ffprobe format name (<c>mov,mp4,m4a,…</c>).</summary>
    public void Record(string? releaseId, string? container)
    {
        if (string.IsNullOrEmpty(releaseId) || Family(container) is not { } family)
            return;
        var now = _time.GetUtcNow();
        if (_known.TryGetValue(releaseId, out var existing) && existing.Family == family)
        {
            Touch(releaseId, existing, now);
            return;
        }
        _known[releaseId] = new Entry(family, now);
        Persist(releaseId, family, now);
        if (_known.Count > MaxEntries)
            Evict();
    }

    public string? Get(string releaseId)
    {
        if (_known.TryGetValue(releaseId, out var entry))
        {
            Touch(releaseId, entry, _time.GetUtcNow());
            return entry.Family;
        }
        var session = sessions?.ListSessions().FirstOrDefault(s => string.Equals(s.Session.ReleaseId, releaseId, StringComparison.Ordinal));
        if (session is null)
            return null;
        Record(releaseId, session.File.Container);
        return _known.TryGetValue(releaseId, out var recorded) ? recorded.Family : null;
    }

    private void Touch(string releaseId, Entry entry, DateTimeOffset now)
    {
        entry.LastUsed = now;
        if (now - entry.Persisted < TouchInterval)
            return;
        entry.Persisted = now;
        Persist(releaseId, entry.Family, now);
    }

    private void Persist(string releaseId, string family, DateTimeOffset now)
    {
        if (dbFactory is not null)
            _writes.Writer.TryWrite(new Write(new ReleaseContainerEntity { ReleaseId = releaseId, Family = family, LastUsedAt = now }, null));
    }

    /// <summary>Drops the least recently used tenth once the store is over its limit.</summary>
    private void Evict()
    {
        lock (_evict)
        {
            var excess = _known.Count - MaxEntries;
            if (excess <= 0)
                return;
            var victims = _known.OrderBy(p => p.Value.LastUsed).Take(excess + MaxEntries / 10).Select(p => p.Key).ToList();
            foreach (var id in victims)
                _known.TryRemove(id, out _);
            if (dbFactory is not null)
                _writes.Writer.TryWrite(new Write(null, victims));
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (dbFactory is null)
            return;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);
            var rows = await db.ReleaseContainers.AsNoTracking().OrderByDescending(r => r.LastUsedAt).ToListAsync(stoppingToken);
            foreach (var row in rows.Take(MaxEntries))
                _known.TryAdd(row.ReleaseId, new Entry(row.Family, row.LastUsedAt));
            if (rows.Count > MaxEntries)
                _writes.Writer.TryWrite(new Write(null, rows.Skip(MaxEntries).Select(r => r.ReleaseId).ToList()));
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger?.LogWarning(e, "Loading the known release containers failed");
        }

        await foreach (var write in _writes.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);
                if (write.Delete is { } ids)
                {
                    foreach (var chunk in ids.Chunk(500))
                        await db.ReleaseContainers.Where(r => chunk.Contains(r.ReleaseId)).ExecuteDeleteAsync(stoppingToken);
                    continue;
                }
                var entity = write.Upsert!;
                var existing = await db.ReleaseContainers.FindAsync([entity.ReleaseId], stoppingToken);
                if (existing is null)
                    db.ReleaseContainers.Add(entity);
                else
                    db.Entry(existing).CurrentValues.SetValues(entity);
                await db.SaveChangesAsync(stoppingToken);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _failures?.Log(e, "Persisting known release containers failed");
            }
        }
    }

    /// <summary>The ffprobe format name the planner expects for a container family.</summary>
    public static string FormatName(string family) => family switch
    {
        "mp4" => "mov,mp4,m4a,3gp,3g2,mj2",
        "mkv" => "matroska,webm",
        "ts" => "mpegts",
        _ => family,
    };

    internal static string? Family(string? container)
    {
        var value = container?.Trim().TrimStart('.').ToLowerInvariant();
        if (string.IsNullOrEmpty(value) || value.Length > 64)
            return null;
        return value switch
        {
            "mkv" or "webm" or "mk3d" => "mkv",
            "mp4" or "m4v" or "mov" => "mp4",
            "ts" or "m2ts" or "mts" => "ts",
            _ when value.Contains(',') => TranscodePlanner.ContainerFamily(value),
            _ => value,
        };
    }
}
