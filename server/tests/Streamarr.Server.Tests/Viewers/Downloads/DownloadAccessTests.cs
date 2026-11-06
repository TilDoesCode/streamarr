using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Fix round 1: a download's server access ends promptly and atomically when it is no longer allowed; idempotent prepares; preconditions.</summary>
public sealed class DownloadAccessTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>, IAsyncLifetime
{
    private const string Base = "/api/v1/viewer/downloads";
    private const string Movie = "tmdb-movie-501";
    private const long BigFile = 24_000_000;
    private static readonly TimeSpan EndsWithin = TimeSpan.FromSeconds(2);
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        factory.Files.ResetAfterBytes = null;
        factory.Files.OpenGate = null;
        factory.Files.Failure = null;
        factory.Files.ReadDelay = TimeSpan.Zero;
        FileService.BeforeAdmit = null;
    }

    public Task DisposeAsync()
    {
        FileService.BeforeAdmit = null;
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private ViewerDownloadFileService FileService => factory.Services.GetRequiredService<ViewerDownloadFileService>();

    private sealed record Ready(HttpClient Viewer, string Username, string ViewerId, string DownloadId, string Url, string ETag, string ReleaseId, long Size);

    /// <summary>A ready download of a file big enough (and read slowly enough) to still be transferring when the test acts.</summary>
    private async Task<Ready> ReadyAsync(string name, string fragment = "720p", string workId = Movie, long size = BigFile, string? deviceId = null)
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, name);
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId, device = Dl.AndroidTv })).GetProperty("candidates");
        var releaseId = candidates.EnumerateArray().First(c => c.GetProperty("version").GetProperty("name").GetString()!.Contains(fragment, StringComparison.Ordinal))
            .GetProperty("version").GetProperty("releaseId").GetString()!;
        factory.Media.Sources.TryRemove(releaseId, out _);
        factory.Media.Files[releaseId] = new StreamFileInfo($"{releaseId}.mkv", size, "mkv", "video/x-matroska");
        var id = (await Dl.PostAsync(viewer, Base, new { workId, releaseId, device = Dl.AndroidTv, deviceId }, 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);
        Assert.True(ready.GetProperty("state").GetString() == "ready", ready.ToString());
        return new Ready(viewer, username, viewerId, id, ready.GetProperty("fileUrl").GetString()!, ready.GetProperty("eTag").GetString()!, releaseId, size);
    }

    /// <summary>An open GET that reads on in the background; <see cref="Transfer.Ended"/> completes when the body ends or breaks off.</summary>
    private sealed class Transfer(HttpResponseMessage response, Task<long> reading) : IDisposable
    {
        public HttpResponseMessage Response { get; } = response;
        public Task<long> Ended { get; } = reading;

        public void Dispose() => Response.Dispose();
    }

    private async Task<Transfer> StartTransferAsync(string url)
    {
        factory.Files.ReadDelay = TimeSpan.FromMilliseconds(20);
        var anon = factory.CreateClient();
        var response = await anon.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStreamAsync();
        var first = new byte[64 * 1024];
        Assert.True(await body.ReadAsync(first) > 0);
        var reading = Task.Run(async () =>
        {
            long total = first.Length;
            var buffer = new byte[64 * 1024];
            try
            {
                int n;
                while ((n = await body.ReadAsync(buffer)) > 0)
                    total += n;
            }
            catch (Exception e) when (e is IOException or HttpRequestException or OperationCanceledException)
            {
            }
            return total;
        });
        return new Transfer(response, reading);
    }

    private static async Task AssertEndsPromptlyAsync(Transfer transfer, long size, Stopwatch since)
    {
        var finished = await Task.WhenAny(transfer.Ended, Task.Delay(EndsWithin + TimeSpan.FromSeconds(1)));
        Assert.True(finished == transfer.Ended, "the open transfer kept going");
        Assert.True(since.Elapsed <= EndsWithin + TimeSpan.FromMilliseconds(500), $"ended after {since.Elapsed.TotalMilliseconds:F0} ms");
        Assert.True(await transfer.Ended < size, "the whole file was sent after the access ended");
    }

    private async Task<(HttpStatusCode Status, string? Code)> HeadAsync(string url)
    {
        using var anon = factory.CreateClient();
        using var response = await anon.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
        if (response.IsSuccessStatusCode)
            return (response.StatusCode, null);
        using var get = await anon.GetAsync(url);
        var code = JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement.GetProperty("error").GetProperty("code").GetString();
        return (response.StatusCode, code);
    }

    private async Task PatchViewerAsync(string viewerId, object body)
    {
        using var response = await _admin.PatchAsJsonAsync($"/api/v1/config/viewers/{viewerId}", body);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    // ---- V1-02 ----

    [Fact]
    public async Task TurningDownloadsOff_EndsTheOpenTransfer_AndRefusesTheUrl()
    {
        var ready = await ReadyAsync("acc-off");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        await PatchViewerAsync(ready.ViewerId, new { permissions = new { allowDownloads = false } });

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Forbidden, "downloads_not_allowed"), await HeadAsync(ready.Url));
    }

    [Fact]
    public async Task DisablingTheAccount_EndsTheOpenTransfer_AndRefusesTheUrl()
    {
        var ready = await ReadyAsync("acc-disabled");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        await PatchViewerAsync(ready.ViewerId, new { disabled = true });

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal(HttpStatusCode.Forbidden, (await HeadAsync(ready.Url)).Status);
        Assert.Equal(0, factory.Services.GetRequiredService<DownloadTransferGovernor>().ActiveFor(ready.ViewerId));
    }

    // ---- V1-03 ----

    [Fact]
    public async Task ATightenedAgeLimit_AppliesToTheExistingFileUrl_AndItsOpenTransfer()
    {
        var ready = await ReadyAsync("acc-age");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        await PatchViewerAsync(ready.ViewerId, new { permissions = new { maxAge = 0, blockUnrated = true, allowDownloads = true } });

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Forbidden, "age_restricted"), await HeadAsync(ready.Url));
    }

    [Fact]
    public async Task AnUnrelatedPermissionChange_KeepsTheTransferRunning()
    {
        var ready = await ReadyAsync("acc-unrelated", size: 3_000_000);
        using var transfer = await StartTransferAsync(ready.Url);

        await PatchViewerAsync(ready.ViewerId, new { permissions = new { allowTranscoding = false, allowDownloads = true } });

        Assert.Equal(ready.Size, await transfer.Ended.WaitAsync(TimeSpan.FromSeconds(30)));
    }

    // ---- V1-04 ----

    [Fact]
    public async Task SigningOutAllSessions_RevokesTheFileUrl_AndRenewAfterSignInIssuesANewOne()
    {
        var ready = await ReadyAsync("acc-signout", size: 6_000_000, deviceId: "phone-1");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{ready.ViewerId}/sessions"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
        Assert.Equal(HttpStatusCode.Unauthorized, (await ready.Viewer.GetAsync(Base)).StatusCode);

        using var again = await Dl.DeviceAsync(factory, ready.Username, "Pixel 9");
        var record = await Dl.GetAsync(again, $"{Base}/{ready.DownloadId}?deviceId=phone-1");
        Assert.Equal("ready", record.GetProperty("state").GetString());
        Assert.True(record.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("fileUrl").ValueKind);

        var renewed = await Dl.PostAsync(again, $"{Base}/{ready.DownloadId}/renew?deviceId=phone-1", new { });
        var fresh = renewed.GetProperty("fileUrl").GetString()!;
        Assert.NotEqual(ready.Url, fresh);
        Assert.False(renewed.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(ready.ETag, renewed.GetProperty("eTag").GetString());

        factory.Files.ReadDelay = TimeSpan.Zero;
        using var anon = factory.CreateClient();
        using var resume = new HttpRequestMessage(HttpMethod.Get, fresh);
        resume.Headers.Range = new RangeHeaderValue(1_000_000, null);
        resume.Headers.TryAddWithoutValidation("If-Range", ready.ETag);
        using var resumed = await anon.SendAsync(resume);
        Assert.Equal(HttpStatusCode.PartialContent, resumed.StatusCode);
        Assert.Equal(ready.ETag, resumed.Headers.ETag!.ToString());
        var expected = FakeDownloadFileSource.Content(ready.ReleaseId, Movie, ready.Size);
        Assert.Equal(expected[1_000_000..], await resumed.Content.ReadAsByteArrayAsync());
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
    }

    [Fact]
    public async Task AnAdminPasswordReset_RevokesTheFileUrl()
    {
        var ready = await ReadyAsync("acc-password", size: 2_000_000);

        await Dl.PostAsync(_admin, $"/api/v1/config/viewers/{ready.ViewerId}/password", new { password = "a brand new secret", mustChangePassword = true });

        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
    }

    [Fact]
    public async Task SigningOutOneDevice_RevokesOnlyThatDevicesDownloads()
    {
        var phone = await ReadyAsync("acc-onedevice", size: 2_000_000);
        using var tablet = await Dl.DeviceAsync(factory, phone.Username, "iPad");
        var releaseId = phone.ReleaseId;
        var tabletId = (await Dl.PostAsync(tablet, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
        var tabletUrl = (await Dl.WaitAsync(tablet, tabletId)).GetProperty("fileUrl").GetString()!;
        var sessions = await Dl.GetAsync(phone.Viewer, "/api/v1/viewer/me/sessions");
        var tabletSession = sessions.EnumerateArray().Single(s => s.GetProperty("deviceName").GetString() == "iPad").GetProperty("id").GetString();

        using (var revoke = await phone.Viewer.DeleteAsync($"/api/v1/viewer/me/sessions/{tabletSession}"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);

        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(tabletUrl));
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(phone.Url)).Status);
    }

    [Fact]
    public async Task AnOrdinaryLogout_KeepsTheFileUrl()
    {
        var ready = await ReadyAsync("acc-logout", size: 2_000_000);

        using (var logout = await ready.Viewer.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { }))
            Assert.True(logout.IsSuccessStatusCode, await logout.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(ready.Url)).Status);
    }

    // ---- V1-12 ----

    [Fact]
    public async Task AnExpiringCapability_EndsTheOpenTransfer_AndRenewRestoresTheSameUrl()
    {
        var ready = await ReadyAsync("acc-expiry");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
        {
            var record = await db.ViewerDownloads.SingleAsync(d => d.Id == ready.DownloadId);
            record.ExpiresAt = factory.Clock.GetUtcNow().AddSeconds(-1);
            await db.SaveChangesAsync();
        }

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_expired"), await HeadAsync(ready.Url));
        var renewed = await Dl.PostAsync(ready.Viewer, $"{Base}/{ready.DownloadId}/renew", new { });
        Assert.Equal(ready.Url, renewed.GetProperty("fileUrl").GetString());
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(ready.Url)).Status);
    }

    [Fact]
    public async Task TheExpirySweep_EndsTransfersWhoseDeadlinePassed()
    {
        var ready = await ReadyAsync("acc-deadline");
        using var transfer = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        factory.Clock.Advance(TimeSpan.FromDays(31));
        try
        {
            await AssertEndsPromptlyAsync(transfer, ready.Size, since);
            Assert.Equal((HttpStatusCode.Gone, "download_expired"), await HeadAsync(ready.Url));
        }
        finally
        {
            factory.Clock.Advance(TimeSpan.FromDays(-31));
        }
    }

    // ---- V1-14 ----

    [Fact]
    public async Task ADeleteBetweenAuthorizationAndAdmission_IsNeverServed()
    {
        var ready = await ReadyAsync("acc-race-delete", size: 2_000_000);
        var downloads = factory.Services.GetRequiredService<ViewerDownloadService>();
        var opens = factory.Files.Opens.Count;
        FileService.BeforeAdmit = async id =>
        {
            FileService.BeforeAdmit = null;
            await downloads.AdminDeleteAsync(id, CancellationToken.None);
        };

        using var anon = factory.CreateClient();
        using var response = await anon.GetAsync(ready.Url);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("unknown_download", Dl.Code(JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement));
        Assert.Equal(opens, factory.Files.Opens.Count);
        Assert.Equal(0, factory.Services.GetRequiredService<DownloadTransferGovernor>().ActiveTransfers);
    }

    [Fact]
    public async Task ARevocationBetweenAuthorizationAndAdmission_AnswersTheRevocation()
    {
        var ready = await ReadyAsync("acc-race-revoke", size: 2_000_000);
        var downloads = factory.Services.GetRequiredService<ViewerDownloadService>();
        FileService.BeforeAdmit = async _ =>
        {
            FileService.BeforeAdmit = null;
            await downloads.SessionsRevokedAsync(new ViewerSessionRevocation(ready.ViewerId, "revoked_by_admin"), CancellationToken.None);
        };

        using var anon = factory.CreateClient();
        using var response = await anon.GetAsync(ready.Url);

        Assert.Equal(HttpStatusCode.Gone, response.StatusCode);
        Assert.Equal("download_revoked", Dl.Code(JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement));
    }

    [Fact]
    public async Task ACompleteWhileTheSourceOpens_IsAnsweredAsGone_NotServed()
    {
        var ready = await ReadyAsync("acc-race-complete", size: 2_000_000);
        factory.Files.OpenGate = new TaskCompletionSource();
        using var anon = factory.CreateClient();
        var pending = anon.GetAsync(ready.Url);
        var governor = factory.Services.GetRequiredService<DownloadTransferGovernor>();
        while (!governor.IsTransferring(ready.DownloadId))
            await Task.Delay(10);

        await Dl.PostAsync(ready.Viewer, $"{Base}/{ready.DownloadId}/complete", new { bytesReceived = ready.Size });
        using var response = await pending.WaitAsync(TimeSpan.FromSeconds(5));
        factory.Files.OpenGate = null;

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("unknown_download", Dl.Code(JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement));
    }

    // ---- V1-05 ----

    private async Task<SqliteConnection> HoldWriterLockAsync()
    {
        await using var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync();
        var connection = new SqliteConnection(db.Database.GetConnectionString());
        await connection.OpenAsync();
        await using var begin = connection.CreateCommand();
        begin.CommandText = "BEGIN IMMEDIATE";
        await begin.ExecuteNonQueryAsync();
        return connection;
    }

    private static async Task ReleaseWriterLockAsync(SqliteConnection connection)
    {
        await using (var rollback = connection.CreateCommand())
        {
            rollback.CommandText = "ROLLBACK";
            await rollback.ExecuteNonQueryAsync();
        }
        await connection.DisposeAsync();
    }

    [Fact]
    public async Task ConcurrentRetriesOfOnePrepare_CreateOneDownload()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "acc-idem");
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv })).GetProperty("candidates");
        var releaseId = candidates[0].GetProperty("version").GetProperty("releaseId").GetString();
        var body = new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "Concurrent-Device", clientRef = "same-client-ref" };

        var held = await HoldWriterLockAsync();
        var posts = Enumerable.Range(0, 10).Select(_ => viewer.PostAsJsonAsync(Base, body)).ToList();
        await Task.Delay(1500);
        await ReleaseWriterLockAsync(held);
        var answers = await Task.WhenAll(posts);

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.Accepted, a.StatusCode));
        var ids = await Task.WhenAll(answers.Select(async a => JsonDocument.Parse(await a.Content.ReadAsStringAsync()).RootElement.GetProperty("downloadId").GetString()));
        Assert.Single(ids.Distinct());
        var sameDeviceOtherCase = await Dl.PostAsync(viewer, Base, body with { deviceId = " concurrent-device " }, 202);
        Assert.Equal(ids[0], sameDeviceOtherCase.GetProperty("downloadId").GetString());
    }

    [Fact]
    public async Task TheStoredQuota_HoldsUnderConcurrentPrepares()
    {
        var (viewer, _, viewerId) = await Dl.ViewerAsync(factory, _admin, "acc-quota");
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv })).GetProperty("candidates");
        var releaseId = candidates[0].GetProperty("version").GetProperty("releaseId").GetString()!;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
        {
            var now = factory.Clock.GetUtcNow();
            db.ViewerDownloads.AddRange(Enumerable.Range(0, ViewerDownloadService.MaxStoredPerViewer - 1).Select(i => new Streamarr.Server.Persistence.Entities.ViewerDownloadEntity
            {
                Id = $"quota-{viewerId[..8]}-{i}",
                ViewerId = viewerId,
                SessionId = "seed",
                WorkId = Movie,
                RequestedReleaseId = releaseId,
                State = "failed",
                CreatedAt = now,
                UpdatedAt = now,
            }));
            await db.SaveChangesAsync();
        }

        var held = await HoldWriterLockAsync();
        var posts = Enumerable.Range(0, 5).Select(i => viewer.PostAsJsonAsync(Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, clientRef = $"ref-{i}" })).ToList();
        await Task.Delay(1000);
        await ReleaseWriterLockAsync(held);
        var statuses = (await Task.WhenAll(posts)).Select(a => a.StatusCode).ToList();

        Assert.Equal(1, statuses.Count(s => s == HttpStatusCode.Accepted));
        Assert.Equal(4, statuses.Count(s => s == HttpStatusCode.Conflict));
    }

    // ---- V1-10 ----

    [Theory]
    [InlineData("GET", "If-None-Match", "{etag}", 304)]
    [InlineData("HEAD", "If-None-Match", "{etag}", 304)]
    [InlineData("GET", "If-None-Match", "*", 304)]
    [InlineData("GET", "If-None-Match", "\"other\", {etag}", 304)]
    [InlineData("GET", "If-None-Match", "W/{etag}", 304)]
    [InlineData("GET", "If-None-Match", "\"other\"", 200)]
    [InlineData("GET", "If-Match", "\"wrong\"", 412)]
    [InlineData("HEAD", "If-Match", "\"wrong\", \"other\"", 412)]
    [InlineData("GET", "If-Match", "W/{etag}", 412)]
    [InlineData("GET", "If-Match", "*", 200)]
    [InlineData("GET", "If-Match", "\"other\", {etag}", 200)]
    public async Task Preconditions_AreEvaluatedBeforeAnyTransfer(string method, string header, string value, int expected)
    {
        var ready = await ReadyAsync($"acc-cond-{expected}", size: 500_000);
        var opens = factory.Files.Opens.Count;
        using var anon = factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), ready.Url);
        request.Headers.TryAddWithoutValidation(header, value.Replace("{etag}", ready.ETag, StringComparison.Ordinal));

        using var response = await anon.SendAsync(request);
        var body = await response.Content.ReadAsByteArrayAsync();

        Assert.Equal(expected, (int)response.StatusCode);
        if (expected == 304)
        {
            Assert.Empty(body);
            Assert.Equal(ready.ETag, response.Headers.ETag!.ToString());
        }
        if (expected == 412 && method == "GET")
            Assert.Equal("precondition_failed", Dl.Code(JsonDocument.Parse(body).RootElement));
        if (expected != 200 || method == "HEAD")
            Assert.Equal(opens, factory.Files.Opens.Count);
    }
}
