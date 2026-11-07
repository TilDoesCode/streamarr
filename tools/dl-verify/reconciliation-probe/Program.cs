using System.Data.Common;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Downloads;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var options = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
static void Evidence(string name, object data) => Console.WriteLine("RECONCILIATION " + JsonSerializer.Serialize(new { name, data }));
var sweep = typeof(ViewerDownloadService).GetMethod("SweepTransfersAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
Task Sweep(ViewerDownloadService service) => (Task)sweep.Invoke(service, new object[] { CancellationToken.None })!;
async Task<(HttpClient Viewer, string Username, string ViewerId, JsonElement Ready)> Ready(string suffix)
{
    var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, admin, "sweep-" + suffix);
    var candidates = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = candidates.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var prepared = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, deviceId = "Phone" }, 202);
    return (viewer, username, viewerId, await Dl.WaitAsync(viewer, prepared.GetProperty("downloadId").GetString()!));
}
async Task<JsonElement> Renew(string username, string id)
{
    using var again = await Dl.DeviceAsync(factory, username, "Phone");
    return await Dl.PostAsync(again, "/api/v1/viewer/downloads/" + id + "/renew?deviceId=phone", new { });
}
static string Hash(JsonElement dto) => ViewerDownloadService.Hash(dto.GetProperty("fileUrl").GetString()!.Split('/').Last());

// Hold only the sweep's second SQL query. It has already read the ready row/hash;
// the production renew/revoke endpoints then run normally on their own contexts.
var raced = await Ready("snapshot");
using (raced.Viewer)
{
    var id = raced.Ready.GetProperty("downloadId").GetString()!;
    var governor = factory.Services.GetRequiredService<DownloadTransferGovernor>();
    using var old = governor.TryAdmit(id, raced.ViewerId, "tmdb-movie-501", null, governor.Stamp(id, raced.ViewerId), null, CancellationToken.None, out _, Hash(raced.Ready))!;
    var held = new Queries { HoldViewerQuery = true };
    var wrapped = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(options).AddInterceptors(held).Options);
    using var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, wrapped, governor);
    var checking = Sweep(service);
    await held.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    using var revoked = await admin.DeleteAsync("/api/v1/config/viewers/" + raced.ViewerId + "/sessions");
    var renewed = await Renew(raced.Username, id);
    factory.Files.ReadDelay = TimeSpan.FromMilliseconds(100);
    using var anonymous = factory.CreateClient();
    using var response = await anonymous.GetAsync(renewed.GetProperty("fileUrl").GetString(), HttpCompletionOption.ResponseHeadersRead);
    var copied = ReadBody(response);
    held.Release.TrySetResult();
    await checking.WaitAsync(TimeSpan.FromSeconds(5));
    var received = await copied.WaitAsync(TimeSpan.FromSeconds(5));
    using var head = await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, renewed.GetProperty("fileUrl").GetString()));
    factory.Files.ReadDelay = TimeSpan.Zero;
    var retry = await anonymous.GetByteArrayAsync(renewed.GetProperty("fileUrl").GetString());
    Evidence("sweep snapshot versus new capability", new { revoked = (int)revoked.StatusCode, oldCancelled = old.Token.IsCancellationRequested, get = (int)response.StatusCode, expected = renewed.GetProperty("sizeBytes").GetInt64(), received.Bytes, received.Error, newUrl = (int)head.StatusCode, retryBytes = retry.Length });
}

// Delay the post-commit notification without delaying or editing the transaction.
// A renewal may be admitted before the synchronous follow-up aborts by download ID.
var notified = await Ready("notification");
using (notified.Viewer)
{
    var id = notified.Ready.GetProperty("downloadId").GetString()!;
    var governor = factory.Services.GetRequiredService<DownloadTransferGovernor>();
    var delayed = new DelayedListener();
    using var listeners = new ServiceCollection().AddSingleton<IViewerAccessListener>(delayed)
        .AddSingleton<IViewerAccessListener>(factory.Services.GetRequiredService<ViewerDownloadService>()).BuildServiceProvider();
    var sessions = ActivatorUtilities.CreateInstance<ViewerSessionService>(factory.Services, new ViewerAccessEvents(listeners));
    var revoke = sessions.RevokeAllAsync(notified.ViewerId, "revoked_by_admin", null, CancellationToken.None);
    await delayed.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var renewed = await Renew(notified.Username, id);
    factory.Files.ReadDelay = TimeSpan.FromMilliseconds(100);
    using var anonymous = factory.CreateClient();
    using var response = await anonymous.GetAsync(renewed.GetProperty("fileUrl").GetString(), HttpCompletionOption.ResponseHeadersRead);
    var copied = ReadBody(response);
    delayed.Release.TrySetResult();
    await revoke.WaitAsync(TimeSpan.FromSeconds(5));
    var received = await copied.WaitAsync(TimeSpan.FromSeconds(5));
    using var head = await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, renewed.GetProperty("fileUrl").GetString()));
    factory.Files.ReadDelay = TimeSpan.Zero;
    var retry = await anonymous.GetByteArrayAsync(renewed.GetProperty("fileUrl").GetString());
    Evidence("post-commit follow-up versus renewed lease", new { get = (int)response.StatusCode, expected = renewed.GetProperty("sizeBytes").GetInt64(), received.Bytes, received.Error, newUrl = (int)head.StatusCode, retryBytes = retry.Length });
}

