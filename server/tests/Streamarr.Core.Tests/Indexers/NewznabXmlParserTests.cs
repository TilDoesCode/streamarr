using Streamarr.Core.Indexers;

namespace Streamarr.Core.Tests.Indexers;

public class NewznabXmlParserTests
{
    [Fact]
    public void ParseSearch_ReadsItems_WithAttrsAndEnclosure()
    {
        var response = NewznabXmlParser.ParseSearch(NewznabFixtures.Load("alpha-search.xml"));

        // 3 valid items; the two junk rows (no title / no guid) are skipped
        Assert.Equal(3, response.Items.Count);
        Assert.Equal(4, response.Total);

        var first = response.Items[0];
        Assert.Equal("Example.Movie.2021.1080p.WEB-DL.x265.DDP5.1-GROUP", first.Title);
        Assert.Equal("a1", first.Guid);
        Assert.Equal(5368709120, first.SizeBytes);
        Assert.Equal(34, first.Grabs);
        Assert.Equal([2000, 2040], first.Categories);
        Assert.StartsWith("https://alpha.example/getnzb/a1.nzb", first.NzbUrl);
        Assert.Equal(new DateTimeOffset(2021, 6, 30, 11, 0, 0, TimeSpan.Zero), first.UsenetDate);
        Assert.Equal(new DateTimeOffset(2021, 6, 30, 12, 0, 0, TimeSpan.Zero), first.PublishDate);
    }

    [Fact]
    public void ParseSearch_FallsBackToEnclosureLength_WhenNoSizeAttr()
    {
        var response = NewznabXmlParser.ParseSearch(NewznabFixtures.Load("alpha-search.xml"));

        var item = response.Items.Single(i => i.Guid == "a3");
        Assert.Equal(3000000000, item.SizeBytes); // from enclosure length, no size attr
    }

    [Fact]
    public void ParseSearch_SkipsJunkItems_ButKeepsValidOnes()
    {
        var response = NewznabXmlParser.ParseSearch(NewznabFixtures.Load("alpha-search.xml"));

        Assert.DoesNotContain(response.Items, i => i.Guid == "junk-notitle");
        Assert.All(response.Items, i => Assert.False(string.IsNullOrWhiteSpace(i.Title)));
        Assert.All(response.Items, i => Assert.False(string.IsNullOrWhiteSpace(i.Guid)));
    }

    [Fact]
    public void ParseSearch_EmptyChannel_ReturnsNoItems()
    {
        var response = NewznabXmlParser.ParseSearch(NewznabFixtures.Load("empty-search.xml"));

        Assert.Empty(response.Items);
        Assert.Equal(0, response.Total);
    }

    [Fact]
    public void ParseSearch_Malformed_ThrowsNewznabParseException()
    {
        Assert.Throws<NewznabParseException>(
            () => NewznabXmlParser.ParseSearch(NewznabFixtures.Load("malformed.xml")));
    }

    [Fact]
    public void ParseSearch_NotRss_ThrowsNewznabParseException()
    {
        Assert.Throws<NewznabParseException>(
            () => NewznabXmlParser.ParseSearch("<html><body>rate limited</body></html>"));
    }

    [Fact]
    public void ParseCapabilities_ReadsServerLimitsSearchingAndCategories()
    {
        var caps = NewznabXmlParser.ParseCapabilities(NewznabFixtures.Load("caps.xml"));

        Assert.Equal("Alpha Indexer", caps.ServerTitle);
        Assert.Equal("1.1", caps.ServerVersion);
        Assert.Equal(100, caps.LimitMax);
        Assert.Equal(100, caps.LimitDefault);
        Assert.True(caps.SearchAvailable);
        Assert.True(caps.MovieSearchAvailable);
        Assert.True(caps.TvSearchAvailable);

        var movies = caps.Categories.Single(c => c.Id == 2000);
        Assert.Equal("Movies", movies.Name);
        Assert.Contains(movies.Subcategories, s => s.Id == 2040 && s.Name == "HD");
    }

    [Fact]
    public void ParseCapabilities_Malformed_Throws()
    {
        Assert.Throws<NewznabParseException>(() => NewznabXmlParser.ParseCapabilities("<notcaps/>"));
    }
}
