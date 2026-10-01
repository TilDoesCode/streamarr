using System.Collections.Concurrent;
using System.Globalization;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Catalog;

/// <summary>Display labels of the best version by quality; device-independent (it describes what exists).</summary>
public sealed record CatalogSpecDto
{
    /// <summary><c>8K</c>, <c>4K</c>, <c>1080p</c>, <c>720p</c>, <c>576p</c>, <c>480p</c>, … or <c>SD</c>.</summary>
    public string? Resolution { get; init; }

    /// <summary><c>DV</c>, <c>HDR10+</c>, <c>HDR10</c>, <c>HLG</c>; null = SDR or not stated.</summary>
    public string? Hdr { get; init; }

    /// <summary><c>AV1</c>, <c>HEVC</c>, <c>H.264</c>, <c>VC-1</c>, <c>MPEG-2</c>, <c>XviD</c> or <c>DivX</c>.</summary>
    public string? VideoCodec { get; init; }

    /// <summary><c>Atmos</c>, a channel layout such as <c>7.1</c>, <c>5.1</c>, <c>2.0</c>, else the codec (e.g. <c>DTS</c>).</summary>
    public string? Audio { get; init; }
}

public static class CatalogSpecMapper
{
    /// <summary>Labels for one version; null when the name states nothing technical.</summary>
    public static CatalogSpecDto? From(VersionDto? version)
    {
        if (version is null)
            return null;
        var spec = new CatalogSpecDto
        {
            Resolution = version.Resolution switch
            {
                null => null,
                "4320p" => "8K",
                "2160p" => "4K",
                var r => r,
            },
            Hdr = version.Hdr switch
            {
                "dolbyvision" => "DV",
                "hdr10plus" => "HDR10+",
                "hdr10" => "HDR10",
                "hlg" => "HLG",
                _ => null,
            },
            VideoCodec = version.VideoCodec switch
            {
                null => null,
                "h264" => "H.264",
                "hevc" => "HEVC",
                "av1" => "AV1",
                "vc1" => "VC-1",
                "mpeg2" => "MPEG-2",
                "xvid" => "XviD",
                "divx" => "DivX",
                var c => c.ToUpperInvariant(),
            },
            Audio = version.Atmos ? "Atmos" : version.AudioChannels ?? AudioCodec(version.AudioCodec),
        };
        return spec is { Resolution: null, Hdr: null, VideoCodec: null, Audio: null } ? null : spec;
    }

    /// <summary>Orders summaries across lists (seasons of a series): resolution, HDR, codec generation, audio.</summary>
    public static long Score(CatalogSpecDto spec)
    {
        long height = spec.Resolution switch
        {
            "8K" => 4320,
            "4K" => 2160,
            "SD" or null => 0,
            var r when r.EndsWith('p') && int.TryParse(r[..^1], NumberStyles.None, CultureInfo.InvariantCulture, out var h) => h,
            _ => 0,
        };
        var hdr = spec.Hdr switch { "DV" => 4, "HDR10+" => 3, "HDR10" => 2, "HLG" => 1, _ => 0 };
        var codec = spec.VideoCodec switch { "AV1" => 3, "HEVC" => 2, "H.264" => 1, _ => 0 };
        var audio = spec.Audio switch
        {
            "Atmos" => 9,
            var a when a is not null && double.TryParse(a, NumberStyles.Float, CultureInfo.InvariantCulture, out var channels) => Math.Min(8, (int)channels),
            _ => 0,
        };
        return ((height * 10 + hdr) * 10 + codec) * 10 + audio;
    }

    private static string? AudioCodec(string? codec) => codec switch
    {
        null => null,
        "truehd" => "TrueHD",
        "dts-hd-ma" => "DTS-HD MA",
        "dts-hd" => "DTS-HD",
        "dts-x" => "DTS:X",
        "dts-es" or "dts" => "DTS",
        "eac3" => "EAC3",
        "ac3" => "AC3",
        "flac" => "FLAC",
        "opus" => "Opus",
        "aac" => "AAC",
        "mp3" => "MP3",
        "pcm" => "PCM",
        var c => c.ToUpperInvariant(),
    };
}

