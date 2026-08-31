using System.Net;
using System.Net.Http.Json;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public class PlaybackRangesEndpointTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task ProgressHeartbeats_SurfaceAsAttributedWatchedRanges()
    {
        using var client = fixture.CreateClient();

        var playbackSessionId = $"play-{Guid.NewGuid():N}";
        // The 20 s seek slack accepts small position advances even when the posts land
        // milliseconds apart, so the folding is observable without wall-clock waits.
        await Post(client, playbackSessionId, "start", positionSeconds: 0);
        await Post(client, playbackSessionId, "progress", positionSeconds: 6);
        await Post(client, playbackSessionId, "progress", positionSeconds: 12);

        await client.AuthenticateAsAdminAsync();
        using var raw = await client.GetAsync("/api/v1/playback-ranges");
        Assert.True(raw.IsSuccessStatusCode, await raw.Content.ReadAsStringAsync());
        var ranges = await raw.Content.ReadFromJsonAsync<List<PlaybackRangeResponse>>();
        Assert.NotNull(ranges);
        var scope = Assert.Single(ranges!, r => r.PlaybackSessionId == playbackSessionId);

        Assert.Equal("work-playback-ranges", scope.WorkId);
        Assert.Equal(12 * TimeSpan.TicksPerSecond, scope.PositionTicks);
        Assert.Equal(40 * 60 * TimeSpan.TicksPerSecond, scope.DurationTicks);
        Assert.Equal("token-ranges", scope.LastSessionToken);
        var span = Assert.Single(scope.Ranges);
        Assert.Equal(0, span.StartTicks);
        Assert.Equal(12 * TimeSpan.TicksPerSecond, span.EndTicks);
        Assert.Equal("token-ranges", span.SessionToken);
    }

    [Fact]
    public async Task PlaybackRanges_RequireAdminAuthentication()
    {
        using var anonymous = fixture.CreateClient(authenticated: false);
        using var response = await anonymous.GetAsync("/api/v1/playback-ranges");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private static async Task Post(HttpClient client, string playbackSessionId, string kind, long positionSeconds)
    {
        using var response = await client.PostAsJsonAsync("/api/v1/events", new EventRequest
        {
            ReleaseId = "release-playback-ranges",
            WorkId = "work-playback-ranges",
            Event = kind,
            PositionTicks = positionSeconds * TimeSpan.TicksPerSecond,
            DurationTicks = 40 * 60 * TimeSpan.TicksPerSecond,
            SessionToken = "token-ranges",
            Source = "jellyfin",
            PlaybackSessionId = playbackSessionId,
            ExternalUserId = "user-ranges",
            ExternalUserName = "Mara",
            DeviceName = "Living Room TV",
        });
        Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
    }
}
