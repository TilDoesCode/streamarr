using System.Security.Cryptography;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers.Downloads;

namespace Streamarr.Server.Tests.Integration;

/// <summary>Device-download bytes over the real stack (mock NNTP, direct and RAR releases, season packs): identical across stream sessions, pinned while read.</summary>
[Collection("streamarr-server")]
public sealed class DownloadTransferIntegrationTests(StreamarrServerFixture fixture)
{
    private static async Task<byte[]> ReadAsync(IDownloadFileLease lease, long offset, long length)
    {
        await using var stream = lease.Open(offset);
        var buffer = new byte[length];
        var read = 0;
        while (read < length)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read));
            if (n == 0)
                break;
            read += n;
        }
        return buffer[..read];
    }

    private DownloadFileTarget Target(string releaseId, string workId, string fileName, long size, string viewer)
        => new($"dl-{Guid.NewGuid():N}", viewer, viewer, releaseId, workId, fileName, size);

    [Theory]
    [InlineData(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1")]
    [InlineData(StreamarrServerFixture.RarReleaseId, "tmdb-movie-2")]
    public async Task TheSameReleaseResolvedAgain_ServesIdenticalBytes(string releaseId, string workId)
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        var target = Target(releaseId, workId, "video.mkv", fixture.Video.Length, viewer);

        byte[] first;
        string firstToken;
        await using (var lease = await source.OpenAsync(target, CancellationToken.None))
        {
            first = await ReadAsync(lease, 0, fixture.Video.Length);
            firstToken = sessions.FindReusableSession(releaseId, workId, SessionManager.TransferClient, viewer)!.Token;
        }
        source.Release(releaseId, workId, viewer);
        Assert.Null(sessions.FindReusableSession(releaseId, workId, SessionManager.TransferClient, viewer));

        await using var again = await source.OpenAsync(target, CancellationToken.None);
        var tail = await ReadAsync(again, 100_000, fixture.Video.Length - 100_000);
        var secondToken = sessions.FindReusableSession(releaseId, workId, SessionManager.TransferClient, viewer)!.Token;

        Assert.NotEqual(firstToken, secondToken);
        Assert.Equal(SHA256.HashData(fixture.Video), SHA256.HashData(first));
        Assert.Equal(fixture.Video[100_000..], tail);
    }

    [Fact]
    public async Task AnEpisodeOfASeasonPack_IsItsOwnFile_AndTheSameOnEveryResolve()
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        var workId = StreamarrServerFixture.PackEpisodeWorkId(2);
        var sessions = fixture.GetRequiredService<SessionManager>();

        var unknownSize = await Assert.ThrowsAsync<DownloadSourceException>(
            () => source.OpenAsync(Target(StreamarrServerFixture.SeasonPackReleaseId, workId, "x", 1, viewer), CancellationToken.None));
        Assert.Equal("download_source_changed", unknownSize.Code);
        var session = sessions.FindReusableSession(StreamarrServerFixture.SeasonPackReleaseId, workId, SessionManager.TransferClient, viewer)!;
        Assert.Equal(fixture.PackEpisodes[1].Length, session.File.SizeBytes);

        var target = Target(StreamarrServerFixture.SeasonPackReleaseId, workId, session.File.FileName, session.File.SizeBytes, viewer);
        await using var lease = await source.OpenAsync(target, CancellationToken.None);
        Assert.Equal(fixture.PackEpisodes[1], await ReadAsync(lease, 0, session.File.SizeBytes));
    }

    [Fact]
    public async Task AWrongFile_IsRefused_InsteadOfServingOtherBytes()
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var target = Target(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", "video.mkv", fixture.Video.Length + 1, $"viewer-{Guid.NewGuid():N}");

        var refused = await Assert.ThrowsAsync<DownloadSourceException>(() => source.OpenAsync(target, CancellationToken.None));

        Assert.Equal("download_source_changed", refused.Code);
    }

    [Fact]
    public async Task ADeadRelease_IsGone_WithoutFallingBackToAnotherRelease()
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var target = Target(StreamarrServerFixture.DeadOnlyReleaseId, StreamarrServerFixture.DeadOnlyWorkId, "video.mkv", fixture.Video.Length, $"viewer-{Guid.NewGuid():N}");

        var gone = await Assert.ThrowsAsync<DownloadSourceException>(() => source.OpenAsync(target, CancellationToken.None));

        Assert.Equal("download_source_gone", gone.Code);
        Assert.Equal(410, gone.Status);
    }

    [Fact]
    public async Task TransferReads_BypassTheSharedArticleCache()
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var cache = fixture.GetRequiredService<Streamarr.Usenet.Streams.SegmentCache>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        var target = Target(StreamarrServerFixture.RarReleaseId, "tmdb-movie-2", "video.mkv", fixture.Video.Length, viewer);
        await using var lease = await source.OpenAsync(target, CancellationToken.None);
        var session = fixture.GetRequiredService<SessionManager>().FindReusableSession(StreamarrServerFixture.RarReleaseId, "tmdb-movie-2", SessionManager.TransferClient, viewer)!;
        var before = cache.GetGlobalStats();

        var half = await ReadAsync(lease, fixture.Video.Length / 2, fixture.Video.Length - fixture.Video.Length / 2);

        Assert.Equal(fixture.Video[(fixture.Video.Length / 2)..], half);
        Assert.True(session.IsPinned);
        Assert.Equal(before, cache.GetGlobalStats());
    }

    [Fact]
    public async Task AReleasedSession_ClosesWhenItsLastTransferEnds()
    {
        var source = fixture.GetRequiredService<IDownloadFileSource>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        var target = Target(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", "video.mkv", fixture.Video.Length, viewer);
        var lease = await source.OpenAsync(target, CancellationToken.None);
        var session = sessions.FindReusableSession(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", SessionManager.TransferClient, viewer)!;

        source.Release(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", viewer);
        Assert.False(session.IsClosed);
        Assert.Equal(fixture.Video[..1000], await ReadAsync(lease, 0, 1000));

        await lease.DisposeAsync();
        Assert.True(session.IsClosed);
        Assert.Null(sessions.FindReusableSession(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", SessionManager.TransferClient, viewer));
    }

    [Fact]
    public async Task APreparationsResolve_UsesTheDownloadShare_AndItsProbeIsNeverLive()
    {
        var resolver = fixture.GetRequiredService<Streamarr.Server.Viewers.Playback.IPlaybackResolver>();
        var share = fixture.GetRequiredService<DownloadConnectionGate>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var cache = fixture.GetRequiredService<Streamarr.Usenet.Streams.SegmentCache>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        var before = share.Acquisitions;

        Streamarr.Server.Contracts.ResolveResponse response;
        using (DownloadPreparation.Enter())
        {
            response = await resolver.ResolveAsync(
                new Streamarr.Server.Viewers.Playback.PlaybackResolveCall(StreamarrServerFixture.RarReleaseId, "tmdb-movie-2", viewer, viewer, false, SessionManager.TransferClient),
                new NoObserver(), CancellationToken.None);
        }

        Assert.Equal("ready", response.Status);
        Assert.True(share.Acquisitions > before, "the preparation's NNTP commands did not go through the download share");
        var session = sessions.FindReusableSession(StreamarrServerFixture.RarReleaseId, "tmdb-movie-2", SessionManager.TransferClient, viewer)!;
        var stats = cache.GetGlobalStats();
        var shareBefore = share.Acquisitions;
        await using (var probe = sessions.OpenStream(session))
        {
            var buffer = new byte[64 * 1024];
            Assert.True(await probe.ReadAsync(buffer) > 0);
            Assert.Equal(0, sessions.LiveStreams);
        }
        Assert.Equal(stats, cache.GetGlobalStats());
        Assert.True(share.Acquisitions > shareBefore || session.File.SegmentIds.Count == 0);
        sessions.CloseSession(session.Token);
    }

    [Fact]
    public async Task ATransferSessionsOwnStreamReads_AreNeverLive_AndSkipTheArticleCache()
    {
        var resolver = fixture.GetRequiredService<Streamarr.Server.Viewers.Playback.IPlaybackResolver>();
        var sessions = fixture.GetRequiredService<SessionManager>();
        var cache = fixture.GetRequiredService<Streamarr.Usenet.Streams.SegmentCache>();
        var viewer = $"viewer-{Guid.NewGuid():N}";
        await resolver.ResolveAsync(
            new Streamarr.Server.Viewers.Playback.PlaybackResolveCall(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", viewer, viewer, false, SessionManager.TransferClient),
            new NoObserver(), CancellationToken.None);
        var session = sessions.FindReusableSession(StreamarrServerFixture.DirectReleaseId, "tmdb-movie-1", SessionManager.TransferClient, viewer)!;
        var stats = cache.GetGlobalStats();

        await using (var probe = sessions.OpenStream(session))
        {
            var buffer = new byte[64 * 1024];
            Assert.True(await probe.ReadAsync(buffer) > 0);
            Assert.Equal(0, sessions.LiveStreams);
        }

        Assert.Equal(stats, cache.GetGlobalStats());
        sessions.CloseSession(session.Token);
    }

    private sealed class NoObserver : IResolveObserver
    {
        public void HopStarted(string releaseId, int hop)
        {
        }

        public void HopFinished(string releaseId, string status)
        {
        }
    }
}
