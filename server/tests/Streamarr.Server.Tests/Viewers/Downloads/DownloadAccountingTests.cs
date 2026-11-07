using System.Data.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Background byte accounting (V3-02): an orderly stop writes every queued byte exactly once.</summary>
public sealed class DownloadAccountingTests : IAsyncLifetime
{
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-accounting-").FullName;
    private DbContextOptions<StreamarrDbContext> _options = null!;

    public async Task InitializeAsync()
    {
        _options = new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={Path.Combine(_dir, "accounting.db")}").Options;
        await using var db = new StreamarrDbContext(_options);
        await db.Database.MigrateAsync();
        await db.Database.ExecuteSqlRawAsync(
            "INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt, MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, FailedLoginCount, CreatedAt, UpdatedAt) " +
            "VALUES ('v1', 'bytes', 'BYTES', 'Bytes', 'h', 's', 0, 0, 0, 1, 0, 0, 0)");
        foreach (var id in new[] { "first", "second" })
        {
            await db.Database.ExecuteSqlRawAsync(
                "INSERT INTO ViewerDownloads (Id, ViewerId, SessionId, WorkId, RequestedReleaseId, State, RequestJson, BytesServed, CreatedAt, UpdatedAt, SecurityGeneration, Revision) " +
                "VALUES ({0}, 'v1', 's', 'tmdb-movie-1', 'r', 'ready', '{{}}', 0, 0, 0, 0, 0)", id);
        }
    }

    public Task DisposeAsync()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(_dir, recursive: true);
        return Task.CompletedTask;
    }

    /// <summary>Holds the <see cref="HoldNumber"/>-th byte write until its token is cancelled (while <see cref="Hold"/>), or fails the first one.</summary>
    private sealed class Writes : DbCommandInterceptor
    {
        private int _seen;

        public TaskCompletionSource Held { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public int HoldNumber { get; init; }
        public bool Hold { get; set; } = true;
        public bool FailFirst { get; init; }

        public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<int> result, CancellationToken cancellationToken = default)
        {
            if (!command.CommandText.StartsWith("UPDATE \"ViewerDownloads\" SET \"BytesServed\"", StringComparison.Ordinal))
                return result;
            var number = Interlocked.Increment(ref _seen);
            if (FailFirst && number == 1)
                throw new InvalidOperationException("the database refused the write");
            if (Hold && number == HoldNumber)
            {
                Held.TrySetResult();
                await Task.Delay(Timeout.Infinite, cancellationToken);
            }
            return result;
        }
    }

    private sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);

        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
    }

    private DownloadAccounting Accounting(Writes writes)
        => new(new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(_options).AddInterceptors(writes).Options), TimeProvider.System,
            NullLogger<DownloadAccounting>.Instance);

    private async Task<long[]> SavedAsync()
    {
        await using var db = new StreamarrDbContext(_options);
        return await db.ViewerDownloads.Where(d => d.Id == "first" || d.Id == "second").OrderBy(d => d.Id).Select(d => d.BytesServed).ToArrayAsync();
    }

    [Fact]
    public async Task AStopWhileTheFirstWriteIsHeld_StillWritesEveryQueuedByte()
    {
        var writes = new Writes { HoldNumber = 1 };
        var accounting = Accounting(writes);
        accounting.Add("first", 111);
        accounting.Add("second", 222);
        await accounting.StartAsync(CancellationToken.None);
        accounting.Wake();
        await writes.Held.Task.WaitAsync(TimeSpan.FromSeconds(10));
        writes.Hold = false;

        await accounting.StopAsync(CancellationToken.None);

        var saved = await SavedAsync();
        Assert.Equal(new long[] { 111, 222 }, saved);
    }

    [Fact]
    public async Task AStopAfterOneWriteCommitted_NeverWritesItAgain()
    {
        var writes = new Writes { HoldNumber = 2 };
        var accounting = Accounting(writes);
        accounting.Add("first", 111);
        accounting.Add("second", 222);
        await accounting.StartAsync(CancellationToken.None);
        accounting.Wake();
        await writes.Held.Task.WaitAsync(TimeSpan.FromSeconds(10));
        writes.Hold = false;

        await accounting.StopAsync(CancellationToken.None);

        var saved = await SavedAsync();
        Assert.Equal(new long[] { 111, 222 }, saved);
    }

    [Fact]
    public async Task AFailedWrite_KeepsItsBytesForTheNextRound()
    {
        var accounting = Accounting(new Writes { FailFirst = true, Hold = false });
        accounting.Add("first", 111);

        await accounting.FlushAsync(CancellationToken.None);
        var failed = await SavedAsync();
        await accounting.FlushAsync(CancellationToken.None);

        var saved = await SavedAsync();
        Assert.Equal(new long[] { 0, 0 }, failed);
        Assert.Equal(new long[] { 111, 0 }, saved);
    }
}
