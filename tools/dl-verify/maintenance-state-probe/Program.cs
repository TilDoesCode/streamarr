using System.Collections.Concurrent;
using System.Data.Common;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Streamarr.Server.Persistence;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers.Downloads;

var root = Directory.GetCurrentDirectory();
Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(root, "server/src/Streamarr.Server"));
var dir = Path.Combine(root, "tools/dl-verify/round4d-state", Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(dir);
var checks = 0;
var failures = 0;
void Check(string name, bool ok, object evidence)
{
    checks++; if (!ok) failures++;
    Console.WriteLine("STATE " + JsonSerializer.Serialize(new { name, passed = ok, evidence }));
}
static async Task Until(Func<Task<bool>> check)
{
    var timer = Stopwatch.StartNew();
    while (!await check()) { if (timer.Elapsed > TimeSpan.FromSeconds(20)) throw new TimeoutException(); await Task.Delay(25); }
}
ViewerDownloadFactory Host(Action<IServiceCollection>? configure = null)
    => (ViewerDownloadFactory)Activator.CreateInstance(typeof(ViewerDownloadFactory), BindingFlags.Instance | BindingFlags.NonPublic,
        null, new object?[] { dir, false, configure }, null)!;
static async Task<string> Prepare(ViewerDownloadFactory host, HttpClient viewer)
{
    var list = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var row = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv }, 202);
    return row.GetProperty("downloadId").GetString()!;
}
var queued = new List<(string Id, string Viewer)>();
try
{
    using (var before = Host())
    {
        before.Resolver.Script = async (_, _, ct) => { await Task.Delay(Timeout.Infinite, ct); throw new InvalidOperationException(); };
        using var admin = await before.AdminAsync();
        (await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
        foreach (var name in new[] { "state-queued-a", "state-queued-b" })
        {
            var (viewer, _, viewerId) = await Dl.ViewerAsync(before, admin, name);
            using (viewer) queued.Add((await Prepare(before, viewer), viewerId));
        }
        await Until(() => Task.FromResult(!before.Resolver.Calls.IsEmpty));
    }

    var logs = new Captured<ViewerDownloadService>();
    var accountingLogs = new Captured<DownloadAccounting>();
    var injection = new Failures();
    using var after = Host(services =>
    {
        services.RemoveAll<IDbContextFactory<StreamarrDbContext>>();
        services.AddSingleton<IDbContextFactory<StreamarrDbContext>>(sp => new OptionsFactory(
            new DbContextOptionsBuilder<StreamarrDbContext>(sp.GetRequiredService<DbContextOptions<StreamarrDbContext>>()).AddInterceptors(injection).Options));
        services.AddSingleton<ILogger<ViewerDownloadService>>(logs);
        services.AddSingleton<ILogger<DownloadAccounting>>(accountingLogs);
    });
    var requestGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    string? requestedViewer = null;
    after.Resolver.Script = async (call, _, ct) =>
    {
        if (call.ViewerId == requestedViewer) await requestGate.Task.WaitAsync(ct);
        return FakePlaybackResolver.Ready(call.ReleaseId);
    };
    using var admin2 = await after.AdminAsync();
    var service = after.Services.GetRequiredService<ViewerDownloadService>();
    var governor = after.Services.GetRequiredService<DownloadTransferGovernor>();
    var accounting = after.Services.GetRequiredService<DownloadAccounting>();
    using var orphan = governor.TryAdmit("orphan", "viewer", "work", null, governor.Stamp("orphan", "viewer", "h"), DateTimeOffset.MaxValue, default, out _, "h", 1)!;
    async Task<JsonElement> State() => JsonDocument.Parse(await admin2.GetStringAsync("/api/v1/config/viewers/downloads")).RootElement.Clone();
    static JsonElement Component(JsonElement body, string name) => body.GetProperty("maintenance").EnumerateArray().Single(x => x.GetProperty("component").GetString() == name);
    await Until(async () => Component(await State(), "sweep").GetProperty("consecutiveFailures").GetInt32() >= 3 && Component(await State(), "resume").GetProperty("degraded").GetBoolean());
    var degraded = await State();
    Check("HTTP degraded state on real resume and sweep failures", new[] { "resume", "sweep" }.All(c =>
        Component(degraded,c).GetProperty("degraded").GetBoolean() && Component(degraded,c).GetProperty("failingSince").ValueKind == JsonValueKind.String && Component(degraded,c).GetProperty("lastFailureAt").ValueKind == JsonValueKind.String),
        degraded.GetProperty("maintenance"));
    var firstWarnings = logs.Lines.Where(x => x.Level == LogLevel.Warning).ToArray();
    Check("third-failure warnings are independent per component", firstWarnings.Length == 2 && firstWarnings.All(x => x.Text.Contains("3 consecutive failures")) && firstWarnings.Any(x => x.Text.Contains("(open transfer check)")) && firstWarnings.Any(x => x.Text.Contains("(preparation resume)")),
        firstWarnings.Select(x => x.Text));
    Check("DTO and warning redact full capability URLs", !degraded.GetRawText().Contains(Failures.Secret) && !degraded.GetRawText().Contains(Failures.Url) && firstWarnings.All(x => !x.Text.Contains(Failures.Secret) && x.Error is null),
        new { warningCount = firstWarnings.Length, error = Component(degraded,"sweep").GetProperty("lastError").GetString() });

    var reads = injection.SweepReads;
    after.Clock.Advance(TimeSpan.FromMinutes(4));
    await Until(() => Task.FromResult(injection.SweepReads >= reads + 2));
    Check("no additional warning before five minutes despite changing errors", logs.Lines.Count(x => x.Level == LogLevel.Warning) == 2, new { warnings = logs.Lines.Count(x => x.Level == LogLevel.Warning), injection.SweepReads });
    reads = injection.SweepReads;
    after.Clock.Advance(TimeSpan.FromMinutes(1.1));
    await Until(() => Task.FromResult(logs.Lines.Count(x => x.Level == LogLevel.Warning) >= 4));
    Check("five-minute recurring warning stays per component", logs.Lines.Count(x => x.Level == LogLevel.Warning) == 4, new { warnings = logs.Lines.Count(x => x.Level == LogLevel.Warning) });

    // Decision A: resume retries do not prevent the rest of the sweep running.
    injection.FailSweep = false;
    await Until(() => Task.FromResult(orphan.Token.IsCancellationRequested));
    var partial = await State();
    Check("resume failure does not block a healthy sweep", Component(partial,"resume").GetProperty("degraded").GetBoolean() && !Component(partial,"sweep").GetProperty("degraded").GetBoolean(), partial.GetProperty("maintenance"));

    var (requested, _, requestViewer) = await Dl.ViewerAsync(after, admin2, "state-requested");
    using (requested)
    {
        requestedViewer = requestViewer;
        var requestedId = await Prepare(after, requested);
        await Until(() => Task.FromResult(after.Resolver.Calls.Any(c => c.ViewerId == requestViewer)));
        injection.FailResume = false;
        await Until(async () => Component(await State(), "resume").GetProperty("lastSuccessAt").ValueKind == JsonValueKind.String);
        var successfulReads = injection.ResumeReads;
        requestGate.TrySetResult();
        foreach (var id in queued.Select(q => q.Id).Append(requestedId))
            await Until(async () => (await State()).GetProperty("items").EnumerateArray().Any(x => x.GetProperty("downloadId").GetString() == id && x.GetProperty("state").GetString() == "ready"));
        await Task.Delay(2200);
        var counts = queued.Select(q => q.Viewer).Append(requestViewer).Select(id => after.Resolver.Calls.Count(c => c.ViewerId == id)).ToArray();
        Check("two interrupted preparations and one request start exactly once", counts.SequenceEqual(new[] { 1, 1, 1 }), new { counts });
        Check("resume never reruns after success", injection.ResumeReads == successfulReads, new { atSuccess = successfulReads, afterFourTicks = injection.ResumeReads });
        var recovered = await State();
        Check("HTTP degraded state clears after actual recovery", new[] { "sweep", "resume" }.All(c => !Component(recovered,c).GetProperty("degraded").GetBoolean() && Component(recovered,c).GetProperty("failingSince").ValueKind == JsonValueKind.Null && Component(recovered,c).GetProperty("lastSuccessAt").ValueKind == JsonValueKind.String), recovered.GetProperty("maintenance"));
        Check("one recovery Information per degraded component", logs.Lines.Count(x => x.Level == LogLevel.Information && x.Text.Contains("recovered after")) == 2, logs.Lines.Where(x => x.Level == LogLevel.Information && x.Text.Contains("recovered after")).Select(x => x.Text));

        // Actual failed writes must be reflected by the same singleton used by HTTP.
        injection.FailWrites = true;
        accounting.Add(requestedId, 123);
        for (var i = 1; i <= 3; i++) { accounting.Wake(); await Until(() => Task.FromResult(injection.WriteFailures >= i)); }
        var writes = await State();
        Check("HTTP accounting degradation and redaction", Component(writes,"accounting").GetProperty("degraded").GetBoolean() && !Component(writes,"accounting").GetRawText().Contains(Failures.Secret), Component(writes,"accounting"));
        injection.FailWrites = false;
        accounting.Wake();
        await Until(async () => !Component(await State(),"accounting").GetProperty("degraded").GetBoolean());
        await using var db = await after.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync();
        var bytes = await db.ViewerDownloads.Where(d => d.Id == requestedId).Select(d => d.BytesServed).SingleAsync();
        Check("accounting recovery clears HTTP degradation and retains bytes", bytes == 123 && accountingLogs.Lines.Count(x => x.Level == LogLevel.Information && x.Text.Contains("recovered after")) == 1, new { bytes });

        // Exercise failureRecord's projection with the production tracker, then reset.
        var tracker = (DownloadMaintenanceTracker)typeof(ViewerDownloadService).GetField("_failureRecord", BindingFlags.NonPublic | BindingFlags.Instance)!.GetValue(service)!;
        for (var n = 0; n < 3; n++) tracker.Failure(new IOException(Failures.Url));
        var failed = Component(await State(), "failureRecord");
        Check("all four components use redacted HTTP lastError", failed.GetProperty("degraded").GetBoolean() && !failed.GetRawText().Contains(Failures.Secret), failed);
        tracker.Success();
        Check("failureRecord recovery clears degradation", !Component(await State(),"failureRecord").GetProperty("degraded").GetBoolean(), new { component = "failureRecord" });
        var warnings = logs.Lines.Concat(accountingLogs.Lines).Where(x => x.Level == LogLevel.Warning).ToArray();
        Check("every component warning has redacted text and no attached exception", warnings.All(x => !x.Text.Contains(Failures.Secret) && !x.Text.Contains(Failures.Url) && x.Error is null), new { warnings = warnings.Length });
    }
    Console.WriteLine($"STATE_TOTAL {checks-failures}/{checks}");
    Environment.ExitCode = failures == 0 ? 0 : 1;
}
finally
{
    Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
    Directory.Delete(dir, true);
}

public sealed class Failures : DbCommandInterceptor
{
    public static readonly string Secret = new('a', 64);
    public static readonly string Url = "https://verifier.invalid/api/v1/offline/" + Secret;
    public volatile bool FailResume = true;
    public volatile bool FailSweep = true;
    public volatile bool FailWrites;
    public int ResumeReads, SweepReads, WriteFailures;
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData data, InterceptionResult<DbDataReader> result, CancellationToken ct = default)
    {
        if (command.CommandText.StartsWith("SELECT \"v\".\"Id\", \"v\".\"ViewerId\", \"v\".\"WorkId\"\nFROM \"ViewerDownloads\"", StringComparison.Ordinal))
        { var n = Interlocked.Increment(ref ResumeReads); if (FailResume) throw new InvalidOperationException("resume failure " + n + ": " + Url); }
        if (command.CommandText.StartsWith("SELECT \"v\".\"Id\", \"v\".\"State\", \"v\".\"CapabilityHash\", \"v\".\"ExpiresAt\"", StringComparison.Ordinal))
        { var n = Interlocked.Increment(ref SweepReads); if (FailSweep) throw new InvalidOperationException("sweep failure " + n + ": " + Url); }
        return ValueTask.FromResult(result);
    }
    public override ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(DbCommand command, CommandEventData data, InterceptionResult<int> result, CancellationToken ct = default)
    {
        if (FailWrites && command.CommandText.StartsWith("UPDATE \"ViewerDownloads\" SET \"BytesServed\""))
        { Interlocked.Increment(ref WriteFailures); throw new IOException(Url); }
        return ValueTask.FromResult(result);
    }
}
public sealed class Captured<T> : ILogger<T>
{
    public ConcurrentQueue<(LogLevel Level, string Text, Exception? Error)> Lines { get; } = new();
    public bool IsEnabled(LogLevel level) => true;
    public IDisposable? BeginScope<TState>(TState state) where TState:notnull => null;
    public void Log<TState>(LogLevel level, EventId id, TState state, Exception? error, Func<TState, Exception?, string> format) => Lines.Enqueue((level, format(state,error),error));
}
public sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
{
    public StreamarrDbContext CreateDbContext() => new(options);
    public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct=default) => Task.FromResult(new StreamarrDbContext(options));
}