// Work at the configured maximum: 50 downloads / 100 requests. Real persisted
// rows and 5 viewers, with synthetic governor leases (no network or NNTP load).
var seed = await Ready("scale");
using (seed.Viewer)
{
    var governed = new DownloadTransferGovernor(() => new ViewerDownloadSettings { MaxActiveGlobal = 50, MaxActivePerViewer = 10 }, new Idle());
    var queries = new Queries();
    var wrapped = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(options).AddInterceptors(queries).Options);
    using var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, wrapped, governed);
    await Sweep(service);
    Evidence("idle sweep", new { reads = queries.Reads });
    var all = new List<TransferLease>();
    await using (var db = new StreamarrDbContext(options))
    {
        var viewer = await db.Viewers.SingleAsync(x => x.Id == seed.ViewerId);
        var row = await db.ViewerDownloads.SingleAsync(x => x.Id == seed.Ready.GetProperty("downloadId").GetString());
        for (var v = 0; v < 5; v++)
        {
            var clone = JsonSerializer.Deserialize<ViewerEntity>(JsonSerializer.Serialize(viewer))!;
            clone.Id = "scale-v-" + v; clone.Username = clone.Id; clone.NormalizedUsername = clone.Id.ToUpperInvariant();
            db.Viewers.Add(clone);
            for (var d = 0; d < 10; d++)
            {
                var copy = JsonSerializer.Deserialize<ViewerDownloadEntity>(JsonSerializer.Serialize(row))!;
                copy.Id = "scale-d-" + v + "-" + d; copy.ViewerId = clone.Id; copy.DeviceKey = null; copy.ClientRef = null;
                copy.CapabilityHash = ViewerDownloadService.Hash(copy.Id); db.ViewerDownloads.Add(copy);
                for (var l = 0; l < 2; l++) all.Add(governed.TryAdmit(copy.Id, clone.Id, copy.WorkId, null, governed.Stamp(copy.Id, clone.Id), null, CancellationToken.None, out _, copy.CapabilityHash)!);
            }
        }
        await db.SaveChangesAsync();
    }
    var samples = new List<double>();
    queries.Reads = 0;
    for (var i = 0; i < 100; i++) { var timer = Stopwatch.StartNew(); await Sweep(service); samples.Add(timer.Elapsed.TotalMilliseconds); }
    Evidence("100 maximal sweeps", new { leases = all.Count, reads = queries.Reads, medianMs = samples.Order().ElementAt(50), maxMs = samples.Max(), cancelled = all.Count(l => l.Token.IsCancellationRequested) });
    queries.FailOnce = true;
    await Sweep(service); await Sweep(service);
    Evidence("recoverable database error permits next sweep", new { reads = queries.Reads });
    foreach (var lease in all) lease.Dispose();
}

static async Task<(int Bytes, string? Error)> ReadBody(HttpResponseMessage response)
{
    var total = 0;
    try
    {
        using var stream = await response.Content.ReadAsStreamAsync();
        var buffer = new byte[65536];
        while (true) { var n = await stream.ReadAsync(buffer); if (n == 0) break; total += n; }
        return (total, null);
    }
    catch (Exception e) { return (total, e.GetType().Name); }
}

public sealed class Idle : ILiveStreamSignal { public int LiveStreams => 0; public bool Active => false; }
public sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
{
    public StreamarrDbContext CreateDbContext() => new(options);
    public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
}
public sealed class Queries : DbCommandInterceptor
{
    public int Reads;
    public bool HoldViewerQuery;
    public bool FailOnce;
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public override ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result, CancellationToken cancellationToken = default)
    {
        Reads++;
        if (FailOnce) { FailOnce = false; throw new InvalidOperationException("verifier transient database error"); }
        return ValueTask.FromResult(result);
    }
    public override async ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
    {
        if (HoldViewerQuery && command.CommandText.Contains("FROM \"Viewers\"", StringComparison.Ordinal))
        { HoldViewerQuery = false; Entered.TrySetResult(); await Release.Task.WaitAsync(cancellationToken); }
        return result;
    }
}
public sealed class DelayedListener : IViewerAccessListener
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public Task AccessChangedAsync(string viewerId, CancellationToken ct) => Task.CompletedTask;
    public async Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct) { Entered.TrySetResult(); await Release.Task.WaitAsync(ct); }
}
