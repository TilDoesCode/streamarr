using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Core.Parser;
using Streamarr.Server.Tests.Viewers;
using Streamarr.Server.Tests.Viewers.Downloads;

Environment.SetEnvironmentVariable("ASPNETCORE_TEST_CONTENTROOT_STREAMARR_SERVER", Path.Combine(Directory.GetCurrentDirectory(), "server/src/Streamarr.Server"));
using var factory = new ViewerDownloadFactory();
// Different seasons isolate cache entries. Only this process's fake indexer changes.
var scenarios = new[]
{
    (10, "German.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.PROPER.1080p.WEB-DL.AAC2.0.H.264-ROOT", "English.PROPER.1080p.WEB-DL.AAC2.0.H.264-ROOT" }, "same_variant", "de"),
    (11, "German.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.720p.WEB-DL.AAC2.0.H.264-ROOT", "English.1080p.WEB-DL.AAC2.0.H.264-ROOT" }, "same_group", "de"),
    (12, "German.1080p.WEB-DL.AAC2.0.H.264-ANCHOR", new[] { "German.720p.HDTV.AAC2.0.H.264-OTHER", "English.2160p.UHD.BluRay.DDP5.1.HDR10.x265-PICTURE" }, "best_available", "de"),
    (13, "French.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.720p.HDTV.AAC2.0.H.264-OTHER", "English.2160p.UHD.BluRay.DDP5.1.HDR10.x265-PICTURE" }, "best_available", "de"),
    (14, "German.DL.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.DL.1080p.WEB-DL.AAC2.0.H.264-ROOT", "German.English.DL.1080p.WEB-DL.AAC2.0.H.264-ROOT" }, "same_release", "de"),
    (15, "German.English.DL.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.DL.1080p.WEB-DL.AAC2.0.H.264-ROOT", "English.1080p.WEB-DL.AAC2.0.H.264-ROOT" }, "same_variant", "en"),
    (16, "German.1080p.WEB-DL.DTS5.1.H.264-ROOT", new[] { "German.1080p.WEB-DL.DTS5.1.H.264-ROOT", "English.720p.HDTV.AAC2.0.H.264-OTHER" }, "best_available", "en"),
    (17, "French.1080p.WEB-DL.AAC2.0.H.264-ROOT", new[] { "German.720p.HDTV.AAC2.0.H.264-OTHER", "English.2160p.UHD.BluRay.DDP5.1.HDR10.x265-PICTURE" }, "best_available", "en"),
};
foreach (var (season, anchor, targets, _, _) in scenarios)
{
    factory.Tmdb.SeasonOverrides[(603, season)] = [(1, "2021-01-01"), (2, "2021-01-08")];
    factory.Newznab.Extra[(603, season)] = targets.Select(t => ($"Affinity.Show.S{season:00}E02.{t}", 2_000_000_000L)).ToArray();
}
using var admin = await factory.AdminAsync();
(await admin.PutAsJsonAsync("/api/v1/config/viewers/settings", new { enabled = true })).EnsureSuccessStatusCode();
var (viewer, _, _) = await Dl.ViewerAsync(factory, admin, "plan-language-probe");
using var viewerScope = viewer;
var total = 0;
var failed = 0;
void Check(string name, bool ok, object data)
{
    total++;
    if (!ok) failed++;
    Console.WriteLine("ASSERT " + JsonSerializer.Serialize(new { name, passed = ok, data }));
}
string Name(JsonElement c) => c.GetProperty("version").GetProperty("name").GetString()!;
string[] Codes(JsonElement i) => i.GetProperty("notes").EnumerateArray().Select(x => x.GetProperty("code").GetString()!).ToArray();
foreach (var (season, anchor, targets, expectedMatch, expectedPrimary) in scenarios)
{
    var work = $"tmdb-tv-603-s{season:00}e01";
    var target = $"tmdb-tv-603-s{season:00}e02";
    var anchorName = $"Affinity.Show.S{season:00}E01.{anchor}";
    // Registered but deliberately absent from indexer/candidate list.
    var anchorId = factory.Releases.Register(work, anchorName);
    var preferred = season == 17 ? new[] { "ja" } : season is 13 or 16 ? new[] { "de" } : new[] { expectedPrimary == "de" ? "en" : "de" };
    var before = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = work, device = Dl.AndroidTv });
    Check($"s{season} anchor absent from candidates", !before.GetProperty("candidates").EnumerateArray().Any(c => c.GetProperty("version").GetProperty("releaseId").GetString() == anchorId), new { anchorName });
    var plan = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan", new { anchorWorkId = work, anchorReleaseId = anchorId, workIds = new[] { target }, device = Dl.AndroidTv, audioLanguages = preferred });
    var item = plan.GetProperty("items")[0];
    var picked = Name(item.GetProperty("candidate"));
    var primary = ReleaseParser.Parse(picked).Languages.FirstOrDefault() ?? "untagged";
    var anchorPrimary = ReleaseParser.Parse(anchorName).Languages.FirstOrDefault() ?? "untagged";
    var notes = Codes(item);
    Check($"s{season} language and match", primary == expectedPrimary && item.GetProperty("match").GetString() == expectedMatch && notes.Contains("language_differs") == (primary != anchorPrimary), new { anchorLanguages = ReleaseParser.Parse(anchorName).Languages, preferred, picked, primary, match = item.GetProperty("match").GetString(), notes });
    if (season == 16)
    {
        var candidates = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates", new { workId = target, device = Dl.AndroidTv });
        Check("unplayable anchor language is excluded", candidates.GetProperty("candidates").EnumerateArray().Where(c => Name(c).Contains("German")).All(c => !c.GetProperty("offline").GetProperty("playable").GetBoolean()), new { picked });
    }
}
// Packs participate in the same affinity/classification rules as single episodes.
var packs = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/candidates/season", new { workId = "tmdb-tv-604-s01", device = Dl.AndroidTv, audioLanguages = new[] { "en" } });
var pack = packs.GetProperty("packs").EnumerateArray().First(c => Name(c).Contains("1080p"));
var packPlan = await Dl.PostAsync(viewer, "/api/v1/viewer/downloads/plan", new { anchorWorkId = "tmdb-tv-604-s01e01", anchorReleaseId = pack.GetProperty("version").GetProperty("releaseId").GetString(), workIds = new[] { "tmdb-tv-604-s01e03" }, device = Dl.AndroidTv, audioLanguages = new[] { "en" } });
var packItem = packPlan.GetProperty("items")[0];
Check("pack remains same_release in anchor primary", packItem.GetProperty("match").GetString() == "same_release" && packItem.GetProperty("candidate").GetProperty("seasonPack").GetBoolean() && !Codes(packItem).Contains("language_differs"), new { picked = Name(packItem.GetProperty("candidate")), match = packItem.GetProperty("match").GetString() });
using var unknown = await viewer.PostAsJsonAsync("/api/v1/viewer/downloads/plan", new { anchorWorkId = "tmdb-tv-603-s02e01", anchorReleaseId = "unknown-anchor", workIds = new[] { "tmdb-tv-603-s02e02" }, device = Dl.AndroidTv });
Check("unknown anchor returns controlled 404", (int)unknown.StatusCode == 404, new { status = (int)unknown.StatusCode });
Console.WriteLine($"TOTAL {total - failed}/{total}");
Environment.ExitCode = failed == 0 ? 0 : 1;
