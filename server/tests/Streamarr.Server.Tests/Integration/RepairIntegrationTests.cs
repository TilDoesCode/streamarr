using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// End-to-end PAR2 repair over the real server + mock NNTP: an article that STATs
/// alive but BODYs 430 only during playback must flip the open stream into repair,
/// continue byte-exactly over the same capability URL, and publish an artifact that
/// serves every later read locally.
/// </summary>
[Collection("streamarr-server")]
public class RepairIntegrationTests(StreamarrServerFixture fixture)
{
    private async Task<ResolveResponse> ResolveAsync(HttpClient client, string releaseId)
    {
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = releaseId, Client = "tests", AutoFallback = true });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return (await response.Content.ReadFromJsonAsync<ResolveResponse>())!;
    }

    [Fact]
    public async Task RuntimeArticleLoss_RepairsAndContinuesTheSameOpenStream()
    {
        using var client = fixture.CreateClient();

        // 1) Resolve admits the release normally — the damage is invisible to the
        //    startup BODY check (first 8 articles) and the lying spread STAT.
        var resolved = await ResolveAsync(client, StreamarrServerFixture.RepairableReleaseId);
        Assert.Equal("ready", resolved.Status);
        Assert.Equal(StreamarrServerFixture.RepairableReleaseId, resolved.ReleaseId);
        Assert.NotNull(resolved.StreamUrl);

        // 2) One linear GET over the whole file: the read hits the 430 mid-stream, the
        //    session flips into repair, waits at the hole, and continues — same URL,
        //    same response, byte-exact output. No EOF, no zero bytes.
        using var response = await client.GetAsync(
            resolved.StreamUrl, HttpCompletionOption.ResponseHeadersRead);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(fixture.RepairVideo.Length, response.Content.Headers.ContentLength);
        var streamed = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(fixture.RepairVideo, streamed);

        // 3) The job is Ready and the artifact exists (admin surface).
        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        var overview = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        var job = Assert.Single(
            overview.Jobs, j => j.ReleaseId == StreamarrServerFixture.RepairableReleaseId);
        Assert.Equal("ready", job.State);
        Assert.Equal("repairable", job.Disposition);
        Assert.True(job.DamagedBlocks is 1 or 2, $"damaged blocks: {job.DamagedBlocks}");
        Assert.Equal(job.DamagedBlocks, job.RecoveryBlocksUsed);
        Assert.True(job.SourceBytesDownloaded > 0);
        Assert.True(job.ParityBytesDownloaded > 0);
        Assert.NotEmpty(job.Events);
        Assert.Contains(overview.Artifacts, a => a.Bytes == fixture.RepairVideo.Length);

        // 4) Ranged reads around the repaired hole are byte-exact (served locally now).
        var (holeStart, holeEnd) = fixture.RepairHole;
        var from = Math.Max(0, holeStart - 100_000);
        var to = Math.Min(fixture.RepairVideo.Length - 1, holeEnd + 100_000 - 1);
        using var rangeRequest = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl);
        rangeRequest.Headers.Range = new RangeHeaderValue(from, to);
        using var rangeResponse = await client.SendAsync(rangeRequest);
        Assert.Equal(HttpStatusCode.PartialContent, rangeResponse.StatusCode);
        Assert.Equal(
            fixture.RepairVideo[(int)from..(int)(to + 1)],
            await rangeResponse.Content.ReadAsByteArrayAsync());

        // 5) A later range far behind the hole also matches.
        var tailFrom = fixture.RepairVideo.Length - 50_000;
        using var tailRequest = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl);
        tailRequest.Headers.Range = new RangeHeaderValue(tailFrom, null);
        using var tailResponse = await client.SendAsync(tailRequest);
        Assert.Equal(HttpStatusCode.PartialContent, tailResponse.StatusCode);
        Assert.Equal(
            fixture.RepairVideo[(int)tailFrom..],
            await tailResponse.Content.ReadAsByteArrayAsync());

        // 6) A fresh resolve serves from the verified local artifact: playable "ready"
        //    for old clients, origin honestly dead, playability repairedReady — and no
        //    second full repair (still exactly one job).
        var again = await ResolveAsync(client, StreamarrServerFixture.RepairableReleaseId);
        Assert.Equal("ready", again.Status);
        Assert.Equal("dead", again.OriginHealth);
        Assert.Equal("repairedReady", again.Playability);
        Assert.NotNull(again.StreamUrl);
        using var localRead = await client.GetAsync(again.StreamUrl);
        Assert.Equal(fixture.RepairVideo, await localRead.Content.ReadAsByteArrayAsync());

        var after = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        Assert.Single(after.Jobs, j => j.ReleaseId == StreamarrServerFixture.RepairableReleaseId);
    }

    [Fact]
    public async Task RecoverySlicesEmbeddedInTheBasePar2_RepairWithoutAVolumeFile()
    {
        using var client = fixture.CreateClient();
        var resolved = await ResolveAsync(client, StreamarrServerFixture.EmbeddedPar2ReleaseId);

        using var response = await client.GetAsync(
            resolved.StreamUrl,
            HttpCompletionOption.ResponseHeadersRead);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(fixture.RepairVideo, await response.Content.ReadAsByteArrayAsync());

        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        var overview = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        var job = Assert.Single(
            overview.Jobs,
            item => item.ReleaseId == StreamarrServerFixture.EmbeddedPar2ReleaseId);
        Assert.Equal("ready", job.State);
        Assert.True(job.RecoveryBlocksUsed > 0);
    }

    [Fact]
    public async Task InsufficientParity_KeepsTheLegacyDeadBehavior()
    {
        using var client = fixture.CreateClient();

        var resolved = await ResolveAsync(client, StreamarrServerFixture.UnrepairableReleaseId);
        Assert.Equal("ready", resolved.Status);
        Assert.NotNull(resolved.StreamUrl);

        // The full read must fail (no silent EOF, no fabricated bytes): the repair job
        // classifies insufficient parity and the original dead/invalidations apply.
        var failed = false;
        try
        {
            using var response = await client.GetAsync(
                resolved.StreamUrl, HttpCompletionOption.ResponseHeadersRead);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            failed = bytes.Length != fixture.RepairVideo.Length;
        }
        catch (HttpRequestException)
        {
            failed = true;
        }
        catch (IOException)
        {
            failed = true;
        }
        Assert.True(failed, "the damaged stream must not silently deliver a complete body");

        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        var overview = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        var job = overview.Jobs.First(j => j.ReleaseId == StreamarrServerFixture.UnrepairableReleaseId);
        Assert.Equal("failed", job.State);
        Assert.Equal("insufficientParity", job.Disposition);
        Assert.NotNull(job.FailureReason);

        // The origin is dead; with no sibling the resolve reports the repair failure.
        var again = await ResolveAsync(client, StreamarrServerFixture.UnrepairableReleaseId);
        Assert.Equal("dead", again.Status);
        Assert.Null(again.StreamUrl);
        Assert.Equal("dead", again.OriginHealth);
    }

    [Fact]
    public async Task HealthyReleases_NeverTouchTheRepairPipeline()
    {
        using var client = fixture.CreateClient();

        var resolved = await ResolveAsync(client, StreamarrServerFixture.DirectReleaseId);
        Assert.Equal("ready", resolved.Status);
        using var read = await client.GetAsync(resolved.StreamUrl);
        Assert.Equal(fixture.Video, await read.Content.ReadAsByteArrayAsync());

        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        var overview = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        Assert.DoesNotContain(overview.Jobs, j => j.ReleaseId == StreamarrServerFixture.DirectReleaseId);
    }

    [Theory]
    [InlineData("bad\nrelease", null)]
    [InlineData("rel-direct", "bad\rwork")]
    [InlineData("rel-direct", " ")]
    public async Task ManualRepair_RejectsMalformedIdentifiers(string releaseId, string? workId)
    {
        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();

        using var response = await admin.PostAsJsonAsync(
            "/api/v1/repairs",
            new StartRepairRequest { ReleaseId = releaseId, WorkId = workId });

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var error = (await response.Content.ReadFromJsonAsync<ErrorResponse>())!;
        Assert.Equal("invalid_repair_request", error.Error.Code);
    }

    [Fact]
    public async Task ManualRepair_RejectsAmbiguousIndependentPar2Sets()
    {
        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();
        using var start = await admin.PostAsJsonAsync(
            "/api/v1/repairs",
            new StartRepairRequest
            {
                ReleaseId = StreamarrServerFixture.AmbiguousPar2ReleaseId,
                WorkId = StreamarrServerFixture.AmbiguousPar2WorkId,
            });
        Assert.Equal(HttpStatusCode.Accepted, start.StatusCode);
        var job = (await start.Content.ReadFromJsonAsync<RepairJobResponse>())!;

        for (var attempt = 0; attempt < 100 && job.State is not ("failed" or "ready"); attempt++)
        {
            await Task.Delay(50);
            job = (await admin.GetFromJsonAsync<RepairJobResponse>($"/api/v1/repairs/{job.JobId}"))!;
        }

        Assert.Equal("failed", job.State);
        Assert.Equal("unsupported", job.Disposition);
        Assert.Contains("multiple incompatible PAR2 sets", job.FailureReason, StringComparison.Ordinal);
    }
}
