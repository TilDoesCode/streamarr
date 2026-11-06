using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Services;

var root = Environment.GetEnvironmentVariable("DL_VERIFY_ROOT") ?? Directory.GetCurrentDirectory();
Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(root, "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var (viewer, _, viewerId) = await Dl.ViewerAsync(factory, admin, "pending-signout");
using (viewer)
{
    var list = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    factory.Media.ProbeGate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var prepared = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, deviceId = "phone" }, 202);
    var id = prepared.GetProperty("downloadId").GetString();
    var path = "/api/v1/viewer/downloads/" + id;
    string? state = null;
    for (var i = 0; i < 100; i++)
    {
        var current = JsonDocument.Parse(await viewer.GetStringAsync(path)).RootElement;
        state = current.GetProperty("state").GetString();
        if (state == "probing") break;
        await Task.Delay(10);
    }
    var pendingPoll = viewer.GetAsync(path + "?waitMs=10000&deviceId=phone");
    await Task.Delay(150);
    var revoke = await admin.DeleteAsync("/api/v1/config/viewers/" + viewerId + "/sessions");
    factory.Media.ProbeGate.SetResult();
    using var response = await pendingPoll.WaitAsync(TimeSpan.FromSeconds(5));
    var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
    var url = body.TryGetProperty("fileUrl", out var u) ? u.GetString() : null;
    using var anonymous = factory.CreateClient();
    using var file = url is null ? null : await anonymous.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
    using var staleAuth = await viewer.GetAsync(path);
    Console.WriteLine("PREPARING_SECURITY " + JsonSerializer.Serialize(new { before = state, revoke = (int)revoke.StatusCode, oldBearer = (int)staleAuth.StatusCode,
        pendingPoll = (int)response.StatusCode, after = body.TryGetProperty("state", out var stateJson) ? stateJson.GetString() : null, fileUrlRevoked = body.TryGetProperty("fileUrlRevoked", out var revokedJson) ? revokedJson.GetBoolean() : (bool?)null, file = file is null ? (int?)null : (int)file.StatusCode }));
}

// FIFO preparation queue: once finite capacity contention clears, queued work proceeds.
var (queuedViewer, _, _) = await Dl.ViewerAsync(factory, admin, "fair-prepare");
using (queuedViewer)
{
    var list = await Dl.PostAsync(queuedViewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-movie-501", device = Dl.AndroidTv });
    var release = list.GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
    factory.Media.ProbeGate = null;
    var busy = true;
    var order = new List<string>();
    factory.Resolver.Script = (call, _, ct) =>
    {
        if (busy) throw new ResourceCapacityException("controlled capacity contention");
        order.Add(call.ReleaseId);
        return Task.FromResult(FakePlaybackResolver.Ready(call.ReleaseId));
    };
    var ids = new List<string>();
    for (var i = 0; i < 4; i++)
    {
        var p = await Dl.PostAsync(queuedViewer, "/api/v1/viewer/downloads", new { workId = "tmdb-movie-501", releaseId = release, device = Dl.AndroidTv, clientRef = "fair-" + i }, 202);
        ids.Add(p.GetProperty("downloadId").GetString()!);
        await Task.Delay(30);
    }
    await Task.Delay(100);
    busy = false;
    var results = new List<string>();
    foreach (var id in ids)
        results.Add((await Dl.WaitAsync(queuedViewer, id)).GetProperty("state").GetString()!);
    Console.WriteLine("PREPARE_QUEUE " + JsonSerializer.Serialize(new { states = results, resolved = order.Count }));
}
