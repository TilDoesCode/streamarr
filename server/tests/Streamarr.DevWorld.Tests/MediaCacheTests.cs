namespace Streamarr.DevWorld.Tests;

public class MediaCacheTests
{
    [Fact]
    public async Task Ensure_PrunesMediaUnusedFor30Days_AndOldTempFiles_ButKeepsRecentOnes()
    {
        var cache = Directory.CreateTempSubdirectory("devworld-cache-").FullName;
        try
        {
            var options = new DevWorldOptions { CacheDir = cache, StateDir = Path.Combine(cache, "state"), CatalogPath = FakeWorld.CatalogPath };
            var media = Directory.CreateDirectory(options.MediaDir).FullName;
            Directory.CreateDirectory(Path.Combine(media, ".locks"));
            Directory.CreateDirectory(Path.Combine(media, ".tmp"));
            string Put(string relative, TimeSpan age)
            {
                var path = Path.Combine(media, relative);
                File.WriteAllText(path, "x");
                File.SetLastWriteTimeUtc(path, DateTime.UtcNow - age);
                return path;
            }

            var stale = Put("old__v-000000000000.mkv", TimeSpan.FromDays(60));
            var staleProbe = Put("old__v-000000000000.mkv.probe.json", TimeSpan.FromDays(31));
            var staleLock = Put(".locks/old__v-000000000000.mkv.lock", TimeSpan.FromDays(60));
            var recent = Put("recent__v-000000000000.mkv", TimeSpan.FromDays(60));
            var recentProbe = Put("recent__v-000000000000.mkv.probe.json", TimeSpan.FromDays(29));
            var oldTmp = Put(".tmp/crashed.mkv", TimeSpan.FromDays(2));
            var activeTmp = Put(".tmp/generating.mkv", TimeSpan.FromMinutes(5));
            var log = new List<string>();

            var result = await new MediaGenerator(options, log.Add).EnsureAsync([], CancellationToken.None);

            Assert.Empty(result);
            Assert.All([stale, staleProbe, staleLock, oldTmp], path => Assert.False(File.Exists(path), path));
            Assert.All([recent, recentProbe, activeTmp], path => Assert.True(File.Exists(path), path));
            Assert.Equal("pruned old__v-000000000000.mkv (unused for 30 days)", Assert.Single(log));
        }
        finally
        {
            Directory.Delete(cache, recursive: true);
        }
    }
}
