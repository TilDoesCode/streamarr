using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Models;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Nzb;
using Streamarr.Usenet.Yenc;

namespace Streamarr.Server.Tests.Services;

public class MediaFileMaterializerTests
{
    private static async Task<NzbDocument> ParseNzb(params PublishedNzbFile[] files)
    {
        var xml = NzbTestFixtures.BuildNzbXml(files);
        using var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        return await NzbDocument.LoadAsync(ms);
    }

    private static MultiConnectionNntpClient ClientFor(MockNntpServer server, int maxConnections = 4) =>
        UsenetStreamingClient.CreateProviderClient(new()
        {
            Name = "mock",
            Host = server.Host,
            Port = server.Port,
            UseSsl = false,
            Username = server.Username,
            Password = server.Password,
            MaxConnections = maxConnections,
        });

    [Fact]
    public async Task RarWrappedNzb_MaterializesTheInnerMediaFile_ByteIdentically()
    {
        var video = YencTestEncoder.LcgBytes(9, 400_000);
        await using var server = new MockNntpServer();
        var volumes = Rar4TestWriter.WriteMultiVolume("video", "video.mkv", video, 150_000);
        var files = volumes
            .Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"vol{i}"))
            .ToArray();
        var nzb = await ParseNzb(files);

        var candidate = MediaFileSelector.SelectPrimary(nzb);
        Assert.NotNull(candidate);
        Assert.True(candidate!.IsRarWrapped);
        Assert.Equal(3, candidate.Files.Count);

        using var client = ClientFor(server, maxConnections: 8);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));
        var media = await materializer.MaterializeAsync(candidate, CancellationToken.None);

        Assert.Equal("video.mkv", media.FileName);
        Assert.Equal("mkv", media.Container);
        Assert.Equal(video.Length, media.SizeBytes);
        // Volume probes must overlap, but the exact peak is scheduler-dependent.
        Assert.InRange(server.MaxObservedConnections, 2, 8);

        await using var stream = media.OpenStream(client);
        using var output = new MemoryStream();
        await stream.CopyToAsync(output);
        Assert.Equal(video, output.ToArray());
    }

    [Fact]
    public async Task DirectNzb_PrefersTheLargestMediaFile_AndIgnoresPar2()
    {
        var large = YencTestEncoder.LcgBytes(1, 120_000);
        var small = YencTestEncoder.LcgBytes(2, 30_000);
        await using var server = new MockNntpServer();
        var nzb = await ParseNzb(
            NzbTestFixtures.PublishFile(server, "sample.mkv", small, "small"),
            NzbTestFixtures.PublishFile(server, "video.mkv", large, "large"),
            NzbTestFixtures.PublishFile(server, "video.par2", small, "par2", publishArticle: _ => false));

        var candidate = MediaFileSelector.SelectPrimary(nzb);
        Assert.NotNull(candidate);
        Assert.False(candidate!.IsRarWrapped);
        Assert.Equal("video.mkv", candidate.DisplayName);

        // par2 segments never enter the health sample set (BRIEF §6.1 module 5)
        Assert.DoesNotContain(candidate.HealthSegmentIds, id => id.StartsWith("par2"));
        Assert.Contains(candidate.HealthSegmentIds, id => id.StartsWith("large"));
    }

    [Fact]
    public async Task NzbWithoutMedia_HasNoCandidate()
    {
        var junk = YencTestEncoder.LcgBytes(3, 5_000);
        await using var server = new MockNntpServer();
        var nzb = await ParseNzb(
            NzbTestFixtures.PublishFile(server, "readme.nfo", junk, "nfo"),
            NzbTestFixtures.PublishFile(server, "video.par2", junk, "par2"));

        Assert.Null(MediaFileSelector.SelectPrimary(nzb));
    }

    // ---------------------------------------------------------------- season packs

    private static readonly (string EntryName, byte[] Data)[] PackEntries =
    [
        ("Show.S01E01.mkv", YencTestEncoder.LcgBytes(21, 120_000)),
        ("Show.S01E02.mkv", YencTestEncoder.LcgBytes(22, 260_000)),
        ("Show.S01E03.mkv", YencTestEncoder.LcgBytes(23, 180_000)),
    ];

    private static async Task<(MediaFileCandidate Candidate, MockNntpServer Server)> PublishPack()
    {
        var server = new MockNntpServer();
        // 100 KB volumes: E02 and E03 both start mid-volume and span volume boundaries.
        var volumes = Rar4TestWriter.WriteMultiVolumePack("Show.S01.1080p", PackEntries, 100_000);
        var files = volumes
            .Select((v, i) => NzbTestFixtures.PublishFile(server, v.FileName, v.Bytes, $"packvol{i}"))
            .ToArray();
        var nzb = await ParseNzb(files);
        var candidate = MediaFileSelector.SelectForEpisode(nzb, new EpisodeTarget(1, 2), strict: true);
        Assert.NotNull(candidate);
        Assert.True(candidate!.IsRarWrapped);
        return (candidate, server);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task SeasonPackRar_MaterializesTheRequestedEpisode_ByteIdentically(int episode)
    {
        var (candidate, server) = await PublishPack();
        await using var _ = server;
        using var client = ClientFor(server, maxConnections: 8);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));

        var media = await materializer.MaterializeAsync(
            candidate, new EpisodeTarget(1, episode), strictEpisodeMatch: true, CancellationToken.None);

        var expected = PackEntries[episode - 1];
        Assert.Equal(expected.EntryName, media.FileName);
        Assert.Equal(expected.Data.Length, media.SizeBytes);

        await using var stream = media.OpenStream(client);
        using var output = new MemoryStream();
        await stream.CopyToAsync(output);
        Assert.Equal(expected.Data, output.ToArray());
    }

    [Fact]
    public async Task SeasonPackRar_SeeksIntoTheMiddleOfAnEpisode()
    {
        var (candidate, server) = await PublishPack();
        await using var _ = server;
        using var client = ClientFor(server, maxConnections: 8);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));

        var media = await materializer.MaterializeAsync(
            candidate, new EpisodeTarget(1, 2), strictEpisodeMatch: true, CancellationToken.None);

        await using var stream = media.OpenStream(client);
        stream.Seek(200_000, SeekOrigin.Begin); // crosses into a later RAR volume
        var tail = new byte[60_000];
        await stream.ReadExactlyAsync(tail);
        Assert.Equal(PackEntries[1].Data[200_000..260_000], tail);
    }

    [Fact]
    public async Task SeasonPackRar_StrictUnmatchedEpisode_ThrowsInsteadOfGuessing()
    {
        var (candidate, server) = await PublishPack();
        await using var _ = server;
        using var client = ClientFor(server, maxConnections: 8);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));

        await Assert.ThrowsAsync<NoPlayableFileException>(() => materializer.MaterializeAsync(
            candidate, new EpisodeTarget(2, 1), strictEpisodeMatch: true, CancellationToken.None));
    }

    [Fact]
    public async Task SeasonPackRar_WithoutTarget_KeepsLegacyLargestFileBehavior()
    {
        var (candidate, server) = await PublishPack();
        await using var _ = server;
        using var client = ClientFor(server, maxConnections: 8);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));

        var media = await materializer.MaterializeAsync(candidate, CancellationToken.None);

        Assert.Equal("Show.S01E02.mkv", media.FileName); // largest entry
    }

    [Fact]
    public async Task RarMaterialization_DisposesOpenedFirstBody_WhenSizeValidationFails()
    {
        var file = new NzbFile { Subject = "\"video.part01.rar\" yEnc" };
        file.Segments.Add(new NzbSegment
        {
            Number = 1,
            Bytes = 100,
            MessageId = "first@test",
        });
        var candidate = new MediaFileCandidate
        {
            DisplayName = "video.part01.rar",
            IsRarWrapped = true,
            Files = [file],
        };
        var openedBody = new TrackingYencStream();
        using var client = new OversizedRarNntpClient(openedBody, size: 101);
        var materializer = new MediaFileMaterializer(
            client,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                MaxMediaBytes = 100,
            }));

        await Assert.ThrowsAsync<InvalidDataException>(
            () => materializer.MaterializeAsync(candidate, CancellationToken.None));

        Assert.True(openedBody.IsDisposed);
    }

    private sealed class OversizedRarNntpClient(TrackingYencStream stream, long size) : NntpClientBase
    {
        public override Task<long> GetFileSizeAsync(NzbFile file, CancellationToken ct)
            => Task.FromResult(size);

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken)
            => Task.FromResult(new NntpDecodedBodyResponse
            {
                ResponseCode = 222,
                ResponseMessage = "222 body follows",
                SegmentId = segmentId,
                Stream = stream,
            });

        public override Task<NntpDecodedBodyResponse> DecodedBodyAsync(
            SegmentId segmentId,
            Action<ArticleBodyResult>? onConnectionReadyAgain,
            CancellationToken cancellationToken)
            => DecodedBodyAsync(segmentId, cancellationToken);

        public override Task ConnectAsync(
            string host,
            int port,
            bool useSsl,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpResponse> AuthenticateAsync(
            string user,
            string pass,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpStatResponse> StatAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpHeadResponse> HeadAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
            SegmentId segmentId,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpDecodedArticleResponse> DecodedArticleAsync(
            SegmentId segmentId,
            Action<ArticleBodyResult>? onConnectionReadyAgain,
            CancellationToken cancellationToken) => throw new NotSupportedException();

        public override Task<NntpDateResponse> DateAsync(CancellationToken cancellationToken)
            => throw new NotSupportedException();

        public override void Dispose()
        {
        }
    }

    private sealed class TrackingYencStream() : YencStream(Stream.Null)
    {
        public bool IsDisposed { get; private set; }

        protected override void Dispose(bool disposing)
        {
            IsDisposed = true;
            base.Dispose(disposing);
        }

        public override ValueTask DisposeAsync()
        {
            IsDisposed = true;
            return base.DisposeAsync();
        }
    }
}
