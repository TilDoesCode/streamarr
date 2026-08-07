using Streamarr.Server.Services.Repair;

namespace Streamarr.Server.Tests.Services.Repair;

public class RepairCoordinatorBookkeepingTests
{
    [Fact]
    public void ReleaseMappings_AreStrictlyBoundedAndUseLruEviction()
    {
        var time = new RepairTestSupport.ManualTime();
        var bookkeeping = new RepairCoordinatorBookkeeping(maxEntries: 2, time);
        bookkeeping.RegisterRelease("release-a", "aaaaaaaaaaaaaaaa");
        time.Advance(TimeSpan.FromSeconds(1));
        bookkeeping.RegisterRelease("release-b", "bbbbbbbbbbbbbbbb");
        time.Advance(TimeSpan.FromSeconds(1));
        Assert.True(bookkeeping.TryGetFingerprint("release-a", out _));
        time.Advance(TimeSpan.FromSeconds(1));

        bookkeeping.RegisterRelease("release-c", "cccccccccccccccc");

        Assert.Equal(2, bookkeeping.ReleaseCount);
        Assert.True(bookkeeping.TryGetFingerprint("release-a", out _));
        Assert.False(bookkeeping.TryGetFingerprint("release-b", out _));
        Assert.True(bookkeeping.TryGetFingerprint("release-c", out _));
    }

    [Fact]
    public void ActiveMappings_CanTemporarilyExceedTheCap_ThenCompletionTrimsInactiveEntries()
    {
        var time = new RepairTestSupport.ManualTime();
        var bookkeeping = new RepairCoordinatorBookkeeping(maxEntries: 2, time);
        var active = new HashSet<string>(StringComparer.Ordinal);

        foreach (var suffix in new[] { "a", "b", "c" })
        {
            var fingerprint = new string(suffix[0], 16);
            active.Add(fingerprint);
            bookkeeping.RegisterRelease(
                $"release-{suffix}",
                fingerprint,
                active.Contains);
            time.Advance(TimeSpan.FromSeconds(1));
        }

        Assert.Equal(3, bookkeeping.ReleaseCount);
        Assert.True(bookkeeping.TryGetFingerprint("release-a", out _));
        Assert.True(bookkeeping.TryGetFingerprint("release-b", out _));
        Assert.True(bookkeeping.TryGetFingerprint("release-c", out _));

        active.Remove("aaaaaaaaaaaaaaaa");
        bookkeeping.TrimReleaseMappings(active.Contains);

        Assert.Equal(2, bookkeeping.ReleaseCount);
        Assert.False(bookkeeping.TryGetFingerprint("release-a", out _));
        Assert.True(bookkeeping.TryGetFingerprint("release-b", out _));
        Assert.True(bookkeeping.TryGetFingerprint("release-c", out _));
    }

    [Fact]
    public void FailureBackoffs_AreBoundedAndExpiredEntriesAreSwept()
    {
        var time = new RepairTestSupport.ManualTime();
        var bookkeeping = new RepairCoordinatorBookkeeping(maxEntries: 2, time);
        bookkeeping.RecordFailure("aaaaaaaaaaaaaaaa", TimeSpan.FromMinutes(1));
        bookkeeping.RecordFailure("bbbbbbbbbbbbbbbb", TimeSpan.FromMinutes(2));
        bookkeeping.RecordFailure("cccccccccccccccc", TimeSpan.FromMinutes(3));

        Assert.Equal(2, bookkeeping.FailureCount);
        Assert.False(bookkeeping.IsFailureBlocked("aaaaaaaaaaaaaaaa"));
        Assert.True(bookkeeping.IsFailureBlocked("bbbbbbbbbbbbbbbb"));
        Assert.True(bookkeeping.IsFailureBlocked("cccccccccccccccc"));

        time.Advance(TimeSpan.FromMinutes(2));

        Assert.Equal(1, bookkeeping.FailureCount);
        Assert.False(bookkeeping.IsFailureBlocked("bbbbbbbbbbbbbbbb"));
        Assert.True(bookkeeping.IsFailureBlocked("cccccccccccccccc"));
    }
}
