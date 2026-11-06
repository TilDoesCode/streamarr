using System.Reflection;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Streamarr.Server.Persistence;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Usenet.Nntp;

static void Evidence(string name, object data) => Console.WriteLine(JsonSerializer.Serialize(new { name, data }));

// Invoke the production middleware without Dev World's AllowAnyHeader CORS wrapper.
var context = new DefaultHttpContext();
context.Request.Path = "/api/v1/offline/" + new string('a', 64);
context.Request.Method = "OPTIONS";
context.Request.Headers.Origin = "https://verifier.invalid";
context.Request.Headers.AccessControlRequestMethod = "GET";
context.Request.Headers.AccessControlRequestHeaders = "range,if-range";
var middleware = new ViewerCorsMiddleware(_ => Task.CompletedTask,
    Options.Create(new StreamarrOptions { ViewerCorsOrigins = ["https://verifier.invalid"] }));
await middleware.InvokeAsync(context);
Evidence("production CORS preflight", new { context.Response.StatusCode, allowedHeaders = context.Response.Headers.AccessControlAllowHeaders.ToString() });

var client = DispatchProxy.Create<INntpClient, NoNntp>();
var manager = new SessionManager(client,
    Options.Create(new StreamarrOptions { MaxSessions = 1, SessionTtlSeconds = 300, EphemeralCacheSizeMb = 100 }),
    NullLogger<SessionManager>.Instance);
var file = new ResolvedMediaFile
{
    FileName = "test.mp4", Container = "mp4", SizeBytes = 4096,
    OpenStream = _ => new MemoryStream(new byte[4096]),
};
var live = manager.CreateSession("live-release", "live-work", file, client: "streamarr-viewer", requestedById: "viewer-1");
using var stream = manager.OpenStream(live);
var first = stream.ReadByte();
ActiveSession? transfer = null;
string? admissionError = null;
try { transfer = manager.CreateSession("download-release", "download-work", file, client: SessionManager.TransferClient, requestedById: "viewer-2"); }
catch (ResourceCapacityException e) { admissionError = e.GetType().Name; }
string? failure = null;
try { stream.ReadByte(); } catch (Exception e) { failure = e.GetType().Name; }
Evidence("download admission at full session count", new { first, liveClosed = live.IsClosed, failure, sessions = manager.ListSessions().Count, admissionError, isTransfer = transfer?.IsTransfer });

// Both limit validation and the migration use the actual product model/configuration.
foreach (var settings in new[] {
    new ViewerDownloadSettings { MaxActivePerViewer = 0 },
    new ViewerDownloadSettings { MaxActiveGlobal = 0 },
    new ViewerDownloadSettings { CapabilityDays = 0 },
    new ViewerDownloadSettings { ConnectionSharePercent = 101 },
    new ViewerDownloadSettings { BandwidthWhileStreamingKbps = -1 },
}) Evidence("invalid settings rejected", settings.Validate());

