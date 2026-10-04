using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Artwork;
using Streamarr.Server.Viewers.Catalog;

namespace Streamarr.Server.Tests.Viewers;

public sealed class ArtworkSizesTests
{
    [Theory]
    [InlineData("https://image.tmdb.org/t/p/w780/p.jpg")]
    [InlineData("https://image.tmdb.org/t/p/original/p.jpg")]
    [InlineData("https://image.tmdb.org/t/p/w185/p.jpg")]
    public void Posters_MapToTheTmdbPosterBuckets(string url)
    {
        var sizes = ArtworkSizes.Poster(url)!;
        Assert.Equal("https://image.tmdb.org/t/p/w185/p.jpg", sizes.Small);
        Assert.Equal("https://image.tmdb.org/t/p/w342/p.jpg", sizes.Medium);
        Assert.Equal("https://image.tmdb.org/t/p/w780/p.jpg", sizes.Large);
    }

    [Fact]
    public void Backdrops_And_Stills_MapToTheTmdbBackdropBuckets()
    {
        foreach (var sizes in new[] { ArtworkSizes.Backdrop("https://image.tmdb.org/t/p/w1280/b.jpg")!, ArtworkSizes.Still("https://image.tmdb.org/t/p/w1280/b.jpg")! })
        {
            Assert.Equal("https://image.tmdb.org/t/p/w300/b.jpg", sizes.Small);
            Assert.Equal("https://image.tmdb.org/t/p/w780/b.jpg", sizes.Medium);
            Assert.Equal("https://image.tmdb.org/t/p/w1280/b.jpg", sizes.Large);
        }
    }

    [Fact]
    public void Any_Host_In_The_Tmdb_Layout_Is_Sized_Only_In_Its_Path()
    {
        var sizes = ArtworkSizes.Backdrop("http://127.0.0.1:39300/devworld/art/t/p/w1280/x-t/p/w1280/.jpg")!;
        Assert.Equal("http://127.0.0.1:39300/devworld/art/t/p/w300/x-t/p/w1280/.jpg", sizes.Small);
    }

    [Theory]
    [InlineData("https://img.example/poster.jpg")]
    [InlineData("https://img.example/t/p/huge/poster.jpg")]
    [InlineData("data:image/png;base64,AAAA")]
    [InlineData("/relative/t/p/w780/poster.jpg")]
    public void Other_Urls_Are_Used_For_Every_Class(string url)
    {
        var sizes = ArtworkSizes.Poster(url)!;
        Assert.Equal((url, url, url), (sizes.Small, sizes.Medium, sizes.Large));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("  ")]
    public void Missing_Artwork_Has_No_Sizes(string? url) => Assert.Null(ArtworkSizes.Poster(url));

    [Fact]
    public void List_Items_Carry_Sizes_Next_To_Their_Urls()
    {
        var card = new CatalogItemDto
        {
            WorkId = "tmdb-movie-1", MediaType = "movie", TmdbId = 1, Title = "T",
            PosterUrl = "https://image.tmdb.org/t/p/w780/p.jpg", BackdropUrl = "https://image.tmdb.org/t/p/w1280/b.jpg",
        };
        Assert.Equal("https://image.tmdb.org/t/p/w185/p.jpg", card.PosterSizes!.Small);
        Assert.Equal("https://image.tmdb.org/t/p/w300/b.jpg", card.BackdropSizes!.Small);

        var nextUp = new NextUpItemResponse
        {
            WorkId = "e", SeriesWorkId = "s", SeriesTitle = "S", SeasonNumber = 1, EpisodeNumber = 1, EpisodeTitle = "E",
            LastWatchedWorkId = "e", LastActivityAt = DateTimeOffset.UnixEpoch, Available = true,
            SeriesPosterUrl = "https://image.tmdb.org/t/p/w780/p.jpg", StillUrl = "https://image.tmdb.org/t/p/w1280/s.jpg",
        };
        Assert.Equal("https://image.tmdb.org/t/p/w342/p.jpg", nextUp.SeriesPosterSizes!.Medium);
        Assert.Equal("https://image.tmdb.org/t/p/w300/s.jpg", nextUp.StillSizes!.Small);
        Assert.Null((nextUp with { StillUrl = null }).StillSizes);
    }
}
