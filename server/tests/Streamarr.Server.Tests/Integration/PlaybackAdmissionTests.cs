using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Contracts;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// The two-phase admission contract (POST/GET /api/v1/playback-sessions): an artificially
/// minute-long Core prepare must not block the admission POST beyond its short hard budget
/// or serialize a second Core admission, and the poll surface must carry the prepare to
/// a servable capability once the stall clears. Jellyfin's own live-stream lock remains
/// held by OpenMediaSource until that polling completes.
/// </summary>
[Collection("streamarr-server")]
public class PlaybackAdmissionTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task SlowPrepare_AnswersPreparingWithinBudget_SecondAdmissionIsIndependent()
    {
        using var client = fixture.CreateClient();
        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fixture.Nntp.BodyGates[fixture.SlowOpenFirstSegmentId] = gate;
        string? slowAdmissionId = null;
        try
        {
            // 1) The admission POST must return "preparing" quickly despite the stalled BODY.
            var sw = Stopwatch.StartNew();
            using var response = await client.PostAsJsonAsync(
                "/api/v1/playback-sessions",
                new ResolveRequest { ReleaseId = StreamarrServerFixture.SlowOpenReleaseId, Client = "tests" });
            sw.Stop();
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
            var admission = (await response.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
            slowAdmissionId = admission.AdmissionId;
            Assert.Equal("preparing", admission.Phase);
            Assert.True(sw.Elapsed < TimeSpan.FromSeconds(8), $"admission took {sw.Elapsed}");
            Assert.Null(admission.Resolve);

            // 2) A second, healthy open is admitted independently — no serialization behind
            //    the stalled prepare.
            var second = Stopwatch.StartNew();
            using var healthy = await client.PostAsJsonAsync(
                "/api/v1/playback-sessions",
                new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId, Client = "tests" });
            second.Stop();
            Assert.Equal(HttpStatusCode.OK, healthy.StatusCode);
            var healthyAdmission = (await healthy.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
            Assert.Equal("ready", healthyAdmission.Phase);
            Assert.NotNull(healthyAdmission.Resolve?.StreamUrl);
            Assert.True(second.Elapsed < TimeSpan.FromSeconds(8), $"second open took {second.Elapsed}");
            using var healthyClaim = await client.PostAsync(
                $"/api/v1/playback-sessions/{healthyAdmission.AdmissionId}/claim",
                content: null);
            Assert.Equal(HttpStatusCode.OK, healthyClaim.StatusCode);

            // 3) Status polling reports "preparing" while the stall holds.
            var status = await client.GetFromJsonAsync<PlaybackAdmissionResponse>(
                $"/api/v1/playback-sessions/{admission.AdmissionId}");
            Assert.Equal("preparing", status!.Phase);
            using var prematureClaim = await client.PostAsync(
                $"/api/v1/playback-sessions/{admission.AdmissionId}/claim",
                content: null);
            Assert.Equal(HttpStatusCode.Conflict, prematureClaim.StatusCode);

            // 4) Clearing the stall lets the same admission converge to a servable capability.
            gate.SetResult();
            PlaybackAdmissionResponse? final = null;
            for (var attempt = 0; attempt < 120; attempt++)
            {
                final = await client.GetFromJsonAsync<PlaybackAdmissionResponse>(
                    $"/api/v1/playback-sessions/{admission.AdmissionId}");
                if (final!.Phase != "preparing")
                    break;
                await Task.Delay(250);
            }
            Assert.Equal("ready", final!.Phase);
            using var claim = await client.PostAsync(
                $"/api/v1/playback-sessions/{admission.AdmissionId}/claim",
                content: null);
            Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
            var claimed = (await claim.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
            Assert.Equal(StreamarrServerFixture.SlowOpenReleaseId, claimed.Resolve!.ReleaseId);
            using var read = await client.GetAsync(claimed.Resolve.StreamUrl);
            Assert.Equal(fixture.Video, await read.Content.ReadAsByteArrayAsync());
            slowAdmissionId = null;
        }
        finally
        {
            if (slowAdmissionId is not null)
                await client.DeleteAsync($"/api/v1/playback-sessions/{slowAdmissionId}");
            fixture.Nntp.BodyGates.TryRemove(fixture.SlowOpenFirstSegmentId, out _);
            gate.TrySetResult();
        }
    }

    [Fact]
    public async Task UnknownRelease_FailsFastWithAStableErrorCode()
    {
        using var client = fixture.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/v1/playback-sessions",
            new ResolveRequest { ReleaseId = "rel-does-not-exist", Client = "tests" });
        var admission = (await response.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
        Assert.Equal("failed", admission.Phase);
        Assert.Equal("unknown_release", admission.Error);

        using var claim = await client.PostAsync(
            $"/api/v1/playback-sessions/{admission.AdmissionId}/claim",
            content: null);
        Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
        var claimed = (await claim.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
        Assert.Equal("unknown_release", claimed.Error);
        using var repeated = await client.PostAsync(
            $"/api/v1/playback-sessions/{admission.AdmissionId}/claim",
            content: null);
        Assert.Equal(HttpStatusCode.NotFound, repeated.StatusCode);
    }

    [Fact]
    public async Task ClaimedAdmission_CleanupDeleteClosesAnIdleCapability()
    {
        using var client = fixture.CreateClient();
        using var response = await client.PostAsJsonAsync(
            "/api/v1/playback-sessions",
            new ResolveRequest
            {
                ReleaseId = StreamarrServerFixture.DirectReleaseId,
                Client = "tests",
                RequestedById = "claim-response-loss-test",
            });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var admission = (await response.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;
        using var claim = await client.PostAsync(
            $"/api/v1/playback-sessions/{admission.AdmissionId}/claim",
            content: null);
        Assert.Equal(HttpStatusCode.OK, claim.StatusCode);
        var claimed = (await claim.Content.ReadFromJsonAsync<PlaybackAdmissionResponse>())!;

        using var cleanup = await client.DeleteAsync(
            $"/api/v1/playback-sessions/{admission.AdmissionId}");
        Assert.Equal(HttpStatusCode.NoContent, cleanup.StatusCode);
        using var stream = await client.GetAsync(claimed.Resolve!.StreamUrl);
        Assert.Equal(HttpStatusCode.NotFound, stream.StatusCode);
    }

    [Fact]
    public async Task ClaimedAdmission_CleanupHandleExpiryDoesNotShortenTheSessionLifetime()
    {
        var resolve = fixture.GetRequiredService<ResolveService>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var time = new ManualTimeProvider();
        using var admissions = new PlaybackAdmissionService(
            resolve,
            sessions,
            NullLogger<PlaybackAdmissionService>.Instance,
            time);

        var admitted = await admissions.AdmitAsync(
            new ResolveRequest
            {
                ReleaseId = StreamarrServerFixture.DirectReleaseId,
                Client = "tests",
                RequestedById = "claimed-expiry-test",
            },
            requestedById: "claimed-expiry-test",
            requestedByName: null,
            token => $"/api/v1/stream/{token}",
            token => $"{fixture.BaseUrl}/api/v1/stream/{token}",
            TimeSpan.FromSeconds(10),
            CancellationToken.None);
        Assert.Equal("ready", admitted.Phase);
        Assert.Equal(
            PlaybackAdmissionClaimOutcome.Claimed,
            admissions.TryClaim(admitted.AdmissionId, out var claimed));

        var token = claimed!.Resolve!.StreamUrl!.Split('/').Last();
        time.Advance(TimeSpan.FromSeconds(31));
        admissions.Sweep();

        Assert.True(sessions.TryGetSession(token, out _));
        sessions.CloseSession(token);
    }

    [Fact]
    public async Task BackgroundSweep_ExpiresUnclaimedCapabilityWithoutMoreAdmissionTraffic()
    {
        var resolve = fixture.GetRequiredService<ResolveService>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        using var admissions = new PlaybackAdmissionService(
            resolve,
            sessions,
            NullLogger<PlaybackAdmissionService>.Instance,
            completedLifetime: TimeSpan.FromMilliseconds(500),
            sweepInterval: TimeSpan.FromMilliseconds(50));
        await admissions.StartAsync(CancellationToken.None);
        try
        {
            var admitted = await admissions.AdmitAsync(
                new ResolveRequest
                {
                    ReleaseId = StreamarrServerFixture.DirectReleaseId,
                    Client = "tests",
                    RequestedById = "background-expiry-test",
                },
                requestedById: "background-expiry-test",
                requestedByName: null,
                token => $"/api/v1/stream/{token}",
                token => $"{fixture.BaseUrl}/api/v1/stream/{token}",
                TimeSpan.FromSeconds(10),
                CancellationToken.None);
            Assert.Equal("ready", admitted.Phase);
            var ready = Assert.IsType<ResolveResponse>(admitted.Resolve);
            var token = ready.StreamUrl!.Split('/').Last();
            Assert.True(sessions.TryGetSession(token, out _));

            var expired = false;
            for (var attempt = 0; attempt < 100; attempt++)
            {
                if (!sessions.TryGetSession(token, out _))
                {
                    expired = true;
                    break;
                }
                await Task.Delay(50);
            }

            Assert.True(expired, "the hosted sweep did not retire the unclaimed capability");
        }
        finally
        {
            await admissions.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void CompletedAdmissionExpiry_StartsAtCompletionRatherThanCreation()
    {
        var created = DateTimeOffset.Parse("2026-08-01T12:00:00Z");
        var completed = created + TimeSpan.FromMinutes(14);

        Assert.False(PlaybackAdmissionService.IsExpired(
            created,
            completed,
            completed + TimeSpan.FromMinutes(1)));
        Assert.True(PlaybackAdmissionService.IsExpired(
            created,
            completed,
            completed + TimeSpan.FromMinutes(3)));
    }

    [Fact]
    public void UnexpectedHtmlNzbResponse_HasAStableFetchFailureCode()
    {
        var reason = PlaybackAdmissionService.FailureReason(
            new NzbUnexpectedContentException(),
            canceled: false);

        Assert.Equal("nzb_fetch_failed", reason);
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private DateTimeOffset _now = DateTimeOffset.Parse("2026-08-01T12:00:00Z");

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
