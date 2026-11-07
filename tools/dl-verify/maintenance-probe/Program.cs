using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Streamarr.Server.Persistence;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var original = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
static void Evidence(string name, object value) => Console.WriteLine("MAINTENANCE " + JsonSerializer.Serialize(new { name, value }));
static async Task Until(Func<bool> check)
{
    var timer = Stopwatch.StartNew();
    while (!check()) { if (timer.Elapsed > TimeSpan.FromSeconds(12)) throw new TimeoutException(); await Task.Delay(10); }
}

foreach (var kind in new[] { "unexpected", "known" })
{
    var breaks = new FailingCommands { Kind = kind };
    var clock = new ManualClock(DateTimeOffset.UtcNow);
    var logger = new Captured<ViewerDownloadService>();
    var wrapped = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(breaks).Options);
    var governor = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    using var orphan = governor.TryAdmit("orphan", "viewer", "work", null, governor.Stamp("orphan", "viewer", "h"), DateTimeOffset.MaxValue, default, out _, "h", 1)!;
    using var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, wrapped, governor, (TimeProvider)clock, (ILogger<ViewerDownloadService>)logger);
    await service.StartAsync(default);
    await Until(() => breaks.Reads >= 9);
    using var health = await admin.GetAsync("/api/v1/health");
    Evidence(kind + " persistent sweep failures", new { breaks.Reads, warnings = logger.Lines.Count(x => x.Level == LogLevel.Warning), sweepWarnings = logger.Lines.Count(x => x.Level == LogLevel.Warning && x.Text.Contains("(open transfer check)")), debug = logger.Lines.Count(x => x.Level == LogLevel.Debug), orphanCancelled = orphan.Token.IsCancellationRequested, running = !service.ExecuteTask!.IsCompleted, health = (int)health.StatusCode });
    clock.Advance(TimeSpan.FromMinutes(5.1));
    var previous = breaks.Reads;
    await Until(() => breaks.Reads >= previous + 2);
    Evidence(kind + " next log window", logger.Lines.Where(x => x.Level == LogLevel.Warning).Select(x => x.Text).ToArray());
    breaks.Enabled = false;
    await Until(() => orphan.Token.IsCancellationRequested);
    var stop = Stopwatch.StartNew();
    await service.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(2));
    Evidence(kind + " recovery and shutdown", new { orphanCancelled = orphan.Token.IsCancellationRequested, stopMs = stop.Elapsed.TotalMilliseconds, task = service.ExecuteTask!.Status.ToString(), recoveries = logger.Lines.Where(x => x.Level == LogLevel.Information && x.Text.Contains("recovered after")).Select(x => x.Text).ToArray() });
}

// Stop during a failing iteration and during an awaited, cancellable startup read.
foreach (var hold in new[] { false, true })
{
    var breaks = new FailingCommands { HoldReader = hold };
    var wrapped = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(breaks).Options);
    var governor = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    using var orphan = governor.TryAdmit("stop-orphan", "v", "w", null, governor.Stamp("stop-orphan", "v", "h"), DateTimeOffset.MaxValue, default, out _, "h", 1)!;
    using var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, wrapped, governor);
    await service.StartAsync(default);
    await Until(() => breaks.Reads >= (hold ? 1 : 2));
    var timer = Stopwatch.StartNew();
    await service.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(2));
    Evidence(hold ? "shutdown during blocked startup read" : "shutdown during persistent sweep failures", new { stopMs = timer.Elapsed.TotalMilliseconds, task = service.ExecuteTask!.Status.ToString() });
}

