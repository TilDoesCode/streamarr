using System.Collections.Concurrent;
using System.Data.Common;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Streamarr.Server.Persistence;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Captures log lines (level, rendered text) for assertions.</summary>
public sealed class CapturedLogger<T> : ILogger<T>
{
    public ConcurrentQueue<(LogLevel Level, string Text)> Lines { get; } = new();

    public bool IsEnabled(LogLevel level) => true;

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> format)
        => Lines.Enqueue((level, format(state, exception)));

    public int Count(LogLevel level, string fragment) => Lines.Count(l => l.Level == level && l.Text.Contains(fragment, StringComparison.Ordinal));
}

/// <summary>Fix round 6 (V4c-01): a run of maintenance failures escalates to one warning at the 3rd, recovers with one information line, and shows in the admin activity.</summary>
public sealed class DownloadMaintenanceTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>
{
    private static readonly DateTimeOffset Start = new(2026, 11, 7, 1, 0, 0, TimeSpan.Zero);

    private static (DownloadMaintenanceTracker Tracker, CapturedLogger<DownloadMaintenanceTests> Log, ManualClock Clock) Tracker()
    {
        var log = new CapturedLogger<DownloadMaintenanceTests>();
        var clock = new ManualClock(Start);
        return (new DownloadMaintenanceTracker("sweep", "open transfer check", log, clock), log, clock);
    }

    [Fact]
    public void EightFailures_WarnOnceAtTheThird_AndTheRecoveryLogsOnce_AndResetsTheCounter()
    {
        var (tracker, log, clock) = Tracker();
        var capability = new string('c', 64);

        for (var n = 1; n <= 8; n++)
        {
            clock.Advance(TimeSpan.FromSeconds(1));
            tracker.Failure(new InvalidOperationException($"database is locked at /api/v1/offline/{capability} ({n})"));
            Assert.Equal(n >= 3 ? 1 : 0, log.Count(LogLevel.Warning, "open transfer check"));
        }

        var degraded = tracker.Snapshot();
        Assert.Equal(8, degraded.ConsecutiveFailures);
        Assert.True(degraded.Degraded);
        Assert.Equal(Start.AddSeconds(1), degraded.FailingSince);
        Assert.Equal(Start.AddSeconds(8), degraded.LastFailureAt);
        Assert.Null(degraded.LastSuccessAt);
        Assert.StartsWith("InvalidOperationException: database is locked", degraded.LastError);
        Assert.DoesNotContain(capability, degraded.LastError, StringComparison.Ordinal);
        var warning = Assert.Single(log.Lines, l => l.Level == LogLevel.Warning).Text;
        Assert.Contains("3 consecutive failures", warning, StringComparison.Ordinal);
        Assert.DoesNotContain(capability, warning, StringComparison.Ordinal);

        clock.Advance(TimeSpan.FromSeconds(1));
        tracker.Success();

        Assert.Equal(1, log.Count(LogLevel.Information, "recovered after 8 consecutive failures"));
        var healthy = tracker.Snapshot();
        Assert.Equal(0, healthy.ConsecutiveFailures);
        Assert.False(healthy.Degraded);
        Assert.Null(healthy.FailingSince);
        Assert.Equal(Start.AddSeconds(9), healthy.LastSuccessAt);
        Assert.Equal(Start.AddSeconds(8), healthy.LastFailureAt);

        // A new run starts from zero: two failures stay quiet, the third warns again.
        tracker.Failure(new InvalidOperationException("again"));
        tracker.Failure(new InvalidOperationException("again"));
        Assert.Single(log.Lines, l => l.Level == LogLevel.Warning);
        tracker.Failure(new InvalidOperationException("again"));
        Assert.Equal(2, log.Count(LogLevel.Warning, "open transfer check"));
    }

