using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Race and load coverage for the repair pipeline against the real server: many
/// overlapping readers hitting the same hole share exactly ONE single-flight job,
/// cancelled readers never cancel the shared job, healthy streams keep making
/// progress while the repair runs, the global connection budget holds, and the
/// repair metrics counters advance by exact deltas.
/// </summary>
[Collection("streamarr-server")]
public class RepairConcurrencyTests(StreamarrServerFixture fixture)
{
    private const int OverlappingReaders = 48;
    private const int CancelledReaders = 8;

    [Fact]
    public async Task OverlappingReadersDuringRepair_ShareOneJob_HealthyStreamsKeepFlowing()
    {
        using var client = fixture.CreateClient();
        using var admin = fixture.CreateClient(authenticated: false);
        await admin.AuthenticateAsAdminAsync();

        var before = (await admin.GetFromJsonAsync<MetricsResponse>("/api/v1/metrics"))!.Repairs!;

        // Admission is normal: the damage is invisible to the startup checks.
        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = StreamarrServerFixture.RaceRepairableReleaseId, Client = "tests" });
        Assert.Equal(HttpStatusCode.OK, resolveResponse.StatusCode);
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        Assert.Equal("ready", resolved.Status);
        var streamUrl = resolved.StreamUrl!;

        var healthy = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId, Client = "tests" });
        var healthyUrl = (await healthy.Content.ReadFromJsonAsync<ResolveResponse>())!.StreamUrl!;

        var video = fixture.RepairVideo;
        var (holeStart, holeEnd) = fixture.RaceRepairHole;
        var random = new Random(4242);

        // 48 overlapping ranges that all span the hole (each waits at it), 8 readers that
        // cancel mid-wait, and 2 healthy full reads racing alongside.
        var rangeTasks = Enumerable.Range(0, OverlappingReaders).Select(async i =>
        {
            var from = Math.Max(0, holeStart - random.Next(1, 200_000));
            var to = Math.Min(video.Length - 1, holeEnd + random.Next(1, 200_000));
            using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
            request.Headers.Range = new RangeHeaderValue(from, to);
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
            var bytes = await response.Content.ReadAsByteArrayAsync();
            Assert.Equal(video[(int)from..(int)(to + 1)], bytes);
            return i;
        }).ToArray();

        var cancelledTasks = Enumerable.Range(0, CancelledReaders).Select(async _ =>
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(random.Next(30, 250)));
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
                request.Headers.Range = new RangeHeaderValue(Math.Max(0, holeStart - 50_000), holeEnd + 50_000);
                using var response = await client.SendAsync(
                    request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                await response.Content.ReadAsByteArrayAsync(cts.Token);
            }
            catch (OperationCanceledException)
            {
                // Expected: this waiter dies, the shared job must not.
            }
            catch (HttpRequestException)
            {
                // Connection torn down mid-body — also a valid cancellation shape.
            }
        }).ToArray();

        var healthyTask = Task.Run(async () =>
        {
            using var response = await client.GetAsync(healthyUrl);
            Assert.Equal(fixture.Video, await response.Content.ReadAsByteArrayAsync());
        });

        await Task.WhenAll(rangeTasks.Concat(cancelledTasks).Append(healthyTask));

        // Exactly ONE job for this release, and it repaired the same 1-article damage.
        var overview = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        var job = Assert.Single(
            overview.Jobs, j => j.ReleaseId == StreamarrServerFixture.RaceRepairableReleaseId);
        Assert.Equal("ready", job.State);
        Assert.True(job.DamagedBlocks is 1 or 2, $"damaged blocks: {job.DamagedBlocks}");

        // Metrics advance by exact deltas: one attempt, one success, no failure/cancel of
        // the shared job; at least one reader actually waited at the hole and resumed.
        var after = (await admin.GetFromJsonAsync<MetricsResponse>("/api/v1/metrics"))!.Repairs!;
        Assert.Equal(before.AttemptsTotal + 1, after.AttemptsTotal);
        Assert.Equal(before.SucceededTotal + 1, after.SucceededTotal);
        Assert.Equal(before.FailedTotal, after.FailedTotal);
        Assert.Equal(before.CancelledTotal, after.CancelledTotal);
        Assert.True(after.WaitAtHoleStartedTotal > before.WaitAtHoleStartedTotal);
        Assert.True(after.WaitAtHoleResumedTotal > before.WaitAtHoleResumedTotal);

        // The global NNTP budget (12 in this fixture) held under the combined load.
        Assert.True(
            fixture.Nntp.MaxObservedConnections <= 12,
            $"connection budget exceeded: {fixture.Nntp.MaxObservedConnections}");

        // A follow-up ranged read is served from the artifact — byte-exact, no second job.
        using var tail = new HttpRequestMessage(HttpMethod.Get, streamUrl);
        tail.Headers.Range = new RangeHeaderValue(video.Length - 40_000, null);
        using var tailResponse = await client.SendAsync(tail);
        Assert.Equal(HttpStatusCode.PartialContent, tailResponse.StatusCode);
        Assert.Equal(video[^40_000..], await tailResponse.Content.ReadAsByteArrayAsync());
        var final = (await admin.GetFromJsonAsync<RepairOverviewResponse>("/api/v1/repairs"))!;
        Assert.Single(final.Jobs, j => j.ReleaseId == StreamarrServerFixture.RaceRepairableReleaseId);
    }
}
