using Streamarr.Core.Media;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

public sealed class ViewerSearchRankingTests
{
    private static TmdbMatch Title(int id, string title, string? original = null, MediaType type = MediaType.Movie)
        => new() { MediaType = type, TmdbId = id, Title = title, OriginalTitle = original };

    private static int[] Ranked(string query, params TmdbMatch[] remote) => ViewerCatalogService.Ranked(query, remote).Select(m => m.TmdbId).ToArray();

    [Fact]
    public void Exact_Then_StartsWith_Then_WordPrefix_Then_The_Remaining_Remote_Results_In_Their_Order()
    {
        var remote = new[]
        {
            Title(1, "Lights Out"),
            Title(2, "Moonlight"),
            Title(3, "The Lighthouse Logs", type: MediaType.Tv),
            Title(4, "Light"),
            Title(5, "Northern Lighthouse"),
            Title(6, "Sunshine"),
        };

        Assert.Equal([4, 1, 3, 5, 2, 6], Ranked("light", remote));
    }

    [Fact]
    public void German_And_Original_Titles_Count_With_Umlauts_And_Hyphens()
    {
        var remote = new[]
        {
            Title(1, "Leuchtfeuer"),
            Title(2, "Die Leuchtturm-Chroniken", "The Lighthouse Logs", MediaType.Tv),
            Title(3, "Chronik einer Wächterin"),
        };

        Assert.Equal([1, 2, 3], Ranked("leucht", remote));
        Assert.Equal([3, 2, 1], Ranked("chron", remote));
        Assert.Equal([2, 1, 3], Ranked("the lighthouse lo", remote));
        Assert.Equal([3, 1, 2], Ranked("waechterin", remote));
    }

    [Fact]
    public void Broken_Text_In_A_Remote_Title_Or_The_Query_Never_Fails_The_Search()
    {
        var remote = new[] { Title(1, "Moon\uD800light"), Title(2, "Light\uDC00house") };

        Assert.Equal([2, 1], Ranked("light\uD800", remote));
    }

    [Fact]
    public void A_Multi_Word_Query_Needs_Every_Word()
        => Assert.Equal([2, 1], Ranked("lighthouse lo", Title(1, "The Lighthouse"), Title(2, "The Lighthouse Logs")));
}
