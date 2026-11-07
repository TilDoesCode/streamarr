using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Tests.Persistence;

/// <summary>Upgrading download records from before the idempotency key (V2-03): distinct tuples stay distinct, true duplicates dedupe.</summary>
public sealed class ViewerDownloadsLifecycleMigrationTests
{
    [Fact]
    public async Task DistinctTuples_KeepTheirOwnKeys_AndTrueDuplicates_LeaveItToTheOldest()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).Options);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261106194206_ViewerDownloads");
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt, MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, FailedLoginCount, CreatedAt, UpdatedAt) " +
            "VALUES ('v1', 'legacy', 'LEGACY', 'Legacy', 'h', 's', 0, 0, 0, 1, 0, 0, 0)");
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO ViewerDownloads (Id, ViewerId, SessionId, DeviceId, ClientRef, WorkId, RequestedReleaseId, State, RequestJson, BytesServed, CreatedAt, UpdatedAt)
            VALUES ('pipe-one', 'v1', 'session-1', 'alpha|beta', 'gamma', 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 4, 4),
                   ('pipe-two', 'v1', 'session-2', 'alpha', 'beta|gamma', 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 5, 5),
                   ('dup-new', 'v1', 'session-3', 'phone', 'ref', 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 30, 30),
                   ('dup-old', 'v1', 'session-3', 'Phone', 'ref', 'tmdb-movie-1', 'release', 'ready', '{{}}', 0, 10, 10),
                   ('dup-mid', 'v1', 'session-4', 'PHONE', 'ref', 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 20, 20),
                   ('by-session', 'v1', 'session-5', NULL, 'ref', 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 6, 6),
                   ('no-ref', 'v1', 'session-6', 'phone', NULL, 'tmdb-movie-1', 'release', 'failed', '{{}}', 0, 7, 7)
            """);

        await migrator.MigrateAsync();

        var keys = await db.ViewerDownloads.AsNoTracking().ToDictionaryAsync(d => d.Id, d => d.DeviceKey);
        Assert.Equal(7, keys.Count);
        Assert.Equal("d:alpha|beta", keys["pipe-one"]);
        Assert.Equal("d:alpha", keys["pipe-two"]);
        Assert.Equal("d:phone", keys["dup-old"]);
        Assert.Null(keys["dup-mid"]);
        Assert.Null(keys["dup-new"]);
        Assert.Equal("s:session-5", keys["by-session"]);
        Assert.Null(keys["no-ref"]);
        // The runtime computes the same key, so a retry after the upgrade finds the oldest record.
        Assert.Equal(keys["dup-old"], ViewerDownloadService.DeviceKey("PhOnE", "any-session"));
        Assert.Equal(keys["by-session"], ViewerDownloadService.DeviceKey(null, "session-5"));
    }

    [Fact]
    public async Task TheKey_IsUniquePerViewerDeviceAndClientReference()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).Options);
        await db.Database.MigrateAsync();
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt, MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, FailedLoginCount, CreatedAt, UpdatedAt) " +
            "VALUES ('v1', 'unique', 'UNIQUE', 'Unique', 'h', 's', 0, 0, 0, 1, 0, 0, 0)");
        const string insert = "INSERT INTO ViewerDownloads (Id, ViewerId, SessionId, DeviceKey, ClientRef, WorkId, RequestedReleaseId, State, RequestJson, BytesServed, CreatedAt, UpdatedAt, SecurityGeneration, Revision) " +
                              "VALUES ({0}, 'v1', 's', {1}, {2}, 'tmdb-movie-1', 'r', 'queued', '{{}}', 0, 0, 0, 0, 0)";

        await db.Database.ExecuteSqlRawAsync(insert, "a", "d:alpha|beta", "gamma");
        await db.Database.ExecuteSqlRawAsync(insert, "b", "d:alpha", "beta|gamma");
        await db.Database.ExecuteSqlRawAsync(insert, "c", null!, "gamma");
        await db.Database.ExecuteSqlRawAsync(insert, "d", null!, "gamma");

        await Assert.ThrowsAsync<SqliteException>(() => db.Database.ExecuteSqlRawAsync(insert, "e", "d:alpha", "beta|gamma"));
    }

    [Fact]
    public async Task StoredDeviceIds_TakeTheFormEveryComparisonUses()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).Options);
        var migrator = db.GetService<IMigrator>();
        await migrator.MigrateAsync("20261106231635_ViewerDownloadsLifecycle");
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt, MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, FailedLoginCount, CreatedAt, UpdatedAt) " +
            "VALUES ('v1', 'devices', 'DEVICES', 'Devices', 'h', 's', 0, 0, 0, 1, 0, 0, 0)");
        await db.Database.ExecuteSqlRawAsync("""
            INSERT INTO ViewerDownloads (Id, ViewerId, SessionId, DeviceId, WorkId, RequestedReleaseId, State, RequestJson, BytesServed, CreatedAt, UpdatedAt, SecurityGeneration, Revision)
            VALUES ('ascii', 'v1', 's', 'My-Phone', 'tmdb-movie-1', 'r', 'ready', '{{}}', 0, 0, 0, 0, 0),
                   ('umlaut', 'v1', 's', 'ÄPFEL', 'tmdb-movie-1', 'r', 'ready', '{{}}', 0, 0, 0, 0, 0),
                   ('none', 'v1', 's', NULL, 'tmdb-movie-1', 'r', 'ready', '{{}}', 0, 0, 0, 0, 0)
            """);

        await migrator.MigrateAsync();

        var ids = await db.ViewerDownloads.AsNoTracking().ToDictionaryAsync(d => d.Id, d => d.DeviceId);
        Assert.Equal("my-phone", ids["ascii"]);
        Assert.Equal("Äpfel", ids["umlaut"]);
        Assert.Null(ids["none"]);
        Assert.Equal(ids["ascii"], ViewerDownloadService.DeviceIdOf(" MY-PHONE "));
        Assert.Equal(ids["umlaut"], ViewerDownloadService.DeviceIdOf("ÄPFEL"));
    }
}
