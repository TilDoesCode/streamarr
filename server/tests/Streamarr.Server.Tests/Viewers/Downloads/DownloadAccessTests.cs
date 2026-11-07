using System.Data.Common;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Diagnostics;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Auth;
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
        factory.Resolver.Script = null;
        factory.Media.ProbeGate = null;
        FileService.BeforeAdmit = null;
        Downloads.BeforeLifecycleCommit = null;
    }

    public Task DisposeAsync()
    {
        FileService.BeforeAdmit = null;
        Downloads.BeforeLifecycleCommit = null;
        factory.Media.ProbeGate = null;
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private ViewerDownloadFileService FileService => factory.Services.GetRequiredService<ViewerDownloadFileService>();

    private ViewerDownloadService Downloads => factory.Services.GetRequiredService<ViewerDownloadService>();

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

    private async Task<Transfer> StartTransferAsync(string url, int readDelayMs = 20)
    {
        factory.Files.ReadDelay = TimeSpan.FromMilliseconds(readDelayMs);
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

    [Fact]
    public async Task TurningDownloadsOff_CancelsAPreparationInFlight()
    {
        var (viewer, _, viewerId) = await Dl.ViewerAsync(factory, _admin, "acc-prepare-off");
        var releaseId = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
        var resolving = new TaskCompletionSource();
        factory.Resolver.Script = async (_, _, ct) =>
        {
            resolving.TrySetResult();
            await Task.Delay(Timeout.Infinite, ct);
            throw new InvalidOperationException("unreachable");
        };
        var id = (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
        await resolving.Task.WaitAsync(TimeSpan.FromSeconds(10));

        await PatchViewerAsync(viewerId, new { permissions = new { allowDownloads = false } });
        var record = await Dl.WaitAsync(viewer, id);

        Assert.Equal("failed", record.GetProperty("state").GetString());
        Assert.Equal("downloads_not_allowed", record.GetProperty("error").GetProperty("code").GetString());
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
        var sessions = factory.Services.GetRequiredService<Streamarr.Server.Viewers.Auth.ViewerSessionService>();
        FileService.BeforeAdmit = async _ =>
        {
            FileService.BeforeAdmit = null;
            await sessions.RevokeAllAsync(ready.ViewerId, "revoked_by_admin", exceptSessionId: null, CancellationToken.None);
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

    // ---- fix round 2 ----

    /// <summary>Starts a preparation whose probe waits for the gate; returns once it is probing.</summary>
    private async Task<(HttpClient Viewer, string Username, string ViewerId, string DownloadId, TaskCompletionSource Gate)> ProbingAsync(string name, string deviceId)
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, name);
        var releaseId = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        factory.Media.ProbeGate = gate;
        var id = (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId }, 202)).GetProperty("downloadId").GetString()!;
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while ((await Dl.GetAsync(viewer, $"{Base}/{id}")).GetProperty("state").GetString() != "probing")
        {
            Assert.True(DateTime.UtcNow < deadline, "the preparation never reached probing");
            await Task.Delay(10);
        }
        return (viewer, username, viewerId, id, gate);
    }

    private async Task<JsonElement> ReadyRecordAsync(HttpClient viewer, string downloadId, string deviceId)
    {
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (true)
        {
            var record = await Dl.GetAsync(viewer, $"{Base}/{downloadId}?deviceId={deviceId}&waitMs=500");
            if (record.GetProperty("state").GetString() is "ready" or "failed")
                return record;
            Assert.True(DateTime.UtcNow < deadline, $"still {record.GetProperty("state")}");
        }
    }

    // V2-01

    [Fact]
    public async Task ASecuritySignOutDuringPreparation_PublishesARevokedUrl_AndThePendingPollGets401()
    {
        var (viewer, username, viewerId, id, gate) = await ProbingAsync("acc2-prep-signout", "phone");
        var pending = viewer.GetAsync($"{Base}/{id}?waitMs=10000&deviceId=phone");
        await Task.Delay(150);

        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{viewerId}/sessions"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);
        gate.SetResult();
        using var answer = await pending.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(HttpStatusCode.Unauthorized, answer.StatusCode);
        Assert.DoesNotContain("/api/v1/offline/", await answer.Content.ReadAsStringAsync(), StringComparison.Ordinal);
        using var again = await Dl.DeviceAsync(factory, username, "Pixel 9");
        var record = await ReadyRecordAsync(again, id, "phone");
        Assert.Equal("ready", record.GetProperty("state").GetString());
        Assert.True(record.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("fileUrl").ValueKind);
        var renewed = await Dl.PostAsync(again, $"{Base}/{id}/renew?deviceId=phone", new { });
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(renewed.GetProperty("fileUrl").GetString()!)).Status);
    }

    [Fact]
    public async Task AnOrdinaryLogoutDuringPreparation_KeepsTheFileUrl()
    {
        var (viewer, username, _, id, gate) = await ProbingAsync("acc2-prep-logout", "phone");

        using (var logout = await viewer.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { }))
            Assert.True(logout.IsSuccessStatusCode);
        gate.SetResult();
        using var again = await Dl.DeviceAsync(factory, username, "Pixel 9");
        var record = await ReadyRecordAsync(again, id, "phone");

        Assert.False(record.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(record.GetProperty("fileUrl").GetString()!)).Status);
    }

    [Fact]
    public async Task SigningOutAnotherDeviceDuringPreparation_KeepsThisDevicesUrl()
    {
        var (viewer, username, _, id, gate) = await ProbingAsync("acc2-prep-other", "phone");
        using var tablet = await Dl.DeviceAsync(factory, username, "iPad");
        var tabletSession = (await Dl.GetAsync(viewer, "/api/v1/viewer/me/sessions")).EnumerateArray()
            .Single(s => s.GetProperty("deviceName").GetString() == "iPad").GetProperty("id").GetString();
        var pending = viewer.GetAsync($"{Base}/{id}?waitMs=10000&deviceId=phone");

        using (var revoke = await viewer.DeleteAsync($"/api/v1/viewer/me/sessions/{tabletSession}"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);
        gate.SetResult();
        using var answer = await pending.WaitAsync(TimeSpan.FromSeconds(10));
        var record = JsonDocument.Parse(await answer.Content.ReadAsStringAsync()).RootElement;

        Assert.Equal(HttpStatusCode.OK, answer.StatusCode);
        record = record.GetProperty("state").GetString() == "ready" ? record : await ReadyRecordAsync(viewer, id, "phone");
        Assert.False(record.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(record.GetProperty("fileUrl").GetString()!)).Status);
    }

    [Fact]
    public async Task ASecuritySignOutAfterALogout_StillRevokesThePreparation()
    {
        // The session already ended normally, so only the viewer's security generation shows the sign-out.
        var (viewer, username, viewerId, id, gate) = await ProbingAsync("acc2-prep-generation", "phone");
        using (var logout = await viewer.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { }))
            Assert.True(logout.IsSuccessStatusCode);

        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{viewerId}/sessions"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);
        gate.SetResult();
        using var again = await Dl.DeviceAsync(factory, username, "Pixel 9");
        var record = await ReadyRecordAsync(again, id, "phone");

        Assert.True(record.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(JsonValueKind.Null, record.GetProperty("fileUrl").ValueKind);
    }

    // V2-02

    private async Task<(HttpClient Again, Ready Ready)> RevokedReadyAsync(string name)
    {
        var ready = await ReadyAsync(name, size: 2_000_000, deviceId: "verify-device");
        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{ready.ViewerId}/sessions"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);
        return (await Dl.DeviceAsync(factory, ready.Username, "Pixel 9"), ready);
    }

    [Fact]
    public async Task ConcurrentRenewals_OfARevokedDownload_ShareOneUsableUrl_UnderWriterContention()
    {
        var (again, ready) = await RevokedReadyAsync("acc2-renew-many");

        var held = await HoldWriterLockAsync();
        var renewals = Enumerable.Range(0, 10)
            .Select(_ => again.PostAsJsonAsync($"{Base}/{ready.DownloadId}/renew?deviceId=verify-device", new { }))
            .ToList();
        await Task.Delay(1000);
        await ReleaseWriterLockAsync(held);
        var answers = await Task.WhenAll(renewals);

        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        var urls = (await Task.WhenAll(answers.Select(async a => JsonDocument.Parse(await a.Content.ReadAsStringAsync()).RootElement.GetProperty("fileUrl").GetString())))
            .Distinct().ToList();
        var url = Assert.Single(urls);
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(url!)).Status);
    }

    [Fact]
    public async Task RenewalsRacingASecuritySignOut_NeverLeaveAUsableUrl()
    {
        var (again, ready) = await RevokedReadyAsync("acc2-renew-race");
        var usable = 0;
        for (var trial = 0; trial < 20; trial++)
        {
            using var start = new SemaphoreSlim(0, 2);
            var renew = Task.Run(async () =>
            {
                await start.WaitAsync();
                return await again.PostAsJsonAsync($"{Base}/{ready.DownloadId}/renew?deviceId=verify-device", new { });
            });
            var signOut = Task.Run(async () =>
            {
                await start.WaitAsync();
                return await _admin.DeleteAsync($"/api/v1/config/viewers/{ready.ViewerId}/sessions");
            });
            start.Release(2);
            using var renewed = await renew;
            using var signedOut = await signOut;
            Assert.Equal(HttpStatusCode.NoContent, signedOut.StatusCode);
            if (renewed.IsSuccessStatusCode
                && JsonDocument.Parse(await renewed.Content.ReadAsStringAsync()).RootElement.GetProperty("fileUrl").GetString() is { } url
                && (await HeadAsync(url)).Status == HttpStatusCode.OK)
                usable++;
            again.Dispose();
            again = await Dl.DeviceAsync(factory, ready.Username, "Pixel 9");
        }

        Assert.Equal(0, usable);
        again.Dispose();
    }

    [Fact]
    public async Task ASignOutCommittingDuringARenewal_RevokesTheRenewedUrl()
    {
        var (again, ready) = await RevokedReadyAsync("acc2-renew-seam");
        Task<HttpResponseMessage>? signOut = null;
        Downloads.BeforeLifecycleCommit = async (operation, id) =>
        {
            if (operation != "renew" || id != ready.DownloadId || signOut is not null)
                return;
            // The sign-out's write waits for this transaction; its rotation then sees the renewed URL.
            signOut = _admin.DeleteAsync($"/api/v1/config/viewers/{ready.ViewerId}/sessions");
            await Task.Delay(200);
        };

        using var renewed = await again.PostAsJsonAsync($"{Base}/{ready.DownloadId}/renew?deviceId=verify-device", new { });
        Downloads.BeforeLifecycleCommit = null;
        using var signedOut = await signOut!;

        Assert.Equal(HttpStatusCode.NoContent, signedOut.StatusCode);
        if (renewed.IsSuccessStatusCode)
        {
            var url = JsonDocument.Parse(await renewed.Content.ReadAsStringAsync()).RootElement.GetProperty("fileUrl").GetString()!;
            Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(url));
        }
        else
        {
            Assert.Equal(HttpStatusCode.Unauthorized, renewed.StatusCode);
        }
        Assert.Equal(HttpStatusCode.Unauthorized, (await again.GetAsync(Base)).StatusCode);
        again.Dispose();
    }

    // V2-03

    [Fact]
    public async Task DistinctDeviceAndClientReferences_NeverShareADownload()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "acc2-tuples");
        var releaseId = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();

        var first = await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "alpha|beta", clientRef = "gamma" }, 202);
        var second = await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "alpha", clientRef = "beta|gamma" }, 202);
        var retry = await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "ALPHA|Beta", clientRef = "gamma" }, 202);

        Assert.NotEqual(first.GetProperty("downloadId").GetString(), second.GetProperty("downloadId").GetString());
        Assert.Equal(first.GetProperty("downloadId").GetString(), retry.GetProperty("downloadId").GetString());
    }

    // V2-05

    [Fact]
    public async Task AnExpiringTransfer_EndsWithinTwoSeconds_WhileTheDatabaseWriterIsBusy()
    {
        var ready = await ReadyAsync("acc2-expiry-busy");
        using var transfer = await StartTransferAsync(ready.Url);
        var governor = factory.Services.GetRequiredService<DownloadTransferGovernor>();

        var held = await HoldWriterLockAsync();
        try
        {
            // An accounting round falls due while the writer is held, then the file URL expires.
            factory.Clock.Advance(TimeSpan.FromSeconds(3));
            await Task.Delay(400);
            var since = Stopwatch.StartNew();
            factory.Clock.Advance(TimeSpan.FromDays(31));
            try
            {
                await AssertEndsPromptlyAsync(transfer, ready.Size, since);
                var released = Stopwatch.StartNew();
                while (governor.ActiveFor(ready.ViewerId) > 0 && released.Elapsed < TimeSpan.FromSeconds(1))
                    await Task.Delay(20);
                Assert.Equal(0, governor.ActiveFor(ready.ViewerId));
            }
            finally
            {
                factory.Clock.Advance(TimeSpan.FromDays(-31));
            }
        }
        finally
        {
            await ReleaseWriterLockAsync(held);
        }

        // The bytes are recorded once the database is free again.
        var deadline = DateTime.UtcNow.AddSeconds(10);
        long served;
        do
        {
            await Task.Delay(200);
            served = (await Dl.GetAsync(_admin, $"/api/v1/config/viewers/downloads?viewerId={ready.ViewerId}")).GetProperty("items")[0].GetProperty("bytesServed").GetInt64();
        }
        while (served == 0 && DateTime.UtcNow < deadline);
        Assert.True(served > 0);
    }

    // ---- fix round 3 ----

    private sealed class OptionsFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);

        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken ct = default) => Task.FromResult(new StreamarrDbContext(options));
    }

    /// <summary>Runs right after a transaction committed: where a cancelled request or a stopping process leaves a sign-out.</summary>
    private sealed class AfterCommit(Action action) : DbTransactionInterceptor
    {
        public bool Fired { get; private set; }

        public override Task TransactionCommittedAsync(DbTransaction transaction, TransactionEndEventData eventData, CancellationToken cancellationToken = default)
        {
            Fired = true;
            action();
            return Task.CompletedTask;
        }
    }

    private static AfterCommit Stops() => new(() => throw new InvalidOperationException("the process stopped right after the commit"));

    /// <summary>The production session service on the host's database, with <paramref name="interceptor"/> in its transactions.</summary>
    private static ViewerSessionService SessionsWith(IServiceProvider services, IInterceptor interceptor)
    {
        var options = services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
        IDbContextFactory<StreamarrDbContext> intercepted = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(options).AddInterceptors(interceptor).Options);
        return ActivatorUtilities.CreateInstance<ViewerSessionService>(services, intercepted);
    }

    // V3-01

    [Fact]
    public async Task ASignOutCancelledRightAfterItsCommit_StillRetiresTheFileUrl_AndEndsTheTransfer()
    {
        var ready = await ReadyAsync("acc-cancel-commit", size: 12_000_000);
        using var transfer = await StartTransferAsync(ready.Url);
        using var request = new CancellationTokenSource();
        var commit = new AfterCommit(request.Cancel);
        var since = Stopwatch.StartNew();
        Exception? thrown = null;

        try
        {
            await SessionsWith(factory.Services, commit).RevokeAllAsync(ready.ViewerId, "revoked_by_admin", exceptSessionId: null, request.Token);
        }
        catch (OperationCanceledException e)
        {
            thrown = e;
        }

        Assert.True(commit.Fired);
        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
        using var again = await Dl.DeviceAsync(factory, ready.Username, "Pixel 9");
        Assert.True((await Dl.GetAsync(again, $"{Base}/{ready.DownloadId}")).GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Null(thrown);
    }

    [Fact]
    public async Task ASignOutWhoseFollowUpNeverRuns_StillRetiresTheUrl_AndTheSweepEndsTheTransfer()
    {
        var ready = await ReadyAsync("acc-crash-commit", size: 12_000_000);
        using var transfer = await StartTransferAsync(ready.Url);
        var since = Stopwatch.StartNew();

        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            SessionsWith(factory.Services, Stops()).RevokeAllAsync(ready.ViewerId, "revoked_by_admin", exceptSessionId: null, CancellationToken.None));

        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
    }

    [Fact]
    public async Task ATransferOfARetiredUrl_Ends_AlsoWhenTheDownloadWasRenewedMeanwhile()
    {
        var ready = await ReadyAsync("acc-crash-renew", size: 12_000_000, deviceId: "renew-phone");
        using var transfer = await StartTransferAsync(ready.Url);
        var since = Stopwatch.StartNew();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            SessionsWith(factory.Services, Stops()).RevokeAllAsync(ready.ViewerId, "revoked_by_admin", exceptSessionId: null, CancellationToken.None));

        using var again = await Dl.DeviceAsync(factory, ready.Username, "Pixel 9");
        var fresh = (await Dl.PostAsync(again, $"{Base}/{ready.DownloadId}/renew?deviceId=renew-phone", new { })).GetProperty("fileUrl").GetString()!;

        Assert.NotEqual(ready.Url, fresh);
        await AssertEndsPromptlyAsync(transfer, ready.Size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(fresh)).Status);
    }

    [Fact]
    public async Task AfterAStopRightAfterTheSignOutCommits_TheOldUrlIsRevokedOnTheNextStart()
    {
        var directory = Directory.CreateTempSubdirectory("streamarr-downloads-restart-").FullName;
        try
        {
            string url;
            using (var before = new ViewerDownloadFactory(directory, ownsDirectory: false))
            {
                using var admin = await before.AdminAsync();
                await ViewerApi.ConfigureAsync(admin, new { enabled = true });
                var (viewer, _, viewerId) = await Dl.ViewerAsync(before, admin, "acc-restart");
                var releaseId = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
                    .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
                var id = (await Dl.PostAsync(viewer, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
                url = (await Dl.WaitAsync(viewer, id)).GetProperty("fileUrl").GetString()!;
                await Assert.ThrowsAsync<InvalidOperationException>(() =>
                    SessionsWith(before.Services, Stops()).RevokeAllAsync(viewerId, "revoked_by_admin", exceptSessionId: null, CancellationToken.None));
            }

            using var after = new ViewerDownloadFactory(directory, ownsDirectory: false);
            using var anon = after.CreateClient();
            using var head = await anon.SendAsync(new HttpRequestMessage(HttpMethod.Head, url));
            using var get = await anon.GetAsync(url);

            Assert.Equal(HttpStatusCode.Gone, head.StatusCode);
            Assert.Equal("download_revoked", Dl.Code(JsonDocument.Parse(await get.Content.ReadAsStringAsync()).RootElement));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task ACancelledSignOutOfOneDevice_RetiresOnlyThatDevicesUrl()
    {
        var phone = await ReadyAsync("acc-cancel-one", size: 500_000);
        using var tablet = await Dl.DeviceAsync(factory, phone.Username, "Tablet");
        var tabletId = (await Dl.PostAsync(tablet, Base, new { workId = Movie, releaseId = phone.ReleaseId, device = Dl.AndroidTv }, 202)).GetProperty("downloadId").GetString()!;
        var tabletUrl = (await Dl.WaitAsync(tablet, tabletId)).GetProperty("fileUrl").GetString()!;
        string phoneSession;
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            phoneSession = await db.ViewerSessions.Where(s => s.ViewerId == phone.ViewerId && s.DeviceName == "Pixel 9").Select(s => s.Id).SingleAsync();
        using var request = new CancellationTokenSource();

        try
        {
            await SessionsWith(factory.Services, new AfterCommit(request.Cancel)).RevokeAsync(phone.ViewerId, phoneSession, "revoked_by_admin", request.Token);
        }
        catch (OperationCanceledException)
        {
        }

        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(phone.Url));
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(tabletUrl)).Status);
    }

    [Fact]
    public async Task ASignOutCancelledRightAfterItsCommit_DuringPreparation_StillPublishesARevokedUrl()
    {
        var (_, username, viewerId, downloadId, gate) = await ProbingAsync("acc-cancel-prep", "prep-phone");
        using var request = new CancellationTokenSource();

        try
        {
            await SessionsWith(factory.Services, new AfterCommit(request.Cancel)).RevokeAllAsync(viewerId, "revoked_by_admin", exceptSessionId: null, request.Token);
        }
        catch (OperationCanceledException)
        {
        }
        gate.SetResult();
        using var again = await Dl.DeviceAsync(factory, username, "Pixel 9");
        var done = await Dl.WaitAsync(again, downloadId);

        Assert.Equal("ready", done.GetProperty("state").GetString());
        Assert.True(done.GetProperty("fileUrlRevoked").GetBoolean());
        Assert.Equal(JsonValueKind.Null, done.GetProperty("fileUrl").ValueKind);
    }

    // V3-03

    [Fact]
    public async Task ACaseOnlyDifferentDeviceId_FromAnotherSession_IsTheSameDevice_AndGetsItsUrl()
    {
        var (phone, username, _) = await Dl.ViewerAsync(factory, _admin, "acc-device-case");
        var releaseId = (await Dl.PostAsync(phone, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
        var id = (await Dl.PostAsync(phone, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "Phone", clientRef = "same" }, 202))
            .GetProperty("downloadId").GetString()!;
        await Dl.WaitAsync(phone, id);
        using var second = await Dl.DeviceAsync(factory, username, "Second session");

        var retry = await Dl.PostAsync(second, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = " PHONE ", clientRef = "same" }, 202);
        var record = await Dl.GetAsync(second, $"{Base}/{id}?deviceId=%20PHONE%20");
        var listed = (await Dl.GetAsync(second, $"{Base}?device=this&deviceId=pHoNe")).GetProperty("items").EnumerateArray()
            .Single(i => i.GetProperty("downloadId").GetString() == id);

        Assert.Equal(id, retry.GetProperty("downloadId").GetString());
        Assert.True(retry.GetProperty("thisDevice").GetBoolean());
        Assert.Equal(JsonValueKind.String, retry.GetProperty("fileUrl").ValueKind);
        Assert.True(record.GetProperty("thisDevice").GetBoolean());
        Assert.Equal(JsonValueKind.String, record.GetProperty("fileUrl").ValueKind);
        Assert.Equal(JsonValueKind.String, listed.GetProperty("fileUrl").ValueKind);
    }

    [Fact]
    public async Task NonAsciiLettersOfADeviceId_StayCaseSensitive()
    {
        var (phone, username, _) = await Dl.ViewerAsync(factory, _admin, "acc-device-umlaut");
        var releaseId = (await Dl.PostAsync(phone, $"{Base}/candidates", new { workId = Movie, device = Dl.AndroidTv }))
            .GetProperty("candidates")[0].GetProperty("version").GetProperty("releaseId").GetString();
        var id = (await Dl.PostAsync(phone, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "Äpfel", clientRef = "x" }, 202))
            .GetProperty("downloadId").GetString()!;
        await Dl.WaitAsync(phone, id);
        using var second = await Dl.DeviceAsync(factory, username, "Second session");

        var other = await Dl.PostAsync(second, Base, new { workId = Movie, releaseId, device = Dl.AndroidTv, deviceId = "äpfel", clientRef = "x" }, 202);
        var foreign = await Dl.GetAsync(second, $"{Base}/{id}?deviceId={Uri.EscapeDataString("äpfel")}");
        var own = await Dl.GetAsync(second, $"{Base}/{id}?deviceId={Uri.EscapeDataString("ÄPFEL")}");

        Assert.NotEqual(id, other.GetProperty("downloadId").GetString());
        Assert.False(foreign.GetProperty("thisDevice").GetBoolean());
        Assert.Equal(JsonValueKind.Null, foreign.GetProperty("fileUrl").ValueKind);
        Assert.True(own.GetProperty("thisDevice").GetBoolean());
    }

    // ---- fix round 4 (V4-01): a revocation ends the retired capability's requests, never a renewed URL's ----

    /// <summary>Holds the first read of the viewers table (the sweep's second query, after it read the download rows) until released.</summary>
    private sealed class HoldViewersQuery : DbCommandInterceptor
    {
        private int _held;

        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async ValueTask<DbDataReader> ReaderExecutedAsync(
            DbCommand command, CommandExecutedEventData eventData, DbDataReader result, CancellationToken cancellationToken = default)
        {
            if (command.CommandText.Contains("FROM \"Viewers\"", StringComparison.Ordinal) && Interlocked.Exchange(ref _held, 1) == 0)
            {
                Entered.TrySetResult();
                await Release.Task.WaitAsync(cancellationToken);
            }
            return result;
        }
    }

    /// <summary>Holds the post-commit notification of a sign-out until released (it runs before the download service's follow-up).</summary>
    private sealed class HoldNotification : IViewerAccessListener
    {
        public TaskCompletionSource Entered { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task AccessChangedAsync(string viewerId, CancellationToken ct) => Task.CompletedTask;

        public async Task SessionsRevokedAsync(ViewerSessionRevocation revocation, CancellationToken ct)
        {
            Entered.TrySetResult();
            await Release.Task.WaitAsync(ct);
        }
    }

    private async Task<string> RenewAfterSignInAsync(Ready ready, string deviceId)
    {
        using var again = await Dl.DeviceAsync(factory, ready.Username, "Pixel 9");
        var renewed = await Dl.PostAsync(again, $"{Base}/{ready.DownloadId}/renew?deviceId={deviceId}", new { });
        var url = renewed.GetProperty("fileUrl").GetString()!;
        Assert.NotEqual(ready.Url, url);
        return url;
    }

    [Fact]
    public async Task ASweepWithAStaleSnapshot_NeverEndsATransferOfTheRenewedUrl()
    {
        const long size = 1_000_000;
        var ready = await ReadyAsync("acc-v4-sweep", size: size, deviceId: "phone-v4a");
        using var old = await StartTransferAsync(ready.Url, readDelayMs: 100);
        var held = new HoldViewersQuery();
        var options = factory.Services.GetRequiredService<DbContextOptions<StreamarrDbContext>>();
        IDbContextFactory<StreamarrDbContext> intercepted = new OptionsFactory(new DbContextOptionsBuilder<StreamarrDbContext>(options).AddInterceptors(held).Options);
        using var sweeper = ActivatorUtilities.CreateInstance<ViewerDownloadService>(factory.Services, intercepted, factory.Services.GetRequiredService<DownloadTransferGovernor>());

        var sweeping = sweeper.SweepTransfersAsync(CancellationToken.None);
        await held.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var since = Stopwatch.StartNew();
        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{ready.ViewerId}/sessions"))
            Assert.Equal(HttpStatusCode.NoContent, revoke.StatusCode);
        var renewed = await RenewAfterSignInAsync(ready, "phone-v4a");
        using var fresh = await StartTransferAsync(renewed, readDelayMs: 100);
        held.Release.TrySetResult();
        await sweeping.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(size, await fresh.Ended.WaitAsync(TimeSpan.FromSeconds(20)));
        await AssertEndsPromptlyAsync(old, size, since);
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(renewed)).Status);
    }

    [Fact]
    public async Task ADelayedSignOutFollowUp_NeverEndsATransferOfTheRenewedUrl()
    {
        const long size = 1_000_000;
        var ready = await ReadyAsync("acc-v4-notify", size: size, deviceId: "phone-v4b");
        using var old = await StartTransferAsync(ready.Url, readDelayMs: 100);
        var held = new HoldNotification();
        await using var listeners = new ServiceCollection()
            .AddSingleton<IViewerAccessListener>(held)
            .AddSingleton<IViewerAccessListener>(Downloads)
            .BuildServiceProvider();
        var sessions = ActivatorUtilities.CreateInstance<ViewerSessionService>(factory.Services, new ViewerAccessEvents(listeners));

        var revoking = sessions.RevokeAllAsync(ready.ViewerId, "revoked_by_admin", exceptSessionId: null, CancellationToken.None);
        await held.Entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var renewed = await RenewAfterSignInAsync(ready, "phone-v4b");
        using var fresh = await StartTransferAsync(renewed, readDelayMs: 100);
        held.Release.TrySetResult();
        await revoking.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(size, await fresh.Ended.WaitAsync(TimeSpan.FromSeconds(20)));
        // The test holds the follow-up for as long as it likes, so the sweep ends the old transfer; no 2 s bound here.
        Assert.True(await old.Ended.WaitAsync(TimeSpan.FromSeconds(20)) < size, "the old URL's transfer was sent whole");
        Assert.Equal((HttpStatusCode.Gone, "download_revoked"), await HeadAsync(ready.Url));
        Assert.Equal(HttpStatusCode.OK, (await HeadAsync(renewed)).Status);
    }

    [Theory]
    [InlineData("delete")]
    [InlineData("complete")]
    [InlineData("admin")]
    public async Task EndingADownload_EndsEveryOpenRequestOfIt(string how)
    {
        var ready = await ReadyAsync($"acc-v4-end-{how}", size: 12_000_000);
        using var first = await StartTransferAsync(ready.Url);
        using var second = await StartTransferAsync(ready.Url);

        var since = Stopwatch.StartNew();
        using var ended = how switch
        {
            "delete" => await ready.Viewer.DeleteAsync($"{Base}/{ready.DownloadId}"),
            "complete" => await ready.Viewer.PostAsJsonAsync($"{Base}/{ready.DownloadId}/complete", new { }),
            _ => await _admin.DeleteAsync($"/api/v1/config/viewers/downloads/{ready.DownloadId}"),
        };

        Assert.True(ended.IsSuccessStatusCode, await ended.Content.ReadAsStringAsync());
        await AssertEndsPromptlyAsync(first, ready.Size, since);
        await AssertEndsPromptlyAsync(second, ready.Size, since);
        Assert.Equal(HttpStatusCode.NotFound, (await HeadAsync(ready.Url)).Status);
    }
}
