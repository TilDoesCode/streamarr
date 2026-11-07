using System.Diagnostics;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var governor = factory.Services.GetRequiredService<DownloadTransferGovernor>();
var passed = 0;
var total = 0;
void Check(string name, bool ok, object data)
{
    total++; if (ok) passed++;
    Console.WriteLine("LEASE " + JsonSerializer.Serialize(new { name, passed = ok, data }));
}

foreach (var how in new[] { "delete", "admin", "complete", "security" })
{
    var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, admin, "renew-end-" + how);
    using (viewer)
    {
        var items = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
        var release = items.GetProperty("candidates").EnumerateArray().First(c => c.GetProperty("offline").GetProperty("playable").GetBoolean()).GetProperty("version").GetProperty("releaseId").GetString()!;
        factory.Media.Files[release] = new StreamFileInfo(release + ".mkv", 12_000_000, "mkv", "video/x-matroska");
        var prepare = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, deviceId = "phone" }, 202);
        var id = prepare.GetProperty("downloadId").GetString()!;
        var original = await Dl.WaitAsync(viewer, id);
        using var signout = await admin.DeleteAsync("/api/v1/config/viewers/" + viewerId + "/sessions");
        using var again = await Dl.DeviceAsync(factory, username, "new session");
        var renewed = await Dl.PostAsync(again, "/api/v1/viewer/downloads/" + id + "/renew?deviceId=PHONE", new { });
        var url = renewed.GetProperty("fileUrl").GetString()!;
        using var anonymous = factory.CreateClient();
        factory.Files.ReadDelay = TimeSpan.FromMilliseconds(100);
        using var one = await anonymous.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        var readingOne = Read(one);
        using var two = await anonymous.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        var readingTwo = Read(two);
        var since = Stopwatch.StartNew();
        using var answer = how switch
        {
            "delete" => await again.DeleteAsync("/api/v1/viewer/downloads/" + id),
            "admin" => await admin.DeleteAsync("/api/v1/config/viewers/downloads/" + id),
            "complete" => await again.PostAsJsonAsync("/api/v1/viewer/downloads/" + id + "/complete", new { }),
            _ => await admin.DeleteAsync("/api/v1/config/viewers/" + viewerId + "/sessions"),
        };
        var bytes = await Task.WhenAll(readingOne, readingTwo).WaitAsync(TimeSpan.FromSeconds(3));
        var elapsed = since.Elapsed.TotalMilliseconds;
        using var head = await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
        Check(how + " ends both requests on renewed capability", answer.IsSuccessStatusCode && bytes.All(x => x < 12_000_000) && elapsed <= 2000 && governor.ActiveFor(viewerId) == 0 && (int)head.StatusCode == (how == "security" ? 410 : 404),
            new { operation = (int)answer.StatusCode, get = new[] { (int)one.StatusCode, (int)two.StatusCode }, bytes, elapsedMs = elapsed, active = governor.ActiveFor(viewerId), file = (int)head.StatusCode });
    }
}
factory.Files.ReadDelay = TimeSpan.Zero;

// Different capabilities of one record: renew only B's deadline, expire A,
// then permanently end the record through B's revision.
var isolated = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
var at = DateTimeOffset.UnixEpoch;
using (var old = isolated.TryAdmit("d", "v", "work", null, isolated.Stamp("d", "v", "A"), at.AddSeconds(1), default, out _, "A", 1)!)
using (var fresh = isolated.TryAdmit("d", "v", "work", null, isolated.Stamp("d", "v", "B"), at.AddSeconds(1), default, out _, "B", 3)!)
{
    isolated.SetDeadline("d", "B", at.AddDays(30));
    var expired = isolated.ExpireDue(at.AddSeconds(2));
    Check("renewed capability deadline is independent", expired == 1 && old.Token.IsCancellationRequested && !fresh.Token.IsCancellationRequested, new { expired, oldEnded = old.Token.IsCancellationRequested, newEnded = fresh.Token.IsCancellationRequested });
    isolated.EndDownload("d", 4);
    Check("terminal revision ends current capability too", fresh.Token.IsCancellationRequested, new { newEnded = fresh.Token.IsCancellationRequested });
}
Check("deadline test releases all leases", isolated.ActiveTransfers == 0 && isolated.ActiveLeases().Count == 0, new { isolated.ActiveTransfers, count = isolated.ActiveLeases().Count });

