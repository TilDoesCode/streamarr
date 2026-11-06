using System.Data.Common;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;
using Streamarr.Server.Viewers;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
static void Evidence(string name, object data) => Console.WriteLine("EVIDENCE " + JsonSerializer.Serialize(new { name, data }));
async Task<(HttpClient Viewer, string Username, string ViewerId, JsonElement Ready)> Ready(string suffix, string device = "Phone")
{
    var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, admin, "life-" + suffix);
    var list = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var start = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, deviceId = device, clientRef = "same" }, 202);
    return (viewer, username, viewerId, await Dl.WaitAsync(viewer, start.GetProperty("downloadId").GetString()!));
}

// A request may be cancelled immediately after the session transaction commits.
// An EF transaction interceptor creates that exact boundary without product edits.
var ready = await Ready("cancel");
using (ready.Viewer)
using (var cancelled = new CancellationTokenSource())
{
    var interceptor = new CancelCommit(cancelled);
    var original = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
    var wrapped = new WrappedFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(interceptor).Options);
    var sessions = ActivatorUtilities.CreateInstance<ViewerSessionService>(factory.Services, wrapped);
    string? failure = null;
    try { await sessions.RevokeAllAsync(ready.ViewerId, "revoked_by_admin", null, cancelled.Token); }
    catch (Exception e) { failure = e.GetType().Name; }
    var url = ready.Ready.GetProperty("fileUrl").GetString()!;
    using var anonymous = factory.CreateClient();
    using var file = await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
    using var stale = await ready.Viewer.GetAsync("/api/v1/viewer/downloads");
    await using var db = new StreamarrDbContext(original);
    var gen = await db.Viewers.Where(v => v.Id == ready.ViewerId).Select(v => v.SecurityGeneration).SingleAsync();
    Evidence("security cancellation after transaction commits", new { failure, committed = interceptor.Fired, generation = gen, oldBearer = (int)stale.StatusCode, file = (int)file.StatusCode });
    // Reproduce restart recovery: the persisted generation has advanced, yet
    // neither a request nor the 500ms background access sweep checks it.
    await Task.Delay(1200);
    using var again = await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
    Evidence("cancelled revocation remains unapplied after access sweeps", new { file = (int)again.StatusCode });
}

// Case folding belongs to the device ID contract, including after relogin.
var casing = await Ready("case");
using (casing.Viewer)
using (var again = await Dl.DeviceAsync(factory, casing.Username, "Second session"))
{
    var id = casing.Ready.GetProperty("downloadId").GetString()!;
    var release = casing.Ready.GetProperty("requestedReleaseId").GetString();
    var retry = await Dl.PostAsync(again, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, deviceId = " PHONE ", clientRef = "same" }, 202);
    using var response = await again.GetAsync("/api/v1/viewer/downloads/" + id + "?deviceId=PHONE");
    var record = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    Evidence("case-insensitive idempotency versus device ownership", new { sameId = retry.GetProperty("downloadId").GetString() == id, retryUrl = retry.GetProperty("fileUrl").ValueKind.ToString(), getUrl = record.GetProperty("fileUrl").ValueKind.ToString(), thisDevice = record.GetProperty("thisDevice").GetBoolean() });
}

