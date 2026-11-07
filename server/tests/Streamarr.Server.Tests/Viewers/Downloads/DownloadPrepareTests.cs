using System.Text.Json;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Transcoding;
using Streamarr.Server.Transcoding;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;
using Microsoft.Extensions.DependencyInjection;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Download preparation (resolve, copy-only fallback, probe, hard direct-play check) and the records over the real HTTP pipeline.</summary>
public sealed class DownloadPrepareTests(ViewerDownloadFactory factory) : IClassFixture<ViewerDownloadFactory>, IAsyncLifetime
{
    private const string Base = "/api/v1/viewer/downloads";
    private const string Movie = "tmdb-movie-501";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true });
        factory.Resolver.Script = null;
        factory.Media.DeadStreams.Clear();
        factory.Media.ProbeGate = null;
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private static SourceMediaInfo Mkv(params SourceSubtitleStream[] subtitles)
        => TranscodeTestData.Media(container: "matroska,webm", audioCodec: "eac3", channels: 6, subtitles: subtitles);

    private async Task<string> ReleaseAsync(HttpClient viewer, string fragment, string workId = Movie, object? device = null)
    {
        var candidates = (await Dl.PostAsync(viewer, $"{Base}/candidates", new { workId, device = device ?? Dl.AndroidTv })).GetProperty("candidates");
        var releaseId = candidates.EnumerateArray()
            .Single(c => c.GetProperty("version").GetProperty("name").GetString()!.Contains(fragment, StringComparison.Ordinal))
            .GetProperty("version").GetProperty("releaseId").GetString()!;
        factory.Media.Sources.TryRemove(releaseId, out _);
        factory.Media.Files.TryRemove(releaseId, out _);
        return releaseId;
    }

    private static object Prepare(string releaseId, object device, string workId = Movie, string? clientRef = null, string? deviceId = null)
        => new { workId, releaseId, device, clientRef, deviceId, deviceName = "Pixel 9" };

    [Fact]
    public async Task Ready_CarriesTheFileCapability_ExactSize_AndTheFileAsItIs()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-ready");
        var releaseId = await ReleaseAsync(viewer, "1080p.WEB-DL.DDP5.1");
        factory.Media.Sources[releaseId] = Mkv(TranscodeTestData.Subtitle(2, "subrip", "ger"), TranscodeTestData.Subtitle(3, "hdmv_pgs_subtitle", "eng"));
        factory.Media.Files[releaseId] = new StreamFileInfo("Catalog.Movie.2021.mkv", 1_234_567, "mkv", "video/x-matroska");

        var queued = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202);
        Assert.Equal("queued", queued.GetProperty("state").GetString());
        Assert.Equal("Catalog Movie", queued.GetProperty("title").GetString());
        var ready = await Dl.WaitAsync(viewer, queued.GetProperty("downloadId").GetString()!);

        Assert.Equal("ready", ready.GetProperty("state").GetString());
        Assert.StartsWith("/api/v1/offline/", ready.GetProperty("fileUrl").GetString());
        Assert.Equal(1_234_567, ready.GetProperty("sizeBytes").GetInt64());
        Assert.Equal("Catalog.Movie.2021.mkv", ready.GetProperty("fileName").GetString());
        Assert.Equal("mkv", ready.GetProperty("container").GetString());
        Assert.Equal("video/x-matroska", ready.GetProperty("contentType").GetString());
        Assert.StartsWith("\"", ready.GetProperty("eTag").GetString());
        Assert.Equal("native", ready.GetProperty("engine").GetString());
        Assert.Equal(releaseId, ready.GetProperty("releaseId").GetString());
        Assert.Equal(releaseId, ready.GetProperty("version").GetProperty("releaseId").GetString());
        Assert.True(ready.GetProperty("thisDevice").GetBoolean());
        Assert.Equal("Pixel 9", ready.GetProperty("deviceName").GetString());
        Assert.InRange(ready.GetProperty("expiresAt").GetDateTimeOffset(), factory.Clock.GetUtcNow().AddDays(29), factory.Clock.GetUtcNow().AddDays(31));
        var info = ready.GetProperty("mediaInfo");
        Assert.Equal("original", info.GetProperty("audioTracks")[0].GetProperty("deliveredAs").GetString());
        var subtitles = info.GetProperty("subtitleTracks").EnumerateArray().ToList();
        Assert.Equal("embedded", subtitles[0].GetProperty("deliveredAs").GetString());
        Assert.False(subtitles[0].GetProperty("vlcOnly").GetBoolean());
        Assert.Equal("none", subtitles[1].GetProperty("deliveredAs").GetString());
        Assert.False(subtitles[1].GetProperty("vlcOnly").GetBoolean());
        Assert.Equal(SessionManager.TransferClient, factory.Resolver.Calls.Last(c => c.ReleaseId == releaseId).Client);
        Assert.False(factory.Resolver.Calls.Last(c => c.ReleaseId == releaseId).AutoFallback);
    }

    [Fact]
    public async Task OnAnIPhone_AnMkvPlaysWithVlc_AndImageSubtitlesAreMarkedVlcOnly()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-vlc");
        var releaseId = await ReleaseAsync(viewer, "1080p.WEB-DL.DDP5.1", device: Dl.IPhone);
        factory.Media.Sources[releaseId] = Mkv(TranscodeTestData.Subtitle(2, "hdmv_pgs_subtitle", "eng"));

        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.IPhone), 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);

        Assert.Equal("vlc", ready.GetProperty("engine").GetString());
        var subtitle = ready.GetProperty("mediaInfo").GetProperty("subtitleTracks")[0];
        Assert.True(subtitle.GetProperty("vlcOnly").GetBoolean());
        Assert.Equal("embedded", subtitle.GetProperty("deliveredAs").GetString());
        Assert.Contains(ready.GetProperty("decision").GetProperty("reasons").EnumerateArray(), r => r.GetProperty("code").GetString() == "vlc_fallback");
    }

    [Fact]
    public async Task AFileThatDoesNotPlayAsItIs_FailsTheHardCheck_WithReasons()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-hard");
        var releaseId = await ReleaseAsync(viewer, "720p", device: Dl.IPhoneNoVlc);
        factory.Media.Sources[releaseId] = TranscodeTestData.Media(container: "matroska,webm", audioCodec: "dts", channels: 6);

        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.IPhoneNoVlc), 202)).GetProperty("downloadId").GetString()!;
        var failed = await Dl.WaitAsync(viewer, id);

        Assert.Equal("failed", failed.GetProperty("state").GetString());
        Assert.Equal("not_direct_playable", Dl.Code(failed));
        Assert.Contains("container_unsupported", failed.GetProperty("error").GetProperty("params").GetProperty("reasons").GetString());
        Assert.Equal(["otherVersion"], failed.GetProperty("suggestedActions").EnumerateArray().Select(a => a.GetString()).ToArray());
        Assert.NotEmpty(failed.GetProperty("decision").GetProperty("skipped").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, failed.GetProperty("fileUrl").ValueKind);
        Assert.Contains(factory.Files.Released, r => r.ReleaseId == releaseId);
    }

    [Fact]
    public async Task ADeadCopy_FallsBackToAnotherCopyOfTheSameRelease_Only()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-copy");
        var releaseId = await ReleaseAsync(viewer, "S01.German.DL.AAC.1080p", "tmdb-tv-604-s01e01");
        factory.Resolver.Script = (call, observer, _) => Task.FromResult(call.ReleaseId == releaseId
            ? new ResolveResponse { ReleaseId = call.ReleaseId, Status = "dead", Attempts = [new ResolveAttempt { ReleaseId = call.ReleaseId, Status = "dead" }] }
            : FakePlaybackResolver.Ready(call.ReleaseId));

        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, "tmdb-tv-604-s01e01"), 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);

        Assert.Equal("ready", ready.GetProperty("state").GetString());
        Assert.NotEqual(releaseId, ready.GetProperty("releaseId").GetString());
        Assert.Equal(releaseId, ready.GetProperty("fallbackFrom").GetProperty("releaseId").GetString());
        var attempts = ready.GetProperty("attempts").EnumerateArray().ToList();
        Assert.Equal(["dead", "ready"], attempts.Select(a => a.GetProperty("status").GetString()).ToArray());
        Assert.All(attempts, a => Assert.Contains("S01.German.DL.AAC.1080p", a.GetProperty("name").GetString()));
    }

    [Fact]
    public async Task WhenEveryCopyIsDead_ItFails_InsteadOfTakingAnotherRelease()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-dead");
        var releaseId = await ReleaseAsync(viewer, "1080p.WEB-DL.DDP5.1");
        factory.Resolver.Script = (call, _, _) => Task.FromResult(new ResolveResponse { ReleaseId = call.ReleaseId, Status = "dead", Attempts = [] });

        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
        var failed = await Dl.WaitAsync(viewer, id);

        Assert.Equal("release_dead", Dl.Code(failed));
        Assert.Single(failed.GetProperty("attempts").EnumerateArray());
        Assert.All(factory.Resolver.Calls.Where(c => c.Client == SessionManager.TransferClient), c => Assert.False(c.AutoFallback));
    }

    [Fact]
    public async Task ABusyServer_KeepsItQueued_ThenItBecomesReady()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-busy");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var busy = 3;
        factory.Resolver.Script = (call, _, _) => Interlocked.Decrement(ref busy) >= 0
            ? throw new ResourceCapacityException("busy")
            : Task.FromResult(FakePlaybackResolver.Ready(call.ReleaseId));

        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);

        Assert.Equal("ready", ready.GetProperty("state").GetString());
        Assert.True(busy < 0);
    }

    [Fact]
    public async Task AnUnknownVersion_FailsWithReleaseNotFound()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-unknown");

        var id = (await Dl.PostAsync(viewer, Base, Prepare("rel-nowhere", Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
        var failed = await Dl.WaitAsync(viewer, id);

        Assert.Equal("release_not_found", Dl.Code(failed));
        Assert.Equal("unknown", failed.GetProperty("error").GetProperty("params").GetProperty("reason").GetString());
    }

    [Fact]
    public async Task AClientRef_MakesPrepareIdempotent_OnTheSameDevice()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-ref");
        var releaseId = await ReleaseAsync(viewer, "720p");

        var first = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "ref-1"), 202);
        var second = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "ref-1"), 202);
        var third = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "ref-2"), 202);

        Assert.Equal(first.GetProperty("downloadId").GetString(), second.GetProperty("downloadId").GetString());
        Assert.NotEqual(first.GetProperty("downloadId").GetString(), third.GetProperty("downloadId").GetString());
    }

    [Fact]
    public async Task PrepareGetAndList_ReturnTheClientRefAndDeviceIdAsSent_AndARetryTheSame_ToTheOwnerOnly()
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, "prep-ident");
        var releaseId = await ReleaseAsync(viewer, "720p");

        var prepared = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "  Ref-Æ-7f3a ", deviceId: " Install-ABC-1 "), 202);
        var id = prepared.GetProperty("downloadId").GetString()!;
        var retried = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "Ref-Æ-7f3a", deviceId: "INSTALL-abc-1"), 202);
        await Dl.WaitAsync(viewer, id);
        var fetched = await Dl.GetAsync(viewer, $"{Base}/{id}?deviceId=install-abc-1");
        var listed = Assert.Single((await Dl.GetAsync(viewer, $"{Base}?device=this&deviceId=INSTALL-ABC-1")).GetProperty("items").EnumerateArray());
        using var tablet = await Dl.DeviceAsync(factory, username, "Tablet");
        var fromTablet = Assert.Single((await Dl.GetAsync(tablet, $"{Base}?device=all")).GetProperty("items").EnumerateArray());
        var plain = await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202);

        foreach (var answer in new[] { prepared, retried, fetched, listed, fromTablet })
        {
            Assert.Equal(id, answer.GetProperty("downloadId").GetString());
            Assert.Equal("Install-ABC-1", answer.GetProperty("deviceId").GetString());
            Assert.Equal("Ref-Æ-7f3a", answer.GetProperty("clientRef").GetString());
        }
        Assert.True(listed.GetProperty("thisDevice").GetBoolean());
        Assert.Empty((await Dl.GetAsync(tablet, $"{Base}?device=this")).GetProperty("items").EnumerateArray());
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("deviceId").ValueKind);
        Assert.Equal(JsonValueKind.Null, plain.GetProperty("clientRef").ValueKind);

        var (stranger, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-ident-other");
        var strangerList = await stranger.GetStringAsync(Base);
        Assert.Empty(JsonDocument.Parse(strangerList).RootElement.GetProperty("items").EnumerateArray());
        Assert.DoesNotContain("7f3a", strangerList, StringComparison.Ordinal);
        Assert.Equal("download_not_found", Dl.Code(await Dl.GetAsync(stranger, $"{Base}/{id}?deviceId=Install-ABC-1", 404)));

        var adminList = await _admin.GetStringAsync($"/api/v1/config/viewers/downloads?viewerId={viewerId}");
        var adminItems = JsonDocument.Parse(adminList).RootElement.GetProperty("items").EnumerateArray().ToList();
        Assert.Equal(2, adminItems.Count);
        Assert.All(adminItems, item => Assert.False(item.TryGetProperty("clientRef", out _)));
        Assert.DoesNotContain("7f3a", adminList, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ARenewalAfterASecuritySignOut_RebindsTheReturnedDeviceId_AnOrdinaryRenewalKeepsIt()
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, "prep-rebind");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, clientRef: "rebind-1", deviceId: "Old-Phone"), 202)).GetProperty("downloadId").GetString()!;
        await Dl.WaitAsync(viewer, id);
        using (var revoke = await _admin.DeleteAsync($"/api/v1/config/viewers/{viewerId}/sessions"))
            Assert.Equal(System.Net.HttpStatusCode.NoContent, revoke.StatusCode);
        using var again = await Dl.DeviceAsync(factory, username, "New phone");

        var rebound = await Dl.PostAsync(again, $"{Base}/{id}/renew?deviceId=%20New-Phone-2%20", new { });
        var kept = await Dl.PostAsync(again, $"{Base}/{id}/renew?deviceId=Third-Phone", new { });

        Assert.Equal("New-Phone-2", rebound.GetProperty("deviceId").GetString());
        Assert.Equal("rebind-1", rebound.GetProperty("clientRef").GetString());
        Assert.Equal("New-Phone-2", kept.GetProperty("deviceId").GetString());
    }

    [Fact]
    public async Task TheList_IsPerViewer_AndOnlyThePreparingDeviceSeesTheFileUrl()
    {
        var (viewer, username, _) = await Dl.ViewerAsync(factory, _admin, "prep-list");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv, deviceId: "install-1"), 202)).GetProperty("downloadId").GetString()!;
        await Dl.WaitAsync(viewer, id);
        using var tablet = await Dl.DeviceAsync(factory, username, "Tablet");
        var (stranger, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-stranger");

        var own = await Dl.GetAsync(viewer, $"{Base}?device=this");
        var fromTablet = await Dl.GetAsync(tablet, $"{Base}?device=all");
        var tabletThis = await Dl.GetAsync(tablet, $"{Base}?device=this");
        var reinstalled = await Dl.GetAsync(tablet, $"{Base}?device=this&deviceId=install-1");

        Assert.Equal(id, Assert.Single(own.GetProperty("items").EnumerateArray()).GetProperty("downloadId").GetString());
        Assert.Equal(2, own.GetProperty("limits").GetProperty("maxConcurrentDownloads").GetInt32());
        Assert.True(own.GetProperty("limits").GetProperty("allowed").GetBoolean());
        var seen = Assert.Single(fromTablet.GetProperty("items").EnumerateArray());
        Assert.False(seen.GetProperty("thisDevice").GetBoolean());
        Assert.Equal(JsonValueKind.Null, seen.GetProperty("fileUrl").ValueKind);
        Assert.Empty(tabletThis.GetProperty("items").EnumerateArray());
        Assert.True(Assert.Single(reinstalled.GetProperty("items").EnumerateArray()).GetProperty("thisDevice").GetBoolean());
        Assert.Empty((await Dl.GetAsync(stranger, Base)).GetProperty("items").EnumerateArray());
        Assert.Equal("download_not_found", Dl.Code(await Dl.GetAsync(stranger, $"{Base}/{id}", 404)));
    }

    [Fact]
    public async Task Renew_MovesTheExpiry_Complete_EndsTheFileUrl_Delete_ForgetsIt()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-life");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
        var ready = await Dl.WaitAsync(viewer, id);
        Assert.True(ready.GetProperty("state").GetString() == "ready", ready.ToString());
        var url = ready.GetProperty("fileUrl").GetString()!;
        var expires = ready.GetProperty("expiresAt").GetDateTimeOffset();

        factory.Clock.Advance(TimeSpan.FromMinutes(30));
        var renewed = await Dl.PostAsync(viewer, $"{Base}/{id}/renew", new { });
        Assert.True(renewed.GetProperty("expiresAt").GetDateTimeOffset() >= expires.AddMinutes(29));
        Assert.Equal(url, renewed.GetProperty("fileUrl").GetString());

        Assert.Equal("size_mismatch", Dl.Code(await Dl.PostAsync(viewer, $"{Base}/{id}/complete", new { bytesReceived = 12 }, 409)));
        var completed = await Dl.PostAsync(viewer, $"{Base}/{id}/complete", new { bytesReceived = 1_000_000 });
        Assert.Equal("completed", completed.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, completed.GetProperty("fileUrl").ValueKind);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await factory.CreateClient().GetAsync(url)).StatusCode);
        Assert.Contains(factory.Files.Released, r => r.ReleaseId == releaseId);
        Assert.Equal("download_not_ready", Dl.Code(await Dl.PostAsync(viewer, $"{Base}/{id}/renew", new { }, 409)));

        Assert.Equal(System.Net.HttpStatusCode.NoContent, (await viewer.DeleteAsync($"{Base}/{id}")).StatusCode);
        Assert.Equal("download_not_found", Dl.Code(await Dl.GetAsync(viewer, $"{Base}/{id}", 404)));
    }

    [Fact]
    public async Task DeletingWhilePreparing_StopsThePreparation()
    {
        var (viewer, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-cancel");
        var releaseId = await ReleaseAsync(viewer, "720p");
        factory.Media.ProbeGate = new TaskCompletionSource();
        try
        {
            var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
            var deadline = DateTime.UtcNow.AddSeconds(10);
            while ((await Dl.GetAsync(viewer, $"{Base}/{id}")).GetProperty("state").GetString() != "probing")
            {
                Assert.True(DateTime.UtcNow < deadline);
                await Task.Delay(20);
            }

            Assert.Equal(System.Net.HttpStatusCode.NoContent, (await viewer.DeleteAsync($"{Base}/{id}")).StatusCode);
            Assert.Equal("download_not_found", Dl.Code(await Dl.GetAsync(viewer, $"{Base}/{id}", 404)));
        }
        finally
        {
            factory.Media.ProbeGate.TrySetResult();
        }
    }

    [Fact]
    public async Task APreparationInterruptedByARestart_ResumesFromItsRecord()
    {
        var (viewer, _, viewerId) = await Dl.ViewerAsync(factory, _admin, "prep-restart");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var id = $"restart{Guid.NewGuid():N}"[..32];
        var dbFactory = factory.Services.GetRequiredService<Microsoft.EntityFrameworkCore.IDbContextFactory<Streamarr.Server.Persistence.StreamarrDbContext>>();
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            db.ViewerDownloads.Add(new Streamarr.Server.Persistence.Entities.ViewerDownloadEntity
            {
                Id = id,
                ViewerId = viewerId,
                SessionId = "an-earlier-session",
                WorkId = Movie,
                RequestedReleaseId = releaseId,
                State = "resolving",
                RequestJson = JsonSerializer.Serialize(new { device = Dl.AndroidTv, engine = "auto" }, new JsonSerializerOptions(JsonSerializerDefaults.Web)),
                CreatedAt = factory.Clock.GetUtcNow(),
                UpdatedAt = factory.Clock.GetUtcNow(),
            });
            await db.SaveChangesAsync();
        }

        await factory.Services.GetRequiredService<ViewerDownloadService>().StartAsync(CancellationToken.None);
        var ready = await Dl.WaitAsync(viewer, id);

        Assert.Equal("ready", ready.GetProperty("state").GetString());
        Assert.False(ready.GetProperty("thisDevice").GetBoolean());
        Assert.Equal(JsonValueKind.Null, ready.GetProperty("fileUrl").ValueKind);
        Assert.Equal(1_000_000, ready.GetProperty("sizeBytes").GetInt64());
    }

    [Fact]
    public async Task Prepare_ChecksPermissionAgeGateAndBody()
    {
        var (off, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-off", new { allowDownloads = false });
        var (kid, _, _) = await Dl.ViewerAsync(factory, _admin, "prep-kid", new { maxAge = 12 });

        Assert.Equal("downloads_not_allowed", Dl.Code(await Dl.PostAsync(off, Base, Prepare("x", Dl.AndroidTv), 403)));
        Assert.Equal("age_restricted", Dl.Code(await Dl.PostAsync(kid, Base, Prepare("x", Dl.AndroidTv, "tmdb-movie-502"), 403)));
        Assert.Equal("invalid_download_request", Dl.Code(await Dl.PostAsync(kid, Base, new { workId = Movie, device = Dl.AndroidTv }, 400)));
        Assert.Equal("invalid_device_profile", Dl.Code(await Dl.PostAsync(kid, Base, new { workId = Movie, releaseId = "x" }, 400)));
        Assert.Equal("invalid_download_request", Dl.Code(await Dl.GetAsync(kid, $"{Base}/x?waitMs=20000", 400)));
    }

    [Fact]
    public async Task TheAdmin_SeesDownloadsPerViewer_AndCanRevokeThem()
    {
        var (viewer, username, viewerId) = await Dl.ViewerAsync(factory, _admin, "prep-admin");
        var releaseId = await ReleaseAsync(viewer, "720p");
        var id = (await Dl.PostAsync(viewer, Base, Prepare(releaseId, Dl.AndroidTv), 202)).GetProperty("downloadId").GetString()!;
        var url = (await Dl.WaitAsync(viewer, id)).GetProperty("fileUrl").GetString()!;

        var list = await Dl.GetAsync(_admin, $"/api/v1/config/viewers/downloads?viewerId={viewerId}");
        var item = Assert.Single(list.GetProperty("items").EnumerateArray());
        Assert.Equal(username, item.GetProperty("username").GetString());
        Assert.Equal("ready", item.GetProperty("state").GetString());
        Assert.Contains("720p", item.GetProperty("releaseName").GetString());
        Assert.Equal(0, list.GetProperty("activeTransfers").GetInt32());

        Assert.Equal(System.Net.HttpStatusCode.NoContent, (await _admin.DeleteAsync($"/api/v1/config/viewers/downloads/{id}")).StatusCode);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, (await factory.CreateClient().GetAsync(url)).StatusCode);
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await viewer.GetAsync("/api/v1/config/viewers/downloads")).StatusCode);
    }

    [Fact]
    public async Task DownloadSettings_AreValidated_AndReturned()
    {
        var settings = await Dl.GetAsync(_admin, "/api/v1/config/viewers/settings");
        Assert.Equal(2, settings.GetProperty("downloads").GetProperty("maxActivePerViewer").GetInt32());
        Assert.Equal(16_000, settings.GetProperty("downloads").GetProperty("bandwidthWhileStreamingKbps").GetInt32());

        var bad = await _admin.PutAsync("/api/v1/config/viewers/settings",
            System.Net.Http.Json.JsonContent.Create(new { downloads = new { maxActiveGlobal = 0 } }));
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, bad.StatusCode);
        var ok = await _admin.PutAsync("/api/v1/config/viewers/settings",
            System.Net.Http.Json.JsonContent.Create(new { downloads = new { capabilityDays = 7 } }));
        var saved = JsonDocument.Parse(await ok.Content.ReadAsStringAsync()).RootElement.GetProperty("downloads");
        Assert.Equal(7, saved.GetProperty("capabilityDays").GetInt32());
        Assert.Equal(4, saved.GetProperty("maxActiveGlobal").GetInt32());
        await _admin.PutAsync("/api/v1/config/viewers/settings", System.Net.Http.Json.JsonContent.Create(new { downloads = new { capabilityDays = 30 } }));
    }
}
