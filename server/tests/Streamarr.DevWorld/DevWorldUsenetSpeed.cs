using Streamarr.Server.Config;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld;

/// <summary>
/// Stages the server ↔ Usenet speed test: a test article the mock provider lists in its groups, a simulated line speed
/// (shared by all connections) and a failing primary with a backup provider that takes over.
/// <c>POST /devworld/usenet-speed { mbps, primaryFails, backupMbps }</c>, <c>DELETE</c> resets, <c>GET</c> shows the state.
/// </summary>
public sealed class DevWorldUsenetSpeed(MockNntpServer primary, PublicationStore store) : IAsyncDisposable
{
    public const string ArticleId = "devworld-speedtest@streamarr.invalid";
    public const string BackupName = "devworld-nntp-backup";
    private readonly SemaphoreSlim _gate = new(1, 1);
    private MockNntpServer? _backup;

    public double? Mbps { get; private set; }
    public double? BackupMbps { get; private set; }
    public bool PrimaryFails { get; private set; }

    /// <summary>A ~768 KiB binary article in the groups the speed test searches.</summary>
    public static void AddArticle(MockNntpServer nntp)
        => nntp.Articles[ArticleId] = YencTestEncoder.Encode(YencTestEncoder.LcgBytes(4242, 768 * 1024), "speedtest.bin");

    public async Task ApplyAsync(IServiceProvider services, double? mbps, bool primaryFails, double? backupMbps, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            Mbps = mbps;
            BackupMbps = backupMbps;
            PrimaryFails = primaryFails;
            Rate(primary, mbps);
            primary.HideGroups = primaryFails;
            if (primaryFails)
                primary.BodyScripts[ArticleId] = _ => MockBodyBehavior.Missing;
            else
                primary.BodyScripts.TryRemove(ArticleId, out _);

            var providers = services.GetRequiredService<ProviderConfigService>();
            var existing = (await providers.ListAsync(ct)).FirstOrDefault(p => p.Name == BackupName);
            if (primaryFails)
            {
                if (_backup is null)
                {
                    _backup = new MockNntpServer { RequireAuth = true, ArticleSource = store };
                    AddArticle(_backup);
                }
                Rate(_backup, backupMbps);
                if (existing is null)
                {
                    await providers.CreateAsync(new ProviderWrite
                    {
                        Name = BackupName, Host = _backup.Host, Port = _backup.Port, UseSsl = false,
                        Username = _backup.Username, Password = _backup.Password, MaxConnections = 8, Priority = 1,
                        IsBackupOnly = true,
                    }, ct);
                }
            }
            else if (existing is not null)
            {
                await providers.DeleteAsync(existing.Id, ct);
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private static void Rate(MockNntpServer server, double? mbps)
    {
        if (mbps is > 0 and var value)
            server.SharedBodyRates[ArticleId] = new SharedBodyRate((long)(value * 1_000_000 / 8));
        else
            server.SharedBodyRates.TryRemove(ArticleId, out _);
    }

    public async ValueTask DisposeAsync()
    {
        if (_backup is not null)
            await _backup.DisposeAsync();
        _gate.Dispose();
    }
}

public sealed record UsenetSpeedStage(double? Mbps, bool PrimaryFails, double? BackupMbps);

public static class DevWorldUsenetSpeedEndpoints
{
    public static void MapDevWorldUsenetSpeed(this WebApplication app, DevWorldUsenetSpeed speed)
    {
        app.MapGet("/devworld/usenet-speed", () => Results.Ok(new UsenetSpeedStage(speed.Mbps, speed.PrimaryFails, speed.BackupMbps)));
        app.MapPost("/devworld/usenet-speed", async (UsenetSpeedStage stage, HttpContext http) =>
        {
            await speed.ApplyAsync(http.RequestServices, stage.Mbps, stage.PrimaryFails, stage.BackupMbps, http.RequestAborted);
            return Results.Ok(stage);
        });
        app.MapDelete("/devworld/usenet-speed", async (HttpContext http) =>
        {
            await speed.ApplyAsync(http.RequestServices, null, false, null, http.RequestAborted);
            return Results.NoContent();
        });
    }
}
