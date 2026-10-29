using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Streamarr.Server.Persistence;

namespace Streamarr.Server.Tests.Persistence;

public sealed class ViewerUsenetSpeedTestMigrationTests
{
    [Fact]
    public async Task ExistingViewers_MayStartTheUsenetSpeedTest_AfterTheMigration()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).Options);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261024103120_ProfileDefaults");
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt, MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, FailedLoginCount, CreatedAt, UpdatedAt) " +
            "VALUES ('v1', 'old', 'OLD', 'Old', 'h', 's', 0, 0, 0, 0, 0, 0, 0)");

        await migrator.MigrateAsync();

        var viewer = await db.Viewers.AsNoTracking().SingleAsync(v => v.Id == "v1");
        Assert.True(viewer.AllowUsenetSpeedTest);
        Assert.False(viewer.AllowTranscoding);
    }
}