var root = Environment.GetEnvironmentVariable("DL_VERIFY_ROOT") ?? Directory.GetCurrentDirectory();
var legacyPath = Path.Combine(root, "tools/dl-verify/legacy.db");
File.Delete(legacyPath);
await using (var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={legacyPath}").Options))
{
    var migrations = db.Database.GetMigrations().ToArray();
    await db.GetService<IMigrator>().MigrateAsync("20261106194206_ViewerDownloads");
    await db.Database.ExecuteSqlRawAsync("""
        INSERT INTO Viewers (Id, Username, NormalizedUsername, DisplayName, PasswordHash, PasswordSalt,
            MustChangePassword, IsDisabled, BlockUnrated, AllowTranscoding, AllowUsenetSpeedTest,
            FailedLoginCount, CreatedAt, UpdatedAt)
        VALUES ('legacy-viewer', 'legacy', 'LEGACY', 'Legacy', 'hash', 'salt', 0, 0, 0, 1, 1, 0, 1, 1)
        """);
    await db.Database.ExecuteSqlRawAsync("""
        INSERT INTO ViewerDownloads (Id,ViewerId,SessionId,DeviceId,ClientRef,WorkId,RequestedReleaseId,State,RequestJson,BytesServed,CreatedAt,UpdatedAt)
        VALUES ('dup-old','legacy-viewer','session1',' Device ','ref','tmdb-movie-1','release','failed','{{}}',0,1,1),
               ('dup-new','legacy-viewer','session2','device','ref','tmdb-movie-1','release','failed','{{}}',0,2,2),
               ('dup-third','legacy-viewer','session3','DEVICE','ref','tmdb-movie-1','release','failed','{{}}',0,3,3)
        """);
    await db.Database.MigrateAsync();
    Evidence("migration with pre-existing duplicates", await db.ViewerDownloads.OrderBy(x => x.CreatedAt).Select(x => new { x.Id, x.DeviceKey }).ToListAsync());
    var legacy = await db.Viewers.SingleAsync(v => v.Id == "legacy-viewer");
    Evidence("upgrade existing viewer through download migration", new { legacy.AllowDownloads, legacy.MaxConcurrentDownloads, downloads = await db.ViewerDownloads.CountAsync() });
}

var governor = new DownloadTransferGovernor(() => new ViewerDownloadSettings { BandwidthKbps = 8 }, new Idle());
await governor.ThrottleAsync((int)DownloadTransferGovernor.Capacity(1000), CancellationToken.None);
for (var i = 0; i < 4; i++)
{
    using var cancel = new CancellationTokenSource(20);
    try { await governor.ThrottleAsync(1000, cancel.Token); }
    catch (OperationCanceledException) { }
}
var clock = System.Diagnostics.Stopwatch.StartNew();
await governor.ThrottleAsync(1, CancellationToken.None);
Evidence("cancelled bandwidth reservations delay later requests", new { sentBytes = 0, nextRequestBytes = 1, waitMs = clock.ElapsedMilliseconds });

// All strings below are accepted by the public prepare contract.
await using (var db = new StreamarrDbContext(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={legacyPath}").Options))
{
    var migrations = db.Database.GetMigrations().ToArray();
    await db.GetService<IMigrator>().MigrateAsync("20261106194206_ViewerDownloads");
    await db.Database.ExecuteSqlRawAsync("""
        INSERT INTO ViewerDownloads (Id,ViewerId,SessionId,DeviceId,ClientRef,WorkId,RequestedReleaseId,State,RequestJson,BytesServed,CreatedAt,UpdatedAt)
        VALUES ('pipe-one','legacy-viewer','session1','alpha|beta','gamma','tmdb-movie-1','release','failed','{{}}',0,4,4),
               ('pipe-two','legacy-viewer','session2','alpha','beta|gamma','tmdb-movie-1','release','failed','{{}}',0,5,5)
        """);
    try { await db.Database.MigrateAsync(); Evidence("migration with distinct delimiter tuples", "passed"); }
    catch (Exception ex) { Evidence("migration with distinct delimiter tuples", new { error = ex.GetType().Name, message = ex.Message }); }
}

var fair = new DownloadTransferGovernor(() => new ViewerDownloadSettings { BandwidthKbps = 8 }, new Idle());
await fair.ThrottleAsync((int)DownloadTransferGovernor.Capacity(1000), CancellationToken.None);
var large = fair.ThrottleAsync(1000, CancellationToken.None).AsTask();
var timer = System.Diagnostics.Stopwatch.StartNew();
var smallBytes = 0;
while (timer.ElapsedMilliseconds < 1800)
{
    await fair.ThrottleAsync(1, CancellationToken.None);
    smallBytes++;
    await Task.Delay(10);
}
Evidence("small requests competing with larger request", new { elapsedMs = timer.ElapsedMilliseconds, smallBytes, largeCompleted = large.IsCompleted });
await large.WaitAsync(TimeSpan.FromSeconds(3));
Evidence("larger request after small competitor stops", new { elapsedMs = timer.ElapsedMilliseconds });

var pinnedViolations = 0;
var evictionAttempts = 0;
for (var i = 0; i < 400; i++)
{
    var racedManager = new SessionManager(client, Options.Create(new StreamarrOptions { MaxSessions = 1 }), NullLogger<SessionManager>.Instance);
    var session = racedManager.CreateSession("transfer", "work", file, SessionManager.TransferClient, "viewer");
    using var barrier = new Barrier(2);
    await Task.WhenAll(Task.Run(() =>
    {
        barrier.SignalAndWait();
        if (!(bool)typeof(ActiveSession).GetMethod("TryPin", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(session, null)!) return;
        Thread.SpinWait(10000);
        if (session.IsClosed) Interlocked.Increment(ref pinnedViolations);
        typeof(ActiveSession).GetMethod("Unpin", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(session, null);
    }), Task.Run(() =>
    {
        barrier.SignalAndWait();
        Interlocked.Increment(ref evictionAttempts);
        try { racedManager.CreateSession("live", "work", file, "streamarr-viewer", "another-viewer"); }
        catch (ResourceCapacityException) { }
    }));
}
Evidence("pin versus actual eviction pressure", new { evictionAttempts, pinnedViolations });

public class NoNntp : DispatchProxy
{
    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
        => targetMethod?.Name == "Dispose" ? null : throw new NotSupportedException(targetMethod?.Name);
}

public sealed class Idle : ILiveStreamSignal
{
    public int LiveStreams => 0;
    public bool Active => false;
}
