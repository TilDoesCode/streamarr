using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public class SessionManagerTests
{
    private static readonly byte[] Payload = Enumerable.Range(0, 4096).Select(i => (byte)i).ToArray();

    private static SessionManager Manager(int ttlSeconds = 300) => new(
        new FakeNntpClient(),
        Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { SessionTtlSeconds = ttlSeconds }),
        NullLogger<SessionManager>.Instance);

    private static ResolvedMediaFile MediaFile() => new()
    {
        FileName = "video.mkv",
        Container = "mkv",
        SizeBytes = Payload.Length,
        OpenStream = _ => new MemoryStream(Payload),
    };

    [Fact]
    public void CreateSession_IssuesUnguessableUniqueTokens()
    {
        var manager = Manager();
        var tokens = Enumerable.Range(0, 100)
            .Select(_ => manager.CreateSession("rel-1", "work-1", MediaFile(), null).Token)
            .ToList();

        Assert.All(tokens, t => Assert.Equal(48, t.Length)); // 192 bits as lowercase hex
        Assert.Equal(tokens.Count, tokens.Distinct().Count());
    }

    [Fact]
    public async Task OpenStream_ServesBytes_AndMetersThem()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), "web");

        await using var stream = manager.OpenStream(session);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(Payload, ms.ToArray());
        Assert.Equal(Payload.Length, session.BytesServed);
        Assert.Equal(Payload.Length, session.Session.BytesServed);
    }

    [Fact]
    public void TryGetSession_UnknownToken_IsFalse()
    {
        Assert.False(Manager().TryGetSession("nope", out _));
    }

    [Fact]
    public async Task CloseSession_TearsDown_AndCutsOffOpenStreams()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);
        await using var stream = manager.OpenStream(session);

        Assert.True(manager.CloseSession(session.Token));
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.False(manager.CloseSession(session.Token)); // idempotent-ish: second close reports missing

        var buffer = new byte[16];
        await Assert.ThrowsAsync<ObjectDisposedException>(
            () => stream.ReadAsync(buffer.AsMemory()).AsTask());
    }

    [Fact]
    public async Task SweepExpired_RemovesSessionsPastTheirSlidingTtl()
    {
        var manager = Manager(ttlSeconds: 0); // expires as soon as it is idle
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        await Task.Delay(20);
        Assert.Equal(1, manager.SweepExpired());
        Assert.False(manager.TryGetSession(session.Token, out _));
        Assert.Empty(manager.ListSessions());
    }

    [Fact]
    public void SweepExpired_KeepsLiveSessions()
    {
        var manager = Manager(ttlSeconds: 3600);
        manager.CreateSession("rel-1", "work-1", MediaFile(), null);

        Assert.Equal(0, manager.SweepExpired());
        Assert.Single(manager.ListSessions());
    }

    [Fact]
    public void ListSessions_ReportsUsage()
    {
        var manager = Manager();
        var session = manager.CreateSession("rel-1", "work-1", MediaFile(), "jellyfin");

        var listed = Assert.Single(manager.ListSessions());
        Assert.Equal(session.Token, listed.Token);
        Assert.Equal("jellyfin", listed.Session.Client);
        Assert.Equal(0, listed.NntpUsage.InFlight);
    }
}