// Parallel HTTP source failures and caller cancellations must release leases.
var (failureViewer, _, failureId) = await Dl.ViewerAsync(factory, admin, "lease-failures");
using (failureViewer)
{
    var list = await Dl.PostAsync(failureViewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    var start = await Dl.PostAsync(failureViewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv }, 202);
    var ready = await Dl.WaitAsync(failureViewer, start.GetProperty("downloadId").GetString()!);
    var url = ready.GetProperty("fileUrl").GetString();
    var statuses = new List<int>();
    using var anonymous = factory.CreateClient();
    for (var n = 0; n < 10; n++)
    {
        factory.Files.Failure = new DownloadSourceException(503, "download_source_unavailable", "verifier source failure");
        using var response = await anonymous.GetAsync(url);
        statuses.Add((int)response.StatusCode);
    }
    factory.Files.Failure = null;
    factory.Files.ReadDelay = TimeSpan.FromMilliseconds(100);
    for (var n = 0; n < 10; n++)
    {
        using var cancelled = new CancellationTokenSource();
        using var response = await anonymous.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancelled.Token);
        cancelled.Cancel();
        _ = await Read(response, cancelled.Token);
    }
    factory.Files.ReadDelay = TimeSpan.Zero;
    await Task.Delay(100);
    Check("source errors and cancellations release every slot", statuses.All(x => x == 503) && governor.ActiveFor(failureId) == 0, new { statuses, active = governor.ActiveFor(failureId) });
}

// Disposing another request while a snapshot is being cancelled is a legal
// request lifecycle: clients often stop all their ranges together.
foreach (var operation in new[] { "terminal", "capability", "snapshot", "expiry" })
{
    var g = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    using var first = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var second = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var callback = first.Token.Register(second.Dispose);
    string? error = null;
    try
    {
        switch (operation)
        {
            case "terminal": g.EndDownload("a", 1); break;
            case "capability": g.RetireCapability("a", "h"); break;
            case "snapshot": g.Cancel(g.ActiveLeases()); break;
            default: g.ExpireDue(at.AddSeconds(1)); break;
        }
    }
    catch (Exception ex) { error = ex.GetType().Name; }
    first.Dispose();
    Check(operation + " cancellation tolerates concurrent request disposal", error is null && g.ActiveTransfers == 0, new { error, g.ActiveTransfers });
}

// ExpireDue is outside SweepTransfersAsync's DB-recovery catch. Check the
// actual background task, not just a guessed consequence of its source.
{
    var g = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    using var first = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var second = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var callback = first.Token.Register(second.Dispose);
    using var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, g);
    string? thrown = null;
    try { await service.StartAsync(CancellationToken.None); }
    catch (Exception ex) { thrown = ex.GetType().Name; }
    await Task.Delay(100);
    var taskError = service.ExecuteTask?.Exception?.GetBaseException().GetType().Name;
    Check("expiry disposal race does not fault the background service", taskError is null && thrown is null, new { thrown, taskError, status = service.ExecuteTask?.Status.ToString() });
    try { await service.StopAsync(CancellationToken.None); } catch { }
}

// A non-reentrant stress variant: two real tasks retire/expire and dispose in
// parallel. They share only the public governor and lease APIs.
{
    var errors = 0;
    for (var n = 0; n < 2000; n++)
    {
        var g = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
        using var first = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
        using var second = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
        using var barrier = new Barrier(2);
        await Task.WhenAll(Task.Run(() =>
        {
            barrier.SignalAndWait();
            try { g.ExpireDue(at.AddSeconds(1)); } catch (ObjectDisposedException) { Interlocked.Increment(ref errors); }
        }), Task.Run(() => { barrier.SignalAndWait(); second.Dispose(); first.Dispose(); }));
    }
    Check("parallel disposal versus expiry has no exceptions", errors == 0, new { trials = 2000, errors });
}

// Let an actual Generic Host observe the production service fail while running.
// It has no listener; the service uses this fixture's existing real persistence.
{
    var g = new DownloadTransferGovernor(() => new ViewerDownloadSettings(), new Idle());
    var service = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, g);
    using var host = new HostBuilder().ConfigureServices(s => s.AddSingleton<IHostedService>(service)).Build();
    var stopped = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    using var registration = host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.Register(() => stopped.TrySetResult());
    await host.StartAsync();
    await Task.Delay(100);
    using var first = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var second = g.TryAdmit("a", "viewer", "work", null, g.Stamp("a", "viewer", "h"), at, default, out _, "h", 1)!;
    using var callback = first.Token.Register(second.Dispose);
    await Task.WhenAny(stopped.Task, Task.Delay(3000));
    Check("running host survives expiry versus disposal", !stopped.Task.IsCompleted, new
    {
        stopRequested = stopped.Task.IsCompleted,
        behavior = host.Services.GetRequiredService<IOptions<HostOptions>>().Value.BackgroundServiceExceptionBehavior.ToString(),
        taskError = service.ExecuteTask?.Exception?.GetBaseException().GetType().Name,
    });
    await host.StopAsync();
}
Console.WriteLine($"LEASE_TOTAL {passed}/{total}");
Environment.ExitCode = passed == total ? 0 : 1;

static async Task<long> Read(HttpResponseMessage response, CancellationToken ct = default)
{
    long count = 0;
    try
    {
        using var stream = await response.Content.ReadAsStreamAsync();
        var buffer = new byte[65536];
        while (true) { var n = await stream.ReadAsync(buffer, ct); if (n == 0) break; count += n; }
    }
    catch (Exception ex) when (ex is IOException or HttpRequestException or OperationCanceledException or ObjectDisposedException) { }
    return count;
}
public sealed class Idle : ILiveStreamSignal { public int LiveStreams => 0; public bool Active => false; }
