using System.Xml.Linq;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Tests;

public class PublicationStoreTests(FakeWorld world) : IClassFixture<FakeWorld>
{
    private static readonly XNamespace Nzb = "http://www.newzbin.com/DTD/2003/nzb";

    [Fact]
    public void DeadRelease_LacksEveryEvenArticle()
    {
        var files = world.WithHealth("dead").SelectMany(r => r.Files).ToList();

        Assert.NotEmpty(files);
        foreach (var file in files)
        {
            Assert.InRange(file.TotalParts, 2, int.MaxValue);
            for (var part = 1; part <= file.TotalParts; part++)
            {
                var present = part % 2 == 1;
                Assert.Equal(present, world.Store.Contains(file.MessageId(part)));
                Assert.Equal(present, world.Store.Get(file.MessageId(part)) is not null);
            }
        }
    }

    [Fact]
    public void DegradedRelease_HasAllArticles_AndDropsStatOfItsLastOne()
    {
        var file = Assert.Single(world.WithHealth("degraded")).Files.Single();

        Assert.InRange(file.TotalParts, 81, int.MaxValue);
        Assert.Empty(file.MissingParts);
        Assert.Equal([file.MessageId(file.TotalParts)], world.Store.StatDisconnectIds.ToArray());
        Assert.True(world.Store.Contains(file.MessageId(file.TotalParts)));
    }

    [Fact]
    public void ServedArticles_MatchTheNzb_AndEncodeTheCachedFile()
    {
        var release = Assert.Single(world.WithHealth("degraded"));
        var file = release.Files.Single();
        var bytes = File.ReadAllBytes(file.FilePath);
        var segments = XDocument.Load(release.NzbPath).Descendants(Nzb + "segment").ToList();

        Assert.Equal(file.TotalParts, segments.Count);
        foreach (var segment in segments)
        {
            var part = int.Parse(segment.Attribute("number")!.Value);
            var begin = (part - 1) * file.PartSize;
            var expected = YencTestEncoder.EncodePartSlice(
                bytes.AsSpan(begin, Math.Min(file.PartSize, bytes.Length - begin)), file.FileName, part, file.TotalParts, begin + 1, bytes.Length);

            var article = world.Store.Get(segment.Value);

            Assert.Equal(expected, article);
            Assert.Equal(long.Parse(segment.Attribute("bytes")!.Value), article!.Length);
        }
    }

    [Fact]
    public void SeasonPack_PublishesOneFilePerEpisode()
    {
        var pack = world.Store.Releases.First(r => r.Plan.IsSeasonPack);
        var season = ((SeriesEntry)pack.Plan.Title).Seasons.Single(s => s.SeasonNumber == pack.Plan.Season);

        Assert.Equal(season.Episodes.Count, pack.Files.Count);
        Assert.Equal(pack.Files.Count, XDocument.Load(pack.NzbPath).Descendants(Nzb + "file").Count());
        Assert.All(pack.Files, f => Assert.Matches(@"\.S\d\dE\d\d\.", f.FileName));
    }

    [Theory]
    [InlineData("not-a-message-id")]
    [InlineData("dw0000000000000000.1@devworld")]
    public void UnknownIds_AreMissing(string messageId)
    {
        Assert.False(world.Store.Contains(messageId));
        Assert.Null(world.Store.Get(messageId));
    }

    [Fact]
    public void PartNumbersOutsideTheFile_AreMissing()
    {
        var file = world.WithHealth("ready").First().Files[0];

        Assert.False(world.Store.Contains(file.MessageId(0)));
        Assert.False(world.Store.Contains(file.MessageId(file.TotalParts + 1)));
    }
}
