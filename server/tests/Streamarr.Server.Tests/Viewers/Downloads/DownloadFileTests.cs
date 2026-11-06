using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>The download file capability: static-file semantics, resume after a reset, limits, expiry and permission over fake bytes.</summary>
public sealed class DownloadFileTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>, IAsyncLifetime
{
    private const string Base = "/api/v1/viewer/downloads";
    private const string Movie = "tmdb-movie-501";
    private const long Size = 1_000_000;
    private HttpClient _admin = null!;
    private readonly Dictionary<string, string> _usernames = [];

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        factory.Files.ResetAfterBytes = null;
        factory.Files.OpenGate = null;
        factory.Files.Failure = null;
        factory.Files.ReadDelay = TimeSpan.Zero;
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private async Task<(HttpClient Viewer, string ViewerId, string DownloadId, string Url, string ETag, string ReleaseId)> ReadyAsync(string name, object? permissions = null, string fragment = "720p")
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, name, permissions);
        _usernames[viewerId] = username;
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv })).GetProperty("candidates");
        var releaseId = candidates.EnumerateArray().Single(c => c.GetProperty("version").GetProperty("name").GetString()!.Contains(fragment, StringComparison.Ordinal))
            .GetProperty("version").GetProperty("releaseId").GetString()!;
        var id = (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);
        Assert.Equal("ready", ready.GetProperty("state").GetString());
        return (viewer, viewerId, id, ready.GetProperty("fileUrl").GetString()!, ready.GetProperty("eTag").GetString()!, releaseId);
    }

    private static byte[] Expected(string releaseId) => FakeDownloadFileSource.Content(releaseId, Movie, Size);

    private static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpMethod method, string url, Action<HttpRequestMessage>? headers = null)
    {
        using var request = new HttpRequestMessage(method, url);
        headers?.Invoke(request);
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
    }

    [Fact]
    public async Task Head_AnswersTheFileHeaders_WithoutOpeningAnything()
    {
        var (_, _, _, url, etag, _) = await ReadyAsync("file-head");
        using var anon = factory.CreateClient();
        var opens = factory.Files.Opens.Count;

        using var response = await SendAsync(anon, HttpMethod.Head, url);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Size, response.Content.Headers.ContentLength);
        Assert.Equal(etag, response.Headers.ETag!.ToString());
        Assert.False(response.Headers.ETag.IsWeak);
        Assert.Equal("bytes", response.Headers.AcceptRanges.Single());
        Assert.Equal("attachment", response.Content.Headers.ContentDisposition!.DispositionType);
        Assert.Contains("no-store", response.Headers.CacheControl!.ToString());
        Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
        Assert.Equal(opens, factory.Files.Opens.Count);
    }

    [Fact]
    public async Task Get_ServesTheWholeFile_AndRanges_LikeAStaticFile()
    {
        var (viewer, _, id, url, etag, releaseId) = await ReadyAsync("file-get");
        using var anon = factory.CreateClient();
        var expected = Expected(releaseId);

        using var full = await SendAsync(anon, HttpMethod.Get, url);
        Assert.Equal(HttpStatusCode.OK, full.StatusCode);
        Assert.Equal(expected, await full.Content.ReadAsByteArrayAsync());

        using var range = await SendAsync(anon, HttpMethod.Get, url, r => r.Headers.Range = new RangeHeaderValue(100, 199));
        Assert.Equal(HttpStatusCode.PartialContent, range.StatusCode);
        Assert.Equal($"bytes 100-199/{Size}", range.Content.Headers.ContentRange!.ToString());
        Assert.Equal(expected[100..200], await range.Content.ReadAsByteArrayAsync());

        using var suffix = await SendAsync(anon, HttpMethod.Get, url, r => r.Headers.Range = new RangeHeaderValue(null, 500));
        Assert.Equal(HttpStatusCode.PartialContent, suffix.StatusCode);
        Assert.Equal(expected[^500..], await suffix.Content.ReadAsByteArrayAsync());

        using var open = await SendAsync(anon, HttpMethod.Get, url, r => r.Headers.Range = new RangeHeaderValue(999_000, null));
        Assert.Equal(expected[999_000..], await open.Content.ReadAsByteArrayAsync());

        using var matching = await SendAsync(anon, HttpMethod.Get, url, r =>
        {
            r.Headers.Range = new RangeHeaderValue(10, 19);
            r.Headers.IfRange = new RangeConditionHeaderValue(etag);
        });
        Assert.Equal(HttpStatusCode.PartialContent, matching.StatusCode);
        Assert.Equal(expected[10..20], await matching.Content.ReadAsByteArrayAsync());
        using var stale = await SendAsync(anon, HttpMethod.Get, url, r =>
        {
            r.Headers.Range = new RangeHeaderValue(10, 19);
            r.Headers.IfRange = new RangeConditionHeaderValue("\"other\"");
        });
        Assert.Equal(HttpStatusCode.OK, stale.StatusCode);
        Assert.Equal(Size, stale.Content.Headers.ContentLength);
        Assert.Equal(expected, await stale.Content.ReadAsByteArrayAsync());

        using var beyond = await SendAsync(anon, HttpMethod.Get, url, r => r.Headers.Range = new RangeHeaderValue(Size, null));
        Assert.Equal(HttpStatusCode.RequestedRangeNotSatisfiable, beyond.StatusCode);
        Assert.Equal($"bytes */{Size}", beyond.Content.Headers.ContentRange!.ToString());
        Assert.Equal("range_not_satisfiable", Dl.Code(JsonDocument.Parse(await beyond.Content.ReadAsStringAsync()).RootElement));

        var deadline = DateTime.UtcNow.AddSeconds(5);
        JsonElement record;
        while ((record = await Dl.GetAsync(viewer, $"{Base}/{id}")).GetProperty("bytesServed").GetInt64() < Size * 2)
        {
            Assert.True(DateTime.UtcNow < deadline, record.ToString());
            await Task.Delay(20);
        }
        Assert.Equal(JsonValueKind.String, record.GetProperty("lastTransferAt").ValueKind);
    }

    [Fact]
    public async Task AResetMidTransfer_ResumesWithARange_ToTheSameBytes()
    {
        var (_, _, _, url, etag, releaseId) = await ReadyAsync("file-resume");
        using var anon = factory.CreateClient();
        factory.Files.ResetAfterBytes = 300_000;

        var received = new MemoryStream();
        using (var first = await SendAsync(anon, HttpMethod.Get, url))
        {
            Assert.Equal(HttpStatusCode.OK, first.StatusCode);
            await using var body = await first.Content.ReadAsStreamAsync();
            var buffer = new byte[16 * 1024];
            try
            {
                int read;
                while ((read = await body.ReadAsync(buffer)) > 0)
                    received.Write(buffer, 0, read);
            }
            catch (Exception e) when (e is IOException or HttpRequestException)
            {
            }
        }
        Assert.InRange(received.Length, 1, Size - 1);

        using var rest = await SendAsync(anon, HttpMethod.Get, url, r =>
        {
            r.Headers.Range = new RangeHeaderValue(received.Length, null);
            r.Headers.IfRange = new RangeConditionHeaderValue(etag);
        });
        Assert.Equal(HttpStatusCode.PartialContent, rest.StatusCode);
        received.Write(await rest.Content.ReadAsByteArrayAsync());

        Assert.Equal(SHA256.HashData(Expected(releaseId)), SHA256.HashData(received.ToArray()));
    }

    [Fact]
    public async Task TheViewerLimit_Answers429_WhileAnotherDownloadTransfers()
    {
        var (viewer, _, viewerId) = await Dl.ViewerAsync(factory, _admin, "file-limit", new { maxConcurrentDownloads = 1 });
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv })).GetProperty("candidates");
        var urls = new List<string>();
        foreach (var candidate in candidates.EnumerateArray().Where(c => c.GetProperty("offline").GetProperty("playable").GetBoolean()))
        {
            var id = (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId = candidate.GetProperty("version").GetProperty("releaseId").GetString(), device = Dl.AndroidTv }, 202))
                .GetProperty("downloadId").GetString()!;
            urls.Add((await Dl.WaitAsync(viewer, id)).GetProperty("fileUrl").GetString()!);
        }
        using var anon = factory.CreateClient();
        factory.Files.OpenGate = new TaskCompletionSource();
        var held = anon.GetAsync(urls[0], HttpCompletionOption.ResponseHeadersRead);
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (factory.Services.GetRequiredService<DownloadTransferGovernor>().ActiveFor(viewerId) == 0)
        {
            Assert.True(DateTime.UtcNow < deadline);
            await Task.Delay(10);
        }

        using var refused = await anon.GetAsync(urls[1]);
        Assert.Equal(HttpStatusCode.TooManyRequests, refused.StatusCode);
        Assert.Equal("10", refused.Headers.GetValues("Retry-After").Single());
        var body = JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement;
        Assert.Equal("too_many_downloads", Dl.Code(body));
        Assert.Equal("viewer", body.GetProperty("error").GetProperty("params").GetProperty("scope").GetString());
        var list = await Dl.GetAsync(viewer, Base);
        Assert.Equal(1, list.GetProperty("limits").GetProperty("activeDownloads").GetInt32());

        factory.Files.OpenGate.SetResult();
        using var first = await held;
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        await first.Content.ReadAsByteArrayAsync();
    }

    [Fact]
    public async Task AnExpiredCapability_IsGone_UntilRenewed()
    {
        var (_, viewerId, id, url, _, _) = await ReadyAsync("file-expiry");
        using var anon = factory.CreateClient();

        factory.Clock.Advance(TimeSpan.FromDays(31));
        using var gone = await anon.GetAsync(url);
        Assert.Equal(HttpStatusCode.Gone, gone.StatusCode);
        Assert.Equal("download_expired", Dl.Code(JsonDocument.Parse(await gone.Content.ReadAsStringAsync()).RootElement));

        using var later = await Dl.DeviceAsync(factory, _usernames[viewerId], "Pixel 9");
        await Dl.PostAsync(later, $"{Base}/{id}/renew", new { });
        using var again = await anon.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
        Assert.Equal(HttpStatusCode.OK, again.StatusCode);
    }

    [Fact]
    public async Task TurningDownloadsOff_StopsTheFileUrl()
    {
        var (_, viewerId, _, url, _, _) = await ReadyAsync("file-off");
        using var anon = factory.CreateClient();

        var patch = await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{viewerId}", new { permissions = new { allowDownloads = false } });
        Assert.True(patch.IsSuccessStatusCode, await patch.Content.ReadAsStringAsync());

        using var refused = await anon.GetAsync(url);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("downloads_not_allowed", Dl.Code(JsonDocument.Parse(await refused.Content.ReadAsStringAsync()).RootElement));
    }

    [Fact]
    public async Task SourceProblems_UseTheirCodes_AndUnknownCapabilitiesAre404()
    {
        var (_, _, _, url, _, _) = await ReadyAsync("file-source");
        using var anon = factory.CreateClient();

        factory.Files.Failure = new DownloadSourceException(503, "download_source_unavailable", "Usenet down", TimeSpan.FromSeconds(30));
        using var unavailable = await anon.GetAsync(url);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, unavailable.StatusCode);
        Assert.Equal("30", unavailable.Headers.GetValues("Retry-After").Single());
        factory.Files.Failure = new DownloadSourceException(409, "download_source_changed", "changed");
        using var changed = await anon.GetAsync(url);
        Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
        factory.Files.Failure = null;

        using var unknown = await anon.GetAsync($"/api/v1/offline/{new string('a', 64)}");
        Assert.Equal(HttpStatusCode.NotFound, unknown.StatusCode);
        Assert.Equal("unknown_download", Dl.Code(JsonDocument.Parse(await unknown.Content.ReadAsStringAsync()).RootElement));
        using var malformed = await anon.GetAsync("/api/v1/offline/short");
        Assert.Equal(HttpStatusCode.NotFound, malformed.StatusCode);
    }

    [Fact]
    public async Task ADisabledModule_HidesTheFile()
    {
        var (_, _, _, url, _, _) = await ReadyAsync("file-module");
        using var anon = factory.CreateClient();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = false });
        try
        {
            using var hidden = await anon.GetAsync(url);
            Assert.Equal(HttpStatusCode.NotFound, hidden.StatusCode);
            Assert.Equal("module_disabled", Dl.Code(JsonDocument.Parse(await hidden.Content.ReadAsStringAsync()).RootElement));
        }
        finally
        {
            await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        }
    }
}