var contention = await Ready("locks");
using (contention.Viewer)
{
    var downloads = factory.Services.GetRequiredService<ViewerDownloadService>();
    var hook = typeof(ViewerDownloadService).GetProperty("BeforeLifecycleCommit", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var id = contention.Ready.GetProperty("downloadId").GetString()!;
    var renew = "/api/v1/viewer/downloads/" + id + "/renew?deviceId=Phone";
    // Exceptions inside a transaction must release both transaction and keyed lock.
    hook.SetValue(downloads, (Func<string, string, Task>)((operation, current) => operation == "renew" && current == id ? Task.FromException(new IOException("verifier lifecycle exception")) : Task.CompletedTask));
    int? failedStatus = null;
    string? thrown = null;
    try { using var failed = await contention.Viewer.PostAsJsonAsync(renew, new { }); failedStatus = (int)failed.StatusCode; }
    catch (Exception ex) { thrown = ex.GetType().Name; }
    hook.SetValue(downloads, null);
    using var recovered = await contention.Viewer.PostAsJsonAsync(renew, new { });
    Evidence("lifecycle exception releases transaction and lock", new { failedStatus, thrown, recovered = (int)recovered.StatusCode });

    var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var releaseGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var calls = 0;
    hook.SetValue(downloads, (Func<string, string, Task>)(async (operation, current) =>
    {
        if (operation == "renew" && current == id && Interlocked.Increment(ref calls) == 1)
        { entered.TrySetResult(); await releaseGate.Task; }
    }));
    var firstRenew = contention.Viewer.PostAsJsonAsync(renew, new { });
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    var cancelled = Enumerable.Range(0, 30).Select(async _ =>
    {
        using var stop = new CancellationTokenSource(50);
        try { using var response = await contention.Viewer.PostAsJsonAsync(renew, new { }, stop.Token); return (int)response.StatusCode; }
        catch (OperationCanceledException) { return -1; }
    }).ToArray();
    var statuses = await Task.WhenAll(cancelled);
    releaseGate.SetResult();
    using var originalRenew = await firstRenew.WaitAsync(TimeSpan.FromSeconds(5));
    hook.SetValue(downloads, null);
    var wave = await Task.WhenAll(Enumerable.Range(0, 30).Select(_ => contention.Viewer.PostAsJsonAsync(renew, new { })));
    using var final = await contention.Viewer.GetAsync("/api/v1/viewer/downloads/" + id + "?deviceId=Phone");
    var field = typeof(ViewerDownloadService).GetField("_downloadLocks", BindingFlags.Instance | BindingFlags.NonPublic)!;
    var keyed = field.GetValue(downloads)!;
    var activeKeys = keyed.GetType().GetProperty("ActiveKeyCount", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(keyed);
    Evidence("cancelled keyed-lock waiters and concurrent lifecycle wave", new { cancelled = statuses.Count(x => x == -1), otherStatuses = statuses.Where(x => x != -1).ToArray(), renewed = (int)originalRenew.StatusCode, success = wave.Count(x => x.IsSuccessStatusCode), total = wave.Length, final = (int)final.StatusCode, activeKeys });
    foreach (var response in wave) response.Dispose();
}

var listed = await Ready("list");
using (listed.Viewer)
{
    var original = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
    await using var db = new StreamarrDbContext(original);
    var viewer = await db.Viewers.SingleAsync(v => v.Id == listed.ViewerId);
    var session = await db.ViewerSessions.SingleAsync(s => s.ViewerId == listed.ViewerId && s.RevokedAt == null);
    var caller = new ViewerCaller(viewer.Id, session.Id, viewer.Username, "verifier");
    var hold = new HoldList();
    var wrapped = new WrappedFactory(new DbContextOptionsBuilder<StreamarrDbContext>(original).AddInterceptors(hold).Options);
    using var downloads = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, wrapped);
    var pending = downloads.ListAsync(caller, viewer, "all", "Phone", CancellationToken.None);
    await hold.Entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
    using var revoked = await admin.DeleteAsync("/api/v1/config/viewers/" + viewer.Id + "/sessions");
    hold.Release.TrySetResult();
    int status;
    bool dtoReturned;
    try { _ = await pending; status = 200; dtoReturned = true; }
    catch (ViewerProblem p) { status = p.Status; dtoReturned = false; }
    Evidence("response-time list check after concurrent committed signout", new { revoke = (int)revoked.StatusCode, status, dtoReturned });
}

public sealed class CancelCommit(CancellationTokenSource cancel) : DbTransactionInterceptor
{
    public bool Fired { get; private set; }
    public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
    {
        Fired = true;
        cancel.Cancel();
        return Task.CompletedTask;
    }
}
public sealed class WrappedFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
{
    public StreamarrDbContext CreateDbContext() => new(options);
    public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
}
public sealed class HoldList : DbCommandInterceptor
{
    public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _used;
    public override async ValueTask<DbDataReader> ReaderExecutedAsync(DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
    {
        if (!_used && command.CommandText.Contains("FROM \"ViewerDownloads\"", StringComparison.Ordinal))
        {
            _used = true;
            Entered.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
        }
        return result;
    }
}
