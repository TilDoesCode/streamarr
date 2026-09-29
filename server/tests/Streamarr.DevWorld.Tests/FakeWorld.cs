using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Tests;

/// <summary>The real fixture catalog published over small synthetic media files (no ffmpeg) in a temp directory.</summary>
public sealed class FakeWorld : IDisposable
{
    public const int FileSize = 400_000;

    public string Root { get; } = Directory.CreateTempSubdirectory("devworld-tests-").FullName;
    public WorldPlan Plan { get; }
    public IReadOnlyDictionary<string, GeneratedMedia> Media { get; }
    public PublicationStore Store { get; }

    public FakeWorld()
    {
        Plan = WorldPlan.Build(DevCatalog.Load(CatalogPath));
        var mediaDir = Directory.CreateDirectory(Path.Combine(Root, "media")).FullName;
        var seed = 0;
        Media = Plan.Media.ToDictionary(m => m.Key, m =>
        {
            var path = Path.Combine(mediaDir, MediaGenerator.FileNameFor(m));
            File.WriteAllBytes(path, YencTestEncoder.LcgBytes(++seed, FileSize));
            var probe = new MediaProbe { FormatName = "synthetic", DurationSeconds = m.DurationSeconds };
            return new GeneratedMedia(path, FileSize, probe, Reused: true);
        });
        Store = new PublicationStore(Plan, Media, Path.Combine(Root, "nzb"), Plan.Catalog.Defaults.PartSizeBytes);
    }

    public static string CatalogPath => Path.Combine(AppContext.BaseDirectory, "fixtures", "catalog.json");

    public IEnumerable<PublishedRelease> WithHealth(string health) => Store.Releases.Where(r => r.Plan.Entry.Health == health);

    public void Dispose()
    {
        Store.Dispose();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { }
    }
}
