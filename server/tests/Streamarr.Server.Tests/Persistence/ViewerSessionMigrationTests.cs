using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Tests.Persistence;

public sealed class ViewerSessionMigrationTests
{
    [Fact]
    public async Task DeviceNameMigrations_ClearTheStoredEnglishFallback_AndKeepRealNames()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).Options);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261001144522_AddViewerAvatarKey");

        await db.Database.ExecuteSqlRawAsync("PRAGMA foreign_keys = OFF;");
        foreach (var (id, device) in new[] { ("s1", "Unknown device"), ("s2", "iPad (iOS)") })
        {
            await db.Database.ExecuteSqlRawAsync(
                "INSERT INTO ViewerSessions (Id, ViewerId, AccessTokenHash, AccessExpiresAt, RefreshTokenHash, RefreshExpiresAt, DeviceName, ClientName, AuthMethod, CookieMode, CreatedAt, LastSeenAt) " +
                "VALUES ({0}, 'v', {0}, 0, {0}, 0, {1}, 'Streamarr', 'password', 0, 0, 0)", id, device);
        }

        await migrator.MigrateAsync();

        var names = await db.ViewerSessions.AsNoTracking().OrderBy(s => s.Id).Select(s => s.DeviceName).ToListAsync();
        Assert.Equal([null, "iPad (iOS)"], names);
    }
}
