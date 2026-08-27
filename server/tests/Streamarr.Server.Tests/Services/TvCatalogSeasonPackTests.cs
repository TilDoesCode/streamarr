using Streamarr.Core.Media;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

/// <summary>
/// Season packs surface as season-level works; the catalog overlays their accepted
/// releases onto every canonical episode. These cover the pure selection/merge logic.
/// </summary>
public class TvCatalogSeasonPackTests
{
    private static Release Release(string id, string title, int score = 500, bool rejected = false) => new()
    {
        ReleaseId = id,
        Title = title,
        Indexer = "mock",
        SizeBytes = 20_000_000_000,
        Score = score,
        Rejected = rejected,
    };

    private static Work SeasonWork(params Release[] releases) => new()
    {
        WorkId = "tmdb-tv-5-s01",
        MediaType = MediaType.Tv,
        Title = "Show",
        TmdbId = 5,
        Season = 1,
        Episode = null,
        Releases = releases,
    };

    [Fact]
    public void SeasonPackReleases_KeepsAcceptedPacks_OfTheRequestedSeason()
    {
        var pack = Release("pack-1", "Show.S01.1080p.BluRay.x264-GRP");
        var rejectedPack = Release("pack-2", "Show.S01.720p.WEB-DL-GRP", rejected: true);
        var episodeWork = new Work
        {
            WorkId = "tmdb-tv-5-s01e01",
            MediaType = MediaType.Tv,
            Title = "Show",
            TmdbId = 5,
            Season = 1,
            Episode = 1,
            Releases = [Release("ep-1", "Show.S01E01.1080p.WEB-DL-GRP")],
        };

        var result = TvCatalogService.SeasonPackReleases(
            [SeasonWork(pack, rejectedPack), episodeWork], tmdbId: 5, seasonNumber: 1);

        var release = Assert.Single(result);
        Assert.Equal("pack-1", release.ReleaseId);
    }

    [Fact]
    public void SeasonPackReleases_IgnoresEpisodelessBuckets_ThatAreNotPacks()
    {
        // A stray movie caught by a TV season query buckets as an episode-less TV work;
        // it must not be overlaid onto every episode of the season.
        var notAPack = SeasonWork(Release("movie-1", "Some.Movie.2020.1080p.BluRay.x264-GRP"));
        Assert.Empty(TvCatalogService.SeasonPackReleases([notAPack], tmdbId: 5, seasonNumber: 1));
    }

    [Fact]
    public void SeasonPackReleases_IgnoresOtherSeasonsAndOtherSeries()
    {
        var otherSeason = SeasonWork(Release("pack-1", "Show.S01.1080p.BluRay.x264-GRP"));
        Assert.Empty(TvCatalogService.SeasonPackReleases([otherSeason], tmdbId: 5, seasonNumber: 2));
        Assert.Empty(TvCatalogService.SeasonPackReleases([otherSeason], tmdbId: 6, seasonNumber: 1));
    }

    [Fact]
    public void SeasonPackReleases_DeduplicatesOneReleaseAcrossWorkBuckets()
    {
        var pack = Release("pack-1", "Show.S01.1080p.BluRay.x264-GRP");
        var result = TvCatalogService.SeasonPackReleases(
            [SeasonWork(pack), SeasonWork(pack)], tmdbId: 5, seasonNumber: 1);
        Assert.Single(result);
    }

    [Fact]
    public void MergeEpisodeReleases_RanksPacksAndEpisodeReleasesTogether_Deduplicated()
    {
        var episodeRelease = Release("ep-1", "Show.S01E01.1080p.WEB-DL-GRP", score: 400);
        var sharedId = Release("shared", "Show.S01E01.720p.WEB-DL-GRP", score: 300);
        var packHigh = Release("pack-1", "Show.S01.2160p.BluRay.x265-GRP", score: 900);
        var packDupe = Release("shared", "Show.S01.720p.WEB-DL-GRP", score: 999);

        var merged = TvCatalogService.MergeEpisodeReleases(
            [episodeRelease, sharedId], [packHigh, packDupe]).ToArray();

        Assert.Equal(["pack-1", "ep-1", "shared"], merged.Select(r => r.ReleaseId).ToArray());
        // the episode-specific registration wins the duplicate id
        Assert.Equal(300, merged[2].Score);
    }
}