// Use an actual ready record so that recovery can verify queued bytes exactly.
var (viewer, _, _) = await Dl.ViewerAsync(factory, admin, "maintenance-accounting");
using (viewer)
{
    var candidates = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var rid = candidates.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var prepared = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = rid, device = Dl.AndroidTv }, 202);
    var id = prepared.GetProperty("downloadId").GetString()!;
    await Dl.WaitAsync(viewer, id);
    var breaks = new FailingCommands { WritesOnly = true };
    var wrapped = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(breaks).Options);
    var logger = new Captured<DownloadAccounting>();
    using var accounting = new DownloadAccounting(wrapped, TimeProvider.System, logger);
    accounting.Add(id, 123);
    await accounting.StartAsync(default);
    for (var i = 1; i <= 8; i++) { accounting.Wake(); await Until(() => breaks.Writes >= i); }
    await Task.Delay(20);
    Evidence("persistent accounting write failures", new { breaks.Writes, warnings = logger.Lines.Count(x => x.Level == LogLevel.Warning), debug = logger.Lines.Count(x => x.Level == LogLevel.Debug), running = !accounting.ExecuteTask!.IsCompleted });
    breaks.Enabled = false;
    var timer = Stopwatch.StartNew();
    await accounting.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(2));
    await using var db = new StreamarrDbContext(original);
    Evidence("accounting recovery at shutdown", new { saved = await db.ViewerDownloads.Where(x => x.Id == id).Select(x => x.BytesServed).SingleAsync(), stopMs = timer.Elapsed.TotalMilliseconds });

    var stillBroken = new FailingCommands { WritesOnly = true };
    var unavailable = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(stillBroken).Options);
    using var failingAccounting = new DownloadAccounting(unavailable, TimeProvider.System, logger);
    failingAccounting.Add(id, 456);
    await failingAccounting.StartAsync(default);
    failingAccounting.Wake();
    await Until(() => stillBroken.Writes >= 1);
    timer.Restart();
    await failingAccounting.StopAsync(default).WaitAsync(TimeSpan.FromSeconds(2));
    Evidence("shutdown during persistent accounting failures", new { stopMs = timer.Elapsed.TotalMilliseconds, attempts = stillBroken.Writes, task = failingAccounting.ExecuteTask!.Status.ToString() });
}

// Cancellation can be signalled before CreateLinkedTokenSource / token caching.
var errors = 0;
for (var i = 0; i < 2000; i++)
{
    using var parent = new CancellationTokenSource();
    if (i % 2 == 0) parent.Cancel();
    var governor = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    TransferLease? lease = null;
    await Task.WhenAll(Task.Run(() => lease = governor.TryAdmit("a", "v", "w", null, governor.Stamp("a", "v", "h"), null, parent.Token, out _, "h", 1)), Task.Run(parent.Cancel));
    if (lease is null || !lease.Token.IsCancellationRequested) errors++;
    lease?.Dispose();
    if (governor.ActiveTransfers != 0) errors++;
}
Evidence("already-cancelled and admission-racing tokens", new { trials = 2000, errors });

public sealed class Captured<T> : ILogger<T>
{
    public ConcurrentQueue<(LogLevel Level, string Text)> Lines { get; } = new();
    public bool IsEnabled(LogLevel level) => true;
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> format) => Lines.Enqueue((level, format(state, exception)));
}
public sealed class FailingCommands : DbCommandInterceptor
{
    public volatile bool Enabled = true;
    public string Kind = "unexpected";
    public bool WritesOnly;
    public bool HoldReader;
    public int Reads;
    public int Writes;
    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData data, InterceptionResult<DbDataReader> result, CancellationToken ct = default)
    {
        if (!WritesOnly && Enabled && command.CommandText.Contains("\"ViewerDownloads\""))
        {
            var n = Interlocked.Increment(ref Reads);
            if (HoldReader) await Task.Delay(Timeout.Infinite, ct);
            if (Kind == "known") throw new InvalidOperationException("known maintenance failure " + n);
            throw new NotSupportedException("unexpected maintenance failure " + n);
        }
        return result;
    }
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData data, InterceptionResult<int> result, CancellationToken ct = default)
    {
        if (WritesOnly && Enabled && command.CommandText.StartsWith("UPDATE \"ViewerDownloads\" SET \"BytesServed\""))
        {
            var n = Interlocked.Increment(ref Writes);
            throw new NotSupportedException("accounting failure " + n);
        }
        return ValueTask.FromResult(result);
    }
}
public sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
{
    public StreamarrDbContext CreateDbContext() => new(options);
    public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
}
public sealed class Idle : ILiveStreamSignal { public int LiveStreams => 0; public bool Active => false; }
