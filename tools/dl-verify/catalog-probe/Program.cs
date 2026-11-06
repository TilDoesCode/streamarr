using System.Text.Json;
using System.Net.Http.Json;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;

var root = Environment.GetEnvironmentVariable("DL_VERIFY_ROOT") ?? Directory.GetCurrentDirectory();
Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(root, "server/src/Streamarr.Server"));

// Only this process's fake indexer data changes; no repository fixtures are edited.
CatalogNewznabFake.PackReleases[0] = "Pack.Show.S01E01-E02.German.DL.AAC.1080p.NF.WEB.H264-snk";
CatalogNewznabFake.AffinityReleases[2] = "Affinity.Show.S01E02.2160p.UHD.BluRay.DDP5.1.HDR10.x265-ENGLISH";
CatalogNewznabFake.AffinityReleases[3] = "Affinity.Show.S01E02.German.720p.HDTV.AAC2.0.H.264-GERMAN";
CatalogNewznabFake.AffinityReleases[4] = "Affinity.Show.S01E02.German.720p.HDTV.AAC2.0.H.264-OTHER";
using var factory = new ViewerDownloadFactory();
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var (viewer, _, _) = await Dl.ViewerAsync(factory, admin, "catalog-verify");
using (viewer)
{
    var packs = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates/season", new { workId = "tmdb-tv-604-s01", device = Dl.AndroidTv });
    Console.WriteLine("PARTIAL_PACKS " + packs.GetProperty("packs"));
    var candidates = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = "tmdb-tv-603-s01e01", device = Dl.AndroidTv });
    var anchor = candidates.GetProperty("candidates").EnumerateArray().First(c => c.GetProperty("version").GetProperty("name").GetString()!.EndsWith("-ALPHA"));
    var plan = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan", new
    {
        anchorWorkId = "tmdb-tv-603-s01e01",
        anchorReleaseId = anchor.GetProperty("version").GetProperty("releaseId").GetString(),
        workIds = new[] { "tmdb-tv-603-s01e02" },
        device = Dl.AndroidTv, audioLanguages = new[] { "de" },
    });
    Console.WriteLine("LANGUAGE_PLAN " + plan);
}
