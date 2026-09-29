using Streamarr.Server.Viewers.Access;

namespace Streamarr.DevWorld.Tests;

public class WorldPlanTests
{
    [Fact]
    public void FixtureCatalog_BuildsAndCoversTheSpecifiedWorld()
    {
        var plan = WorldPlan.Build(DevCatalog.Load(FakeWorld.CatalogPath));
        var catalog = plan.Catalog;

        Assert.InRange(catalog.Movies.Count, 6, int.MaxValue);
        Assert.All(catalog.Movies, movie => Assert.InRange(movie.Releases.Count, 2, 5));
        Assert.InRange(catalog.Series.Count, 2, int.MaxValue);
        Assert.Contains(catalog.Series, s => s.Seasons.Count(season => season.Episodes.Any(e => e.Releases.Count > 0)) >= 2);
        Assert.All(
            catalog.Series.SelectMany(s => s.Seasons).Where(season => season.Episodes.Any(e => e.Releases.Count > 0)),
            season => Assert.InRange(season.Episodes.Count, 3, 6));

        var variants = plan.Releases.Select(r => r.Files[0].Media.Variant).ToList();
        Assert.Superset(new HashSet<string> { "h264", "hevc", "av1", "mpeg2video" }, variants.Select(v => v.Video.Codec).ToHashSet());
        Assert.Superset(new HashSet<string> { "aac", "eac3", "ac3", "dts", "truehd", "opus" }, variants.SelectMany(v => v.Audio).Select(a => a.Codec).ToHashSet());
        Assert.Contains(variants, v => v.Video.Hdr == "hdr10" && v.Video.BitDepth == 10);
        Assert.Contains(variants, v => v.Audio.Select(a => a.Language).Distinct().Count() >= 2
                                       && v.Subtitles.Any(s => s.Format == "ass") && v.Subtitles.Any(s => s.Forced));

        Assert.Contains(plan.Releases, r => r.Entry.Health == "dead");
        Assert.Contains(plan.Releases, r => r.Entry.Health == "degraded");
        Assert.Contains(plan.Releases, r => r.IsSeasonPack);
        Assert.Contains(catalog.Movies, m => ContentRatings.MinimumAge(m.OfficialRating) >= 16);
    }

    [Fact]
    public void ReleaseNameContradictingItsVariant_FailsTheBuild()
    {
        var catalog = DevCatalog.Load(FakeWorld.CatalogPath);
        var movie = catalog.Movies.First(m => m.Releases.Any(r => r.Variant == "mp4-h264-aac-1080p"));
        var release = movie.Releases.First(r => r.Variant == "mp4-h264-aac-1080p");
        var broken = catalog with { Movies = [movie with { Releases = [release with { Variant = "mp4-h264-aac-720p" }] }] };

        var error = Assert.Throws<InvalidDataException>(() => WorldPlan.Build(broken));

        Assert.Contains($"{release.Name}: resolution parses as '1080p' but the variant 'mp4-h264-aac-720p' is '720p'", error.Message);
    }

    [Fact]
    public void UnsupportedSchemaVersion_IsRejected()
    {
        var path = Path.Combine(Path.GetTempPath(), $"devworld-catalog-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, """{ "schemaVersion": 2 }""");
        try
        {
            var error = Assert.Throws<InvalidDataException>(() => DevCatalog.Load(path));
            Assert.Contains("schemaVersion 2", error.Message);
        }
        finally
        {
            File.Delete(path);
        }
    }
}
