using Streamarr.Core.Media;

namespace Streamarr.Core.Tests.Media;

public class WorkTests
{
    [Fact]
    public void Work_AggregatesRankedReleases()
    {
        var work = new Work
        {
            WorkId = "tmdb-movie-12345",
            MediaType = MediaType.Movie,
            Title = "Example",
            Year = 2021,
            TmdbId = 12345,
            ImdbId = "tt1234567",
            Releases =
            [
                new Release
                {
                    ReleaseId = "r1",
                    Title = "Example.2021.1080p.WEB-DL.x265.DDP5.1-GROUP",
                    Indexer = "indexerName",
                    SizeBytes = 5_368_709_120,
                    Score = 850,
                },
                new Release
                {
                    ReleaseId = "r2",
                    Title = "Example.2021.720p.HDTV.x264-OTHER",
                    Indexer = "indexerName",
                    SizeBytes = 1_073_741_824,
                    Score = 300,
                    Rejected = true,
                    RejectionReasons = ["sample: size implausibly small for runtime"],
                },
            ],
        };

        Assert.Equal(2, work.Releases.Count);
        Assert.True(work.Releases[0].Score > work.Releases[1].Score);
        Assert.Contains("sample", work.Releases[1].RejectionReasons[0]);
        Assert.Equal(ReleaseHealth.Unknown, work.Releases[0].Health);
    }
}
