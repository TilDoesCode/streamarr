using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Integration;

[Collection("streamarr-server")]
public sealed class PreDownloadResolveIntegrationTests(StreamarrServerFixture fixture)
{
    [Fact]
    public async Task ResolveForPreDownload_AfterLoopbackProbe_RemainsBackgroundUntilPlayback()
    {
        await ClearCachedProbeAsync();
        var resolve = fixture.GetRequiredService<ResolveService>();
        var sessions = fixture.GetRequiredService<SessionManager>();

        var response = await resolve.ResolveForPreDownloadAsync(
            StreamarrServerFixture.DirectReleaseId,
            "tmdb-movie-1",
            client: "pre-download-test",
            requestedById: "pre-download-probe-user",
            requestedByName: null,
            token => $"/api/v1/stream/{token}",
            token => $"{fixture.BaseUrl}/api/v1/stream/{token}",
            CancellationToken.None);
        var token = response.StreamUrl!.Split('/').Last();

        try
        {
            Assert.True(sessions.TryGetSession(token, out var session));
            Assert.Equal(EphemeralRetentionPriority.Background, session.RetentionPriority);
            Assert.NotNull(response.RunTimeTicks);
        }
        finally
        {
            sessions.CloseSession(token);
        }
    }

    private async Task ClearCachedProbeAsync()
    {
        var factory = fixture.GetRequiredService<IDbContextFactory<StreamarrDbContext>>();
        await using var db = await factory.CreateDbContextAsync();
        var cached = await db.CachedReleases.SingleOrDefaultAsync(
            release => release.ReleaseId == StreamarrServerFixture.DirectReleaseId);
        if (cached is null)
            return;

        cached.MediaProbeKey = null;
        cached.MediaProbeJson = null;
        cached.MediaProbeCachedAt = null;
        await db.SaveChangesAsync();
    }
}
