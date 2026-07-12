using Streamarr.Core.Sessions;

namespace Streamarr.Core.Tests.Sessions;

public class StreamSessionTests
{
    private static StreamSession Session(DateTimeOffset created, TimeSpan ttl) => new()
    {
        Token = "opaque-token",
        ReleaseId = "release-1",
        WorkId = "tmdb-movie-1",
        CreatedAt = created,
        TimeToLive = ttl,
        LastAccessedAt = created,
    };

    [Fact]
    public void ExpiresAt_ExtendsWithLastAccess()
    {
        var created = new DateTimeOffset(2026, 7, 12, 12, 0, 0, TimeSpan.Zero);
        var session = Session(created, TimeSpan.FromHours(1));

        Assert.Equal(created.AddHours(1), session.ExpiresAt);

        session.LastAccessedAt = created.AddMinutes(30);
        Assert.Equal(created.AddMinutes(90), session.ExpiresAt);
    }

    [Fact]
    public void NewSession_StartsOpening()
    {
        var session = Session(DateTimeOffset.UtcNow, TimeSpan.FromHours(1));
        Assert.Equal(SessionState.Opening, session.State);
        Assert.Equal(0, session.BytesServed);
    }
}
