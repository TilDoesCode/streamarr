using System.Net;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// End-to-end coverage of the permanent stream-history console (BRIEF §11): a resolve —
/// successful or dead — must show up in <c>GET /api/v1/streams</c> with its diagnostic
/// timeline, even once the underlying session is long gone. The recorder writes
/// asynchronously (see <c>StreamHistoryRecorder</c>), so assertions poll briefly rather than
/// assume immediate visibility.
/// </summary>
[Collection("streamarr-server")]
public class StreamHistoryEndpointTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task SuccessfulResolve_AppearsInHistory_WithATtffTimeline()
    {
        using var client = fixture.CreateClient();

        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DirectReleaseId });
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        Assert.NotNull(resolved.StreamUrl);
        var token = resolved.StreamUrl!.Split('/').Last();

        // The full TTFF timeline is flushed to permanent history at session close, not at
        // creation (writes stay off the hot path) — close it so there is something to read.
        var closeResponse = await client.PostAsync($"/api/v1/sessions/{token}/close", content: null);
        closeResponse.EnsureSuccessStatusCode();

        await client.AuthenticateAsAdminAsync();

        var record = await WaitForAsync(async () =>
        {
            var response = await client.GetAsync($"/api/v1/streams/{token}");
            if (response.StatusCode == HttpStatusCode.NotFound)
                return null;
            response.EnsureSuccessStatusCode();
            var body = await response.Content.ReadFromJsonAsync<StreamRecordResponse>();
            return body is { Timeline.Count: > 0 } ? body : null;
        });

        Assert.Equal(StreamarrServerFixture.DirectReleaseId, record.ReleaseId);
        Assert.Equal("closed", record.FinalState);
        Assert.Contains(record.Timeline, span => span.Category == "nzb");
        Assert.Contains(record.Timeline, span => span.Category == "materialize");

        var list = await client.GetFromJsonAsync<List<StreamRecordSummaryResponse>>("/api/v1/streams?limit=200");
        Assert.Contains(list!, r => r.Token == token && r.ReleaseId == StreamarrServerFixture.DirectReleaseId);
    }

    [Fact]
    public async Task DeadResolveWithNoFallback_AppearsInHistory_WithNoLiveTokenAndDeadState()
    {
        using var client = fixture.CreateClient();

        var resolveResponse = await client.PostAsJsonAsync(
            "/api/v1/resolve", new ResolveRequest { ReleaseId = StreamarrServerFixture.DeadOnlyReleaseId });
        var resolved = (await resolveResponse.Content.ReadFromJsonAsync<ResolveResponse>())!;
        Assert.Null(resolved.StreamUrl);
        Assert.Equal("dead", resolved.Status);

        await client.AuthenticateAsAdminAsync();

        // The fixture's server/DB are shared across this whole test collection, so more than
        // one record for this release id can plausibly exist (retries, other tests) — assert
        // on "at least one dead record shows up", not on a single specific row.
        var matches = await WaitForAsync(async () =>
        {
            var records = await client.GetFromJsonAsync<List<StreamRecordSummaryResponse>>("/api/v1/streams?limit=200");
            var dead = records!.Where(r => r.ReleaseId == StreamarrServerFixture.DeadOnlyReleaseId && r.FinalState == "dead").ToList();
            return dead.Count > 0 ? dead : null;
        });

        var record = matches[0];
        Assert.NotNull(record.Token); // falls back to the synthetic attempt id; no session was ever minted

        // rel-dead-only carries no PAR2 set, so repair always engages and fails the same way —
        // this exercises exactly the "went into repair, and that was the error" scenario the
        // feature exists for. (Not asserting on ttff spans here: once healthCache has this
        // release cached dead — plausible given other tests in this shared collection resolve
        // it too — later resolves take the short-circuit path that never measures a timeline.)
        var detail = await client.GetFromJsonAsync<StreamRecordResponse>($"/api/v1/streams/{record.Token}");
        Assert.NotNull(detail);
        Assert.Contains(detail!.Events, e => e.Source == "repair" && e.Detail == "failed: the release carries no PAR2 set");
    }

    [Fact]
    public async Task Streams_RequireAuthentication()
    {
        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync("/api/v1/streams");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private static async Task<T> WaitForAsync<T>(Func<Task<T?>> probe)
    {
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            var result = await probe();
            if (result is not null)
                return result;
            await Task.Delay(50);
        }
        throw new TimeoutException("Timed out waiting for the stream history record to appear.");
    }
}
