using Streamarr.Plugin.ScheduledTasks;

namespace Streamarr.Plugin.Tests;

public class EphemeralCleanupTests
{
    private static readonly DateTime Now = new(2026, 07, 13, 12, 0, 0, DateTimeKind.Utc);
    private static readonly TimeSpan Ttl = TimeSpan.FromHours(12);

    [Fact]
    public void Unknown_last_access_is_expired()
        => Assert.True(EphemeralCleanup.IsExpired(null, Now, Ttl));

    [Fact]
    public void Recently_accessed_is_not_expired()
        => Assert.False(EphemeralCleanup.IsExpired(Now.AddHours(-1), Now, Ttl));

    [Fact]
    public void Access_older_than_ttl_is_expired()
        => Assert.True(EphemeralCleanup.IsExpired(Now.AddHours(-13), Now, Ttl));

    [Fact]
    public void Access_exactly_at_ttl_boundary_is_not_expired()
        => Assert.False(EphemeralCleanup.IsExpired(Now - Ttl, Now, Ttl));

    [Fact]
    public void Restart_fallback_prefers_saved_then_created_timestamp()
    {
        var saved = Now.AddHours(-2);
        var created = Now.AddHours(-3);

        Assert.Equal(saved, EphemeralCleanup.ResolveLastAccess(null, saved, created));
        Assert.Equal(created, EphemeralCleanup.ResolveLastAccess(null, DateTime.MinValue, created));
        Assert.Null(EphemeralCleanup.ResolveLastAccess(null, DateTime.MinValue, DateTime.MinValue));
    }
}
