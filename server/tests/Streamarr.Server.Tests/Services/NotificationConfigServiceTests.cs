using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Security;

namespace Streamarr.Server.Tests.Services;

public sealed class NotificationConfigServiceTests
{
    [Fact]
    public async Task Update_EncryptsCredentialsAndKeepsOmittedSecrets()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-notifications-");
        var options = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(directory.FullName, "config.db")}")
            .Options;
        await using (var setup = new StreamarrDbContext(options))
            await setup.Database.EnsureCreatedAsync();
        var service = new NotificationConfigService(new Factory(options), new TestProtector());

        await service.UpdateAsync(Write() with
        {
            AppToken = "app-secret",
            UserKey = "user-secret",
        }, default);
        await service.UpdateAsync(Write() with { NotifyPlaybackProgress = true }, default);

        await using var db = new StreamarrDbContext(options);
        var stored = await db.NotificationConfig.AsNoTracking().SingleAsync();
        Assert.Equal("protected:app-secret", stored.AppTokenEncrypted);
        Assert.Equal("protected:user-secret", stored.UserKeyEncrypted);
        Assert.True(stored.NotifyPlaybackProgress);
        directory.Delete(recursive: true);
    }

    [Fact]
    public async Task Update_RequiresCredentialsBeforeEnabling()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-notifications-");
        var options = new DbContextOptionsBuilder<StreamarrDbContext>()
            .UseSqlite($"Data Source={Path.Combine(directory.FullName, "config.db")}")
            .Options;
        await using (var setup = new StreamarrDbContext(options))
            await setup.Database.EnsureCreatedAsync();
        var service = new NotificationConfigService(new Factory(options), new TestProtector());

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            service.UpdateAsync(Write() with { Enabled = true }, default));

        Assert.Contains("application token", exception.Message);
        directory.Delete(recursive: true);
    }

    private static NotificationConfigWrite Write() => new()
    {
        NotifyPlaybackStarted = true,
        NotifyPlaybackStopped = true,
        NotifyResolveFailed = true,
        NotifyErrors = true,
        NotifyOutages = true,
        NotifyRecoveries = true,
        IncludeUserName = true,
        IncludeDeviceName = true,
        UsagePriority = 0,
        ErrorPriority = 1,
        OutagePriority = 1,
        RecoveryPriority = 0,
        ProgressIntervalMinutes = 30,
        ErrorCooldownSeconds = 300,
        MonitorIntervalSeconds = 60,
        OutageFailureThreshold = 3,
        EmergencyRetrySeconds = 60,
        EmergencyExpireSeconds = 3600,
    };

    private sealed class Factory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(CreateDbContext());
    }

    private sealed class TestProtector : ISecretProtector
    {
        public string? Protect(string? plaintext)
            => string.IsNullOrEmpty(plaintext) ? null : $"protected:{plaintext}";

        public string Unprotect(string? ciphertext)
            => ciphertext?.StartsWith("protected:", StringComparison.Ordinal) == true
                ? ciphertext["protected:".Length..]
                : string.Empty;
    }
}
