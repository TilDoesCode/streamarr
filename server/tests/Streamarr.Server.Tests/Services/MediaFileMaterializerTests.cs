using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Nntp;
using Streamarr.Usenet.Nntp.Pooling;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Tests.Services;

public class MediaFileMaterializerTests
{
    private static async Task<NzbDocument> ParseNzb(params PublishedNzbFile[] files)
    {
        var xml = NzbTestFixtures.BuildNzbXml(files);
        using var ms = new MemoryStream(System.Text.Encoding.UTF8.GetBytes(xml));
        return await NzbDocument.LoadAsync(ms);
    }

    private static MultiConnectionNntpClient ClientFor(MockNntpServer server) =>
        UsenetStreamingClient.CreateProviderClient(new()
        {
            Name = "mock",
            Host = server.Host,
            Port = server.Port,
            UseSsl = false,
            Username = server.Username,
            Password = server.Password,
            MaxConnections = 4,
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

        using var client = ClientFor(server);
        var materializer = new MediaFileMaterializer(
            client, Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()));
        var media = await materializer.MaterializeAsync(candidate, CancellationToken.None);

        Assert.Equal("video.mkv", media.FileName);
        Assert.Equal("mkv", media.Container);
        Assert.Equal(video.Length, media.SizeBytes);

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
}