    [Fact]
    public void AComponentThatKeepsFailing_WarnsAtMostOnceEveryFiveMinutes()
    {
        var (tracker, log, clock) = Tracker();
        for (var n = 0; n < 3; n++)
            tracker.Failure(new TimeoutException("slow"));
        Assert.Equal(1, log.Count(LogLevel.Warning, "open transfer check"));

        for (var minute = 1; minute < 5; minute++)
        {
            clock.Advance(TimeSpan.FromMinutes(1));
            tracker.Failure(new TimeoutException("slow"));
        }
        Assert.Equal(1, log.Count(LogLevel.Warning, "open transfer check"));

        clock.Advance(TimeSpan.FromMinutes(1));
        tracker.Failure(new TimeoutException("slow"));
        Assert.Equal(2, log.Count(LogLevel.Warning, "open transfer check"));
        Assert.Contains(log.Lines, l => l.Level == LogLevel.Warning && l.Text.Contains("8 consecutive failures", StringComparison.Ordinal));
    }

    [Fact]
    public void FewerThanThreeFailures_NeverWarn_AndRecoverWithoutAnInformationLine()
    {
        var (tracker, log, _) = Tracker();
        tracker.Failure(new InvalidOperationException("one"));
        tracker.Failure(new InvalidOperationException("two"));

        Assert.False(tracker.Snapshot().Degraded);
        tracker.Success();

        Assert.DoesNotContain(log.Lines, l => l.Level >= LogLevel.Information);
        Assert.Equal(0, tracker.Snapshot().ConsecutiveFailures);
    }

    /// <summary>Fails every read of the download table while <see cref="Failing"/> is above zero (counting down).</summary>
    private sealed class FailingReads : DbCommandInterceptor
    {
        private int _failing;

