using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Transcoding;

/// <summary>SQLite-backed transcoding policy with an atomically published in-memory snapshot.</summary>
public sealed class TranscodingSettingsService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ILogger<TranscodingSettingsService> logger)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private TranscodingSettings _current = new();
    private bool _loaded;

    public TranscodingSettings Current => Volatile.Read(ref _current);

    public event Action<TranscodingSettings, TranscodingSettings>? Changed;

    public async Task<TranscodingSettings> GetAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _loaded))
            return Current;
        await _gate.WaitAsync(ct);
        try
        {
            if (!_loaded)
            {
                await using var db = await dbFactory.CreateDbContextAsync(ct);
                var entity = await db.TranscodingConfig.AsNoTracking().SingleOrDefaultAsync(x => x.Id == 1, ct);
                Volatile.Write(ref _current, entity is null ? new TranscodingSettings() : Deserialize(entity.SettingsJson));
                Volatile.Write(ref _loaded, true);
            }
            return Current;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<TranscodingSettings> SaveAsync(TranscodingSettings settings, CancellationToken ct)
    {
        var errors = settings.Validate();
        if (errors.Count > 0)
            throw new ArgumentException(string.Join(" ", errors));

        await _gate.WaitAsync(ct);
        TranscodingSettings previous;
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await db.TranscodingConfig.SingleOrDefaultAsync(x => x.Id == 1, ct);
            if (entity is null)
            {
                entity = new TranscodingConfigEntity { Id = 1 };
                db.TranscodingConfig.Add(entity);
            }
            entity.SettingsJson = JsonSerializer.Serialize(settings, Json);
            entity.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            previous = Current;
            Volatile.Write(ref _current, settings);
            Volatile.Write(ref _loaded, true);
        }
        finally
        {
            _gate.Release();
        }
        Changed?.Invoke(previous, settings);
        return settings;
    }

    private TranscodingSettings Deserialize(string json)
    {
        try
        {
            var settings = JsonSerializer.Deserialize<TranscodingSettings>(json, Json) ?? new TranscodingSettings();
            if (settings.Validate() is { Count: > 0 } errors)
            {
                logger.LogWarning("Stored transcoding settings are invalid ({Errors}); using defaults", string.Join(" ", errors));
                return new TranscodingSettings();
            }
            return settings;
        }
        catch (JsonException e)
        {
            logger.LogWarning(e, "Stored transcoding settings could not be read; using defaults");
            return new TranscodingSettings();
        }
    }
}

/// <summary>Caches the (slow) capability probe; one detection runs at a time and is shared by all callers.</summary>
public sealed class FfmpegCapabilityService(
    FfmpegCapabilityProbe probe,
    TranscodingSettingsService settings,
    IHostApplicationLifetime lifetime,
    ILogger<FfmpegCapabilityService> logger)
{
    private readonly object _lock = new();
    private FfmpegCapabilities? _cached;
    private Task<FfmpegCapabilities>? _running;

    public FfmpegCapabilities? Cached => Volatile.Read(ref _cached);

    public bool Detecting
    {
        get
        {
            lock (_lock)
                return _running is { IsCompleted: false };
        }
    }

    public Task<FfmpegCapabilities> GetAsync(CancellationToken ct)
        => Cached is { } cached ? Task.FromResult(cached) : RefreshAsync(ct);

    public Task<FfmpegCapabilities> RefreshAsync(CancellationToken ct)
    {
        Task<FfmpegCapabilities> task;
        lock (_lock)
        {
            _running ??= DetectAsync();
            task = _running;
        }
        return task.WaitAsync(ct);
    }

    private async Task<FfmpegCapabilities> DetectAsync()
    {
        await Task.Yield();
        try
        {
            var current = await settings.GetAsync(lifetime.ApplicationStopping);
            var result = await probe.DetectAsync(current, lifetime.ApplicationStopping);
            Volatile.Write(ref _cached, result);
            logger.LogInformation(
                "Transcoding capabilities detected in {Duration:0.0}s: ffmpeg {Version}, usable {Usable}, recommended {Recommended}",
                result.Duration.TotalSeconds, result.Version ?? "missing", result.Usable, result.Recommended.ToApi());
            return result;
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "Transcoding capability detection failed");
            var failed = FfmpegCapabilities.Missing("ffmpeg", $"Capability detection failed: {e.Message}");
            Volatile.Write(ref _cached, failed);
            return failed;
        }
        finally
        {
            lock (_lock)
                _running = null;
        }
    }
}
