using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Viewers;

/// <summary>SQLite-backed viewer-module settings with an atomically published snapshot.</summary>
public sealed class ViewerSettingsService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    ISecretProtector protector,
    ILogger<ViewerSettingsService> logger)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly SemaphoreSlim _gate = new(1, 1);
    private Snapshot? _snapshot;

    public ViewerSettings Current => Volatile.Read(ref _snapshot)?.Settings ?? new ViewerSettings();

    public async Task<ViewerSettings> GetAsync(CancellationToken ct) => (await LoadAsync(ct)).Settings;

    public async Task<bool> HasSmtpPasswordAsync(CancellationToken ct) => (await LoadAsync(ct)).SmtpPassword.Length > 0;

    public async Task<string> GetSmtpPasswordAsync(CancellationToken ct) => (await LoadAsync(ct)).SmtpPassword;

    /// <summary>Persists new settings; a null <paramref name="smtpPassword"/> keeps the stored secret, empty clears it.</summary>
    public async Task<ViewerSettings> SaveAsync(ViewerSettings settings, string? smtpPassword, CancellationToken ct)
    {
        var errors = settings.Validate();
        if (errors.Count > 0)
            throw new ArgumentException(string.Join(" ", errors));

        await _gate.WaitAsync(ct);
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await db.ViewerConfig.SingleOrDefaultAsync(x => x.Id == 1, ct);
            if (entity is null)
            {
                entity = new ViewerConfigEntity { Id = 1 };
                db.ViewerConfig.Add(entity);
            }

            entity.SettingsJson = JsonSerializer.Serialize(settings, Json);
            if (smtpPassword is not null)
                entity.SmtpPasswordEncrypted = protector.Protect(smtpPassword);
            entity.UpdatedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync(ct);
            Volatile.Write(ref _snapshot, new Snapshot(settings, protector.Unprotect(entity.SmtpPasswordEncrypted)));
            return settings;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<Snapshot> LoadAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _snapshot) is { } loaded)
            return loaded;
        await _gate.WaitAsync(ct);
        try
        {
            if (_snapshot is { } raced)
                return raced;
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var entity = await db.ViewerConfig.AsNoTracking().SingleOrDefaultAsync(x => x.Id == 1, ct);
            var snapshot = entity is null
                ? new Snapshot(new ViewerSettings(), string.Empty)
                : new Snapshot(Deserialize(entity.SettingsJson), protector.Unprotect(entity.SmtpPasswordEncrypted));
            Volatile.Write(ref _snapshot, snapshot);
            return snapshot;
        }
        finally
        {
            _gate.Release();
        }
    }

    private ViewerSettings Deserialize(string json)
    {
        try
        {
            var settings = JsonSerializer.Deserialize<ViewerSettings>(json, Json) ?? new ViewerSettings();
            if (settings.Validate() is { Count: > 0 } errors)
            {
                logger.LogWarning("Stored viewer settings are invalid ({Errors}); the module stays disabled", string.Join(" ", errors));
                return new ViewerSettings();
            }
            return settings;
        }
        catch (JsonException e)
        {
            logger.LogWarning(e, "Stored viewer settings could not be read; the module stays disabled");
            return new ViewerSettings();
        }
    }

    private sealed record Snapshot(ViewerSettings Settings, string SmtpPassword);
}
