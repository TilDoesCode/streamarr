using System.Net;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// End-to-end season pack playback against the real server (real Kestrel, real
/// ffprobe, mock NNTP over TCP): resolving an episode work of a pack release must
/// stream exactly that episode's bytes out of the shared RAR set — locating the
/// episode's start via the RAR header chain, not guessing.
/// </summary>
[Collection("streamarr-server")]
public class SeasonPackIntegrationTests(StreamarrServerFixture fixture)
{
    private async Task<ResolveResponse> ResolveAsync(HttpClient client, string releaseId, string workId)
    {
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest { ReleaseId = releaseId, WorkId = workId, Client = "tests" });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<ResolveResponse>();
        Assert.NotNull(body);
        return body!;
    }

    // ------------------------------------------------- monolithic pack (one RAR set)

    [Fact]
    public async Task Resolve_MonolithicPack_MiddleEpisode_StreamsExactlyThatEpisode()
    {
        using var client = fixture.CreateClient();
        var episode2 = fixture.PackEpisodes[1];

        var resolved = await ResolveAsync(
            client, StreamarrServerFixture.SeasonPackReleaseId, StreamarrServerFixture.PackEpisodeWorkId(2));

        Assert.Equal("ready", resolved.Status);
        Assert.Equal("mkv", resolved.Container);
        Assert.Equal(episode2.Length, resolved.SizeBytes);
        Assert.NotNull(resolved.StreamUrl);

        // ffprobe ran server-side against THIS episode: ~12s, not E01's 8s or E03's 16s.
        Assert.NotNull(resolved.RunTimeTicks);
        Assert.InRange(
            resolved.RunTimeTicks!.Value,
            10 * TimeSpan.TicksPerSecond,
            14 * TimeSpan.TicksPerSecond);

        using var response = await client.GetAsync(resolved.StreamUrl);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(episode2, body);
    }

    [Fact]
    public async Task Resolve_MonolithicPack_EveryEpisode_IsByteIdentical_NoCacheCollisions()
    {
        using var client = fixture.CreateClient();

        // Resolve E1 → E3 → E2 out of order through the SAME releaseId + NZB + RAR set:
        // materialization/probe caches must key on the episode, never replay a sibling.
        foreach (var episode in new[] { 1, 3, 2 })
        {
            var expected = fixture.PackEpisodes[episode - 1];
            var resolved = await ResolveAsync(
                client,
                StreamarrServerFixture.SeasonPackReleaseId,
                StreamarrServerFixture.PackEpisodeWorkId(episode));

            Assert.Equal(expected.Length, resolved.SizeBytes);
            var body = await client.GetByteArrayAsync(resolved.StreamUrl);
            Assert.Equal(expected, body);
        }
    }

    [Fact]
    public async Task Stream_RangeRequest_InsideAPackEpisode_CrossesRarVolumeBoundary()
    {
        using var client = fixture.CreateClient();
        var episode3 = fixture.PackEpisodes[2];
        var resolved = await ResolveAsync(
            client, StreamarrServerFixture.SeasonPackReleaseId, StreamarrServerFixture.PackEpisodeWorkId(3));

        // A window straddling at least one RAR volume boundary inside E03.
        var from = StreamarrServerFixture.RarChunkSize - 20_000;
        var to = Math.Min(episode3.Length - 1, StreamarrServerFixture.RarChunkSize + 40_000);
        using var request = new HttpRequestMessage(HttpMethod.Get, resolved.StreamUrl);
        request.Headers.Range = new System.Net.Http.Headers.RangeHeaderValue(from, to);
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.PartialContent, response.StatusCode);
        var body = await response.Content.ReadAsByteArrayAsync();
        Assert.Equal(episode3[from..(int)(to + 1)], body);
    }

    [Fact]
    public async Task Resolve_PackWithoutTheRequestedEpisode_FailsInsteadOfGuessing()
    {
        using var client = fixture.CreateClient();

        // E04 is registered (the season directory has 4 episodes) but the pack only
        // carries E01-E03: strict selection must refuse to stream a wrong episode.
        var response = await client.PostAsJsonAsync(
            "/api/v1/resolve",
            new ResolveRequest
            {
                ReleaseId = StreamarrServerFixture.SeasonPackReleaseId,
                WorkId = StreamarrServerFixture.PackMissingEpisodeWorkId,
                Client = "tests",
            });

        Assert.Equal(HttpStatusCode.UnprocessableEntity, response.StatusCode);
        var error = await response.Content.ReadFromJsonAsync<ErrorResponse>();
        Assert.Equal("no_playable_file", error!.Error.Code);
    }

    // ------------------------------------------------- per-episode RAR sets in one NZB

    [Fact]
    public async Task Resolve_PerEpisodeSetsPack_PicksTheEpisodesOwnSet()
    {
        using var client = fixture.CreateClient();
        var episode1 = fixture.PackEpisodes[0];

        var resolved = await ResolveAsync(
            client,
            StreamarrServerFixture.SeasonPackSetsReleaseId,
            StreamarrServerFixture.PackEpisodeWorkId(1));

        Assert.Equal("ready", resolved.Status);
        Assert.Equal(episode1.Length, resolved.SizeBytes);
        Assert.NotNull(resolved.RunTimeTicks);
        Assert.InRange(
            resolved.RunTimeTicks!.Value,
            6 * TimeSpan.TicksPerSecond,
            10 * TimeSpan.TicksPerSecond);

        var body = await client.GetByteArrayAsync(resolved.StreamUrl);
        Assert.Equal(episode1, body);
    }
}
