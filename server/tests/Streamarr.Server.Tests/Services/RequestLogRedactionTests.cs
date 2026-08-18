using Microsoft.AspNetCore.Http;

namespace Streamarr.Server.Tests.Services;

public sealed class RequestLogRedactionTests
{
    [Fact]
    public void CapabilityPathsNeverReachTheRequestLogProperty()
    {
        const string capability = "known-secret-capability";

        var stream = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/stream/{capability}"));
        var close = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/sessions/{capability}/close"));
        var repair = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/sessions/{capability}/repair"));
        var timeline = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/sessions/{capability}/timeline"));
        var admissionStatus = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/playback-sessions/{capability}"));
        var admissionClaim = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/playback-sessions/{capability}/claim"));
        var ephemeralPurge = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/ephemeral-files/{capability}/purge"));
        var streamHistory = StreamarrServerBootstrap.RedactRequestPath(
            new PathString($"/api/v1/streams/{capability}"));

        Assert.Equal("/api/v1/stream/{capability}", stream);
        Assert.Equal("/api/v1/sessions/{capability}/close", close);
        Assert.Equal("/api/v1/sessions/{capability}/repair", repair);
        Assert.Equal("/api/v1/sessions/{capability}/timeline", timeline);
        Assert.Equal("/api/v1/playback-sessions/{admission}", admissionStatus);
        Assert.Equal("/api/v1/playback-sessions/{admission}/claim", admissionClaim);
        Assert.Equal("/api/v1/ephemeral-files/{capability}/purge", ephemeralPurge);
        Assert.Equal("/api/v1/streams/{stream}", streamHistory);
        Assert.All(
            [stream, close, repair, timeline, admissionStatus, admissionClaim, ephemeralPurge, streamHistory],
            value => Assert.DoesNotContain(capability, value));
        Assert.Equal(
            "/api/v1/playback-sessions",
            StreamarrServerBootstrap.RedactRequestPath(new PathString("/api/v1/playback-sessions")));
        Assert.Equal(
            "/api/v1/ephemeral-files",
            StreamarrServerBootstrap.RedactRequestPath(new PathString("/api/v1/ephemeral-files")));
    }
}