/// <summary>Spec summaries of the last version lookup per movie, episode and season, kept in memory and persisted; list payloads read it without searching.</summary>
public sealed class CatalogSpecStore(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    TimeProvider time,
    ILogger<CatalogSpecStore> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<string, CatalogSpecSummaryEntity> _entries = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, byte>> _seasonsBySeries = new(StringComparer.Ordinal);
    private readonly FailureLog _failures = new(logger);
    private readonly Channel<CatalogSpecSummaryEntity> _writes = Channel.CreateUnbounded<CatalogSpecSummaryEntity>(new UnboundedChannelOptions { SingleReader = true });

    /// <summary>Movie or episode ids read their own entry; a series id reads the best of its seasons.</summary>
    public CatalogSpecDto? Get(string workId)
    {
        if (_entries.TryGetValue(workId, out var entry))
            return Dto(entry);
        if (!workId.StartsWith("tmdb-tv-", StringComparison.Ordinal) || workId.AsSpan(8).ContainsAny('-', 's'))
            return null;
        if (!_seasonsBySeries.TryGetValue(workId, out var seasons))
            return null;
        return seasons.Keys
            .Select(id => _entries.TryGetValue(id, out var season) ? Dto(season) : null)
            .OfType<CatalogSpecDto>()
            .MaxBy(CatalogSpecMapper.Score);
    }

    /// <summary>The series id of a season work id (<c>tmdb-tv-7-s01</c> → <c>tmdb-tv-7</c>); null for anything else.</summary>
    internal static string? SeriesOfSeason(string workId)
    {
        if (!workId.StartsWith("tmdb-tv-", StringComparison.Ordinal))
            return null;
        var split = workId.IndexOf("-s", 8, StringComparison.Ordinal);
        return split > 8 && !workId.AsSpan(split + 2).Contains('e') && !workId.AsSpan(8, split - 8).ContainsAny('-', 's') ? workId[..split] : null;
    }

    private void Index(string workId)
    {
        if (SeriesOfSeason(workId) is { } series)
            _seasonsBySeries.GetOrAdd(series, _ => new ConcurrentDictionary<string, byte>(StringComparer.Ordinal)).TryAdd(workId, 0);
    }

    /// <summary>Records the best version of a work (null clears it, e.g. when no version is left).</summary>
    public void Record(string workId, CatalogSpecDto? spec)
    {
        var entity = new CatalogSpecSummaryEntity
        {
            WorkId = workId,
            Resolution = spec?.Resolution,
            Hdr = spec?.Hdr,
            VideoCodec = spec?.VideoCodec,
            Audio = spec?.Audio,
            UpdatedAt = time.GetUtcNow(),
        };
        if (_entries.TryGetValue(workId, out var existing) && Same(existing, entity))
            return;
        _entries[workId] = entity;
        Index(workId);
        _writes.Writer.TryWrite(entity);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);
            foreach (var row in await db.CatalogSpecSummaries.AsNoTracking().ToListAsync(stoppingToken))
                if (_entries.TryAdd(row.WorkId, row))
                    Index(row.WorkId);
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "Loading cached spec summaries failed");
        }

        await foreach (var entity in _writes.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                await using var db = await dbFactory.CreateDbContextAsync(stoppingToken);
                var existing = await db.CatalogSpecSummaries.FindAsync([entity.WorkId], stoppingToken);
                if (existing is null)
                    db.CatalogSpecSummaries.Add(entity);
                else
                    db.Entry(existing).CurrentValues.SetValues(entity);
                await db.SaveChangesAsync(stoppingToken);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _failures.Log(e, "Persisting the spec summary of {WorkId} failed", entity.WorkId);
            }
        }
    }

    private static CatalogSpecDto? Dto(CatalogSpecSummaryEntity e)
        => e is { Resolution: null, Hdr: null, VideoCodec: null, Audio: null }
            ? null
            : new CatalogSpecDto { Resolution = e.Resolution, Hdr = e.Hdr, VideoCodec = e.VideoCodec, Audio = e.Audio };

    private static bool Same(CatalogSpecSummaryEntity a, CatalogSpecSummaryEntity b)
        => a.Resolution == b.Resolution && a.Hdr == b.Hdr && a.VideoCodec == b.VideoCodec && a.Audio == b.Audio;
}