        public int Failing
        {
            get => Volatile.Read(ref _failing);
            set => Volatile.Write(ref _failing, value);
        }

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("\"ViewerDownloads\"", StringComparison.Ordinal) && Interlocked.Decrement(ref _failing) >= 0)
                throw new InvalidOperationException("known maintenance failure");
            return ValueTask.FromResult(result);
        }
    }

    private sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);

        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
    }

    private static async Task UntilAsync(Func<bool> condition, string what)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, $"timed out waiting for {what}");
            await Task.Delay(20);
        }
    }

    [Fact]
    public async Task EightFailingSweeps_GiveOneWarning_AndTheRecoveryEndsTheOrphanedRequest_AndLogsOnce()
    {
        string connection;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            connection = db.Database.GetConnectionString()!;
        var reads = new FailingReads();
        var dbFactory = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite(connection).AddInterceptors(reads).Options);
        var governor = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new FakeLiveSignal());
        var log = new CapturedLogger<ViewerDownloadService>();
        var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, dbFactory, governor, (ILogger<ViewerDownloadService>)log);
        await service.StartAsync(CancellationToken.None);
        try
        {
            // The sweep only reads with a request open: once the startup resume worked, the next eight reads are the sweep's.
            await UntilAsync(() => Snapshot(service, "resume").LastSuccessAt is not null, "the resume");
            reads.Failing = 8;
            using var orphan = governor.TryAdmit("no-such-download", "viewer", "tmdb-movie-1", null, governor.Stamp("no-such-download", "viewer", "h"),
                DateTimeOffset.MaxValue, default, out _, "h", 1)!;
            DownloadMaintenanceDto? degraded = null;
            await UntilAsync(() => (degraded = Snapshot(service, "sweep")).ConsecutiveFailures == 8, "eight failing sweeps");
            Assert.True(degraded!.Degraded);
            Assert.Equal("InvalidOperationException: known maintenance failure", degraded.LastError);

            await UntilAsync(() => orphan.Token.IsCancellationRequested, "the recovered sweep");
            await UntilAsync(() => log.Count(LogLevel.Information, "recovered after") > 0, "the recovery line");

            Assert.Equal(1, log.Count(LogLevel.Warning, "open transfer check"));
            Assert.Equal(1, log.Count(LogLevel.Information, "open transfer check) recovered after 8 consecutive failures"));
            Assert.Equal(8, log.Count(LogLevel.Debug, "Checking the open download transfers failed"));
            Assert.False(Snapshot(service, "sweep").Degraded);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    private static DownloadMaintenanceDto Snapshot(ViewerDownloadService service, string component)
        => service.Maintenance().Single(m => m.Component == component);

    [Fact]
    public async Task TheAdminActivity_ListsEveryMaintenanceComponent_AndADegradedOne()
    {
        using var admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(admin, new { enabled = true });
        var accounting = factory.Services.GetRequiredService<DownloadAccounting>();

        var healthy = await Dl.GetAsync(admin, "/api/v1/config/viewers/downloads");
        var components = healthy.GetProperty("maintenance").EnumerateArray().ToDictionary(m => m.GetProperty("component").GetString()!);
        Assert.Equal(["accounting", "failureRecord", "resume", "sweep"], components.Keys.Order(StringComparer.Ordinal).ToArray());
        Assert.All(components.Values, m => Assert.False(m.GetProperty("degraded").GetBoolean()));

        for (var n = 0; n < 3; n++)
            accounting.Maintenance.Failure(new InvalidOperationException("disk full"));
        try
        {
            var failing = (await Dl.GetAsync(admin, "/api/v1/config/viewers/downloads")).GetProperty("maintenance").EnumerateArray()
                .Single(m => m.GetProperty("component").GetString() == "accounting");
            Assert.True(failing.GetProperty("degraded").GetBoolean());
            Assert.Equal(3, failing.GetProperty("consecutiveFailures").GetInt32());
            Assert.Equal(JsonValueKind.String, failing.GetProperty("failingSince").ValueKind);
            Assert.Equal(JsonValueKind.String, failing.GetProperty("lastFailureAt").ValueKind);
            Assert.Equal("InvalidOperationException: disk full", failing.GetProperty("lastError").GetString());
        }
        finally
        {
            accounting.Maintenance.Success();
        }
        var recovered = (await Dl.GetAsync(admin, "/api/v1/config/viewers/downloads")).GetProperty("maintenance").EnumerateArray()
            .Single(m => m.GetProperty("component").GetString() == "accounting");
        Assert.False(recovered.GetProperty("degraded").GetBoolean());
        Assert.Equal(JsonValueKind.Null, recovered.GetProperty("failingSince").ValueKind);
    }

    /// <summary>Fails the startup resume's read of the queued preparations while <see cref="Failing"/>, and counts it.</summary>
    private sealed class FailingResume : DbCommandInterceptor
    {
        private volatile bool _failing = true;
        private int _reads;

        public bool Failing { set => _failing = value; }

        public int Reads => Volatile.Read(ref _reads);

        public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
            DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.StartsWith("SELECT \"v\".\"Id\", \"v\".\"ViewerId\", \"v\".\"WorkId\"\nFROM \"ViewerDownloads\"", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref _reads);
                if (_failing)
                    throw new InvalidOperationException("the database is not available yet");
            }
            return ValueTask.FromResult(result);
        }
    }

    private const string Base = "/api/v1/viewer/downloads";
    private const string Movie = "tmdb-movie-501";

    private static async Task<string> PrepareAsync(HttpClient viewer)
    {
        var releaseId = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
        return (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
    }

    [Fact]
    public async Task AResumeFailingAtStart_WarnsOnceAtTheThird_LeavesTheSweepRunning_ThenStartsEachQueuedPreparationOnce_AndNeverRunsAgain()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-downloads-resume-").FullName;
        try
        {
            var interrupted = new List<string>();
            using (var before = new ViewerDownloadFactory(directory, ownsDirectory: false))
            {
                before.Resolver.Script = async (_, _, ct) =>
                {
                    await Task.Delay(Timeout.Infinite, ct);
                    throw new InvalidOperationException("unreachable");
                };
                using var admin = await before.AdminAsync();
                await ViewerApi.ConfigureAsync(admin, new { enabled = true });
                foreach (var name in new[] { "resume-a", "resume-b" })
                {
                    var (viewer, _, viewerId) = await Dl.ViewerAsync(before, admin, name);
                    using (viewer)
                        await PrepareAsync(viewer);
                    interrupted.Add(viewerId);
                }
                // One resolves (held), the other waits for a preparation slot: both stay queued in the database.
                await UntilAsync(() => !before.Resolver.Calls.IsEmpty, "a preparation resolving");
            }

            // The restart: the queued preparations' read fails until the test lets it through.
            var resume = new FailingResume();
            var log = new CapturedLogger<ViewerDownloadService>();
            using var after = new ViewerDownloadFactory(directory, ownsDirectory: false, services =>
            {
                services.RemoveAll<IDbContextFactory<StreamarrDbContext>>();
                services.AddSingleton<IDbContextFactory<StreamarrDbContext>>(sp => new OptionsFactory(
                    new DbContextOptionsBuilder<StreamarrDbContext>(sp.GetRequiredService<DbContextOptions<StreamarrDbContext>>()).AddInterceptors(resume).Options));
                services.AddSingleton<ILogger<ViewerDownloadService>>(log);
            });
            var held = new ConcurrentDictionary<string, bool>(StringComparer.Ordinal);
            var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            after.Resolver.Script = async (call, observer, ct) =>
            {
                if (held.ContainsKey(call.ViewerId))
                    await gate.Task.WaitAsync(ct);
                observer.HopStarted(call.ReleaseId, 0);
                observer.HopFinished(call.ReleaseId, "ready");
                return FakePlaybackResolver.Ready(call.ReleaseId);
            };
            using var admin2 = await after.AdminAsync();
            var service = after.Services.GetRequiredService<ViewerDownloadService>();
            DownloadMaintenanceDto Resume() => Snapshot(service, "resume");

            await UntilAsync(() => Resume().ConsecutiveFailures >= 3, "three failed resumes");
            Assert.True(Resume().Degraded);
            Assert.Equal(1, log.Count(LogLevel.Warning, "(preparation resume) is failing: 3 consecutive failures"));

            // The sweep keeps working while the resume fails.
            var governor = after.Services.GetRequiredService<DownloadTransferGovernor>();
            using var orphan = governor.TryAdmit("no-such-download", "viewer", Movie, null, governor.Stamp("no-such-download", "viewer", "h"),
                DateTimeOffset.MaxValue, default, out _, "h", 1)!;
            await UntilAsync(() => orphan.Token.IsCancellationRequested, "a sweep while the resume fails");

            // A request starts a preparation meanwhile; it is still running when the resume reads it as queued.
            var (viewer3, _, requested) = await Dl.ViewerAsync(after, admin2, "resume-c");
            held[requested] = true;
            using (viewer3)
                await PrepareAsync(viewer3);
            await UntilAsync(() => after.Resolver.Calls.Any(c => c.ViewerId == requested), "the request's preparation");
            Assert.Null(Resume().LastSuccessAt);

            resume.Failing = false;
            await UntilAsync(() => Resume().LastSuccessAt is not null, "the resume");
            var readsAtSuccess = resume.Reads;
            var failures = Assert.Single(log.Lines, l => l.Level == LogLevel.Information && l.Text.Contains("(preparation resume) recovered after", StringComparison.Ordinal)).Text;
            gate.SetResult();

            var viewers = interrupted.Append(requested).ToHashSet(StringComparer.Ordinal);
            var deadline = DateTime.UtcNow.AddSeconds(20);
            while (true)
            {
                var items = (await Dl.GetAsync(admin2, "/api/v1/config/viewers/downloads")).GetProperty("items").EnumerateArray()
                    .Where(i => viewers.Contains(i.GetProperty("viewerId").GetString()!)).ToList();
                if (items.Count == 3 && items.All(i => i.GetProperty("state").GetString() == "ready"))
                    break;
                Assert.True(DateTime.UtcNow < deadline, "the preparations never became ready");
                await Task.Delay(50);
            }
            await Task.Delay(ViewerDownloadService.ExpirySweep * 4);

            Assert.All(viewers, v => Assert.Single(after.Resolver.Calls, c => c.ViewerId == v));
            Assert.Equal(readsAtSuccess, resume.Reads);
            Assert.False(Resume().Degraded);
            Assert.Equal(1, log.Count(LogLevel.Warning, "(preparation resume)"));
            Assert.Equal(1, log.Count(LogLevel.Information, "Resumed 2 viewer download preparation(s) after a restart"));
            Assert.Contains($"recovered after {readsAtSuccess - 1} consecutive failures", failures, StringComparison.Ordinal);
        }
        finally
        {
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            Directory.Delete(directory, recursive: true);
        }
    }
}
