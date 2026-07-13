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
}
