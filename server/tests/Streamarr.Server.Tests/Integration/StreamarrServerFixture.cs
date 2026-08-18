using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Server.Services;
using Streamarr.Tests.Shared;

namespace Streamarr.Server.Tests.Integration;

/// <summary>
/// Boots the real Core Server on a real Kestrel port (ffprobe must be able to hit
/// the stream URL over HTTP) against an in-process mock NNTP server. A small real
/// mkv is generated with ffmpeg at fixture setup and published four ways: direct,
/// RAR-wrapped (stored, multi-volume), with one missing article, and
/// with most articles missing (dead).
/// </summary>
public sealed class StreamarrServerFixture : IAsyncLifetime
{
    public const string ApiKey = "test-api-key-aaaaaaaaaaaaaaaaaaaa";

    public const string DirectReleaseId = "rel-direct";
    public const string RarReleaseId = "rel-rar";
    public const string SingleHoleReleaseId = "rel-single-hole";
    public const string SingleHoleFallbackReleaseId = "rel-single-hole-fallback";
    public const string SingleHoleWorkId = "tmdb-movie-3";
    public const string DeadReleaseId = "rel-dead";
    public const string FallbackReleaseId = "rel-fallback";
    public const string DeadWorkId = "tmdb-movie-9";

    public const string ProbeHoleReleaseId = "rel-probe-hole";
    public const string ProbeHoleFallbackReleaseId = "rel-probe-hole-fallback";
    public const string ProbeHoleWorkId = "tmdb-movie-11";

    // A work whose only release is dead — auto-fallback has nothing to fall back to.
    public const string DeadOnlyReleaseId = "rel-dead-only";
    public const string DeadOnlyWorkId = "tmdb-movie-10";

    // Runtime-repairable: STAT lies (223) for one mid-file article whose BODY 430s only
    // during playback (beyond ffprobe's resolve-time reads); a PAR2 set provides parity.
    // No sibling release exists, so repair — not fallback — is the only way out.
    public const string RepairableReleaseId = "rel-repairable";
    public const string RepairableWorkId = "tmdb-movie-20";

    // Same shape, but the damage exceeds the recovery slice count (insufficient parity).
    public const string UnrepairableReleaseId = "rel-unrepairable";
    public const string UnrepairableWorkId = "tmdb-movie-21";

    // Independently fingerprinted copy of the repairable shape for the concurrency/load
    // test: many overlapping readers must share exactly one repair job.
    public const string RaceRepairableReleaseId = "rel-repairable-race";
    public const string RaceRepairableWorkId = "tmdb-movie-22";

    // Healthy release whose first article can be gated (BodyGates) to simulate an
    // artificially slow Core prepare for the two-phase admission tests.
    public const string SlowOpenReleaseId = "rel-slow-open";
    public const string SlowOpenWorkId = "tmdb-movie-23";

    public const string AmbiguousPar2ReleaseId = "rel-ambiguous-par2";
    public const string AmbiguousPar2WorkId = "tmdb-movie-24";

    public const string EmbeddedPar2ReleaseId = "rel-embedded-par2";
    public const string EmbeddedPar2WorkId = "tmdb-movie-25";

    /// <summary>RAR volume chunk size — range tests cross this boundary on purpose.</summary>
    public const int RarChunkSize = 150_000;

    public byte[] Video { get; private set; } = null!;

    /// <summary>Longer media used by the repair scenarios (damage must sit beyond ffprobe's reads).</summary>
    public byte[] RepairVideo { get; private set; } = null!;

    /// <summary>Decoded byte range of the repairable release's damaged article.</summary>
    public (long Start, long End) RepairHole { get; private set; }

    /// <summary>Decoded byte range of the race-repairable release's damaged article.</summary>
    public (long Start, long End) RaceRepairHole { get; private set; }

    /// <summary>First article of the slow-open release — gate it via Nntp.BodyGates.</summary>
    public string SlowOpenFirstSegmentId { get; private set; } = null!;

    public MockNntpServer Nntp { get; private set; } = null!;
    public string BaseUrl { get; private set; } = null!;

    private WebApplication _app = null!;
    private string _tempDir = null!;

    public HttpClient CreateClient(bool authenticated = true)
    {
        var client = new HttpClient { BaseAddress = new Uri(BaseUrl), Timeout = TimeSpan.FromMinutes(2) };
        if (authenticated)
            client.DefaultRequestHeaders.Authorization = new("Bearer", ApiKey);
        return client;
    }

    public T GetRequiredService<T>() where T : notnull
        => _app.Services.GetRequiredService<T>();

    public async Task InitializeAsync()
    {
        _tempDir = Directory.CreateTempSubdirectory("streamarr-it-").FullName;
        Video = await TestMediaFile.GenerateMkvAsync(durationSeconds: 30);
        RepairVideo = await TestMediaFile.GenerateMkvAsync(durationSeconds: 150);
        Nntp = new MockNntpServer { RequireAuth = true };

        // --- publish the four flavors of the same video ---------------------------------

        // 1) direct mkv + an unpublished par2 decoy (must never be selected or sampled)
        var direct = NzbTestFixtures.PublishFile(Nntp, "video.mkv", Video, "direct");
        var directNzb = WriteNzb("direct.nzb", direct, Par2Decoy("direct"));

        // 2) the same mkv wrapped in a stored multi-volume RAR4 set
        var rarVolumes = Rar4TestWriter.WriteMultiVolume("video", "video.mkv", Video, RarChunkSize);
        var rarFiles = rarVolumes
            .Select((v, i) => NzbTestFixtures.PublishFile(Nntp, v.FileName, v.Bytes, $"rar-vol{i}"))
            .ToList();
        var rarNzb = WriteNzb("rar.nzb", [.. rarFiles, Par2Decoy("rar")]);

        // 3) STAT claims one startup article exists although BODY returns 430.
        var singleHole = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "single-hole", publishArticle: i => i != 4);
        Nntp.StatOnlyArticles.TryAdd(singleHole.SegmentIds[4], 0);
        var singleHoleNzb = WriteNzb("single-hole.nzb", singleHole);
        var singleHoleFallback = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "single-hole-fallback");
        var singleHoleFallbackNzb = WriteNzb("single-hole-fallback.nzb", singleHoleFallback);

        // 4) dead: only the first article survives
        var dead = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "dead", publishArticle: i => i == 0);
        var deadNzb = WriteNzb("dead.nzb", dead);

        // 5) fallback: a healthy sibling release of the same work as the dead one
        var fallback = NzbTestFixtures.PublishFile(Nntp, "video.mkv", Video, "fallback");
        var fallbackNzb = WriteNzb("fallback.nzb", fallback);

        // 6) dead-only: a work whose sole release is dead (auto-fallback exhausts)
        var deadOnly = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "dead-only", publishArticle: i => i == 0);
        var deadOnlyNzb = WriteNzb("dead-only.nzb", deadOnly);

        // 7) an unsampled hole inside ffprobe's initial read must still become dead + fallback.
        var probeHole = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "probe-hole", partSize: 1024);
        var sampled = HealthChecker.SelectSamples(probeHole.SegmentIds, 24, 8)
            .ToHashSet(StringComparer.Ordinal);
        var probeMissingId = probeHole.SegmentIds.Skip(8).First(id => !sampled.Contains(id));
        if (!Nntp.Articles.TryRemove(probeMissingId, out _))
            throw new InvalidOperationException("Could not create the probe-time missing-article fixture.");
        var probeHoleNzb = WriteNzb("probe-hole.nzb", probeHole);
        var probeHoleFallback = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", Video, "probe-hole-fallback");
        var probeHoleFallbackNzb = WriteNzb("probe-hole-fallback.nzb", probeHoleFallback);

        // 8) runtime-repairable: one mid-file article STATs 223 but BODYs 430, sitting far
        //    beyond ffprobe's resolve-time reads. A real PAR2 set rides along in the NZB.
        var repairable = NzbTestFixtures.PublishFile(Nntp, "video.mkv", RepairVideo, "repairable");
        var damagedIndex = Math.Max(9, repairable.SegmentIds.Length * 3 / 5);
        Nntp.Articles.TryRemove(repairable.SegmentIds[damagedIndex], out _);
        Nntp.StatOnlyArticles.TryAdd(repairable.SegmentIds[damagedIndex], 0);
        RepairHole = (damagedIndex * 64_000L, Math.Min((damagedIndex + 1) * 64_000L, RepairVideo.Length));
        var par2Set = Par2TestWriter.Create(
            [("video.mkv", RepairVideo)],
            sliceSize: 65_536,
            recoverySliceCount: 4,
            recoverySlicesPerVolume: 4);
        var unrelatedPar2 = Par2TestWriter.Create(
            [("unrelated.txt", YencTestEncoder.LcgBytes(7, 128))],
            sliceSize: 64,
            recoverySliceCount: 1);
        var repairableNzb = WriteNzb(
            "repairable.nzb",
            repairable,
            NzbTestFixtures.PublishFile(Nntp, "unrelated.par2", unrelatedPar2.IndexBytes, "repairable-unrelated"),
            NzbTestFixtures.PublishFile(
                Nntp,
                "video.vol00+01.par2",
                new byte[] { 0x50, 0x41, 0x52, 0x32 },
                "repairable-invalid-vol"),
            NzbTestFixtures.PublishFile(Nntp, "video.vol00+04.par2", par2Set.Volumes[0].Bytes, "repairable-vol0"));

        // 9) unrepairable: six damaged articles spread far apart damage more slices than
        //    the two surviving recovery slices can fix (insufficient parity).
        var unrepairable = NzbTestFixtures.PublishFile(Nntp, "video.mkv", RepairVideo, "unrepairable");
        var spread = unrepairable.SegmentIds.Length / 8;
        foreach (var offset in Enumerable.Range(2, 6))
        {
            var index = Math.Min(unrepairable.SegmentIds.Length - 1, Math.Max(9, offset * spread));
            Nntp.Articles.TryRemove(unrepairable.SegmentIds[index], out _);
            Nntp.StatOnlyArticles.TryAdd(unrepairable.SegmentIds[index], 0);
        }
        var thinPar2 = Par2TestWriter.Create([("video.mkv", RepairVideo)], sliceSize: 65_536, recoverySliceCount: 2);
        var unrepairableNzb = WriteNzb(
            "unrepairable.nzb",
            unrepairable,
            NzbTestFixtures.PublishFile(Nntp, "video.par2", thinPar2.IndexBytes, "unrepairable-par2idx"),
            NzbTestFixtures.PublishFile(Nntp, thinPar2.Volumes[0].Name, thinPar2.Volumes[0].Bytes, "unrepairable-vol0"));

        // 10) concurrency fixture: identical shape to (8) but distinct message-ids, so it
        //     owns its own fingerprint and repair job.
        var race = NzbTestFixtures.PublishFile(Nntp, "video.mkv", RepairVideo, "race-repairable");
        var raceDamaged = Math.Max(9, race.SegmentIds.Length * 3 / 5);
        Nntp.Articles.TryRemove(race.SegmentIds[raceDamaged], out _);
        Nntp.StatOnlyArticles.TryAdd(race.SegmentIds[raceDamaged], 0);
        RaceRepairHole = (raceDamaged * 64_000L, Math.Min((raceDamaged + 1) * 64_000L, RepairVideo.Length));
        var racePar2Volumes = Enumerable.Range(0, 17)
            .Select(index => NzbTestFixtures.PublishFile(
                Nntp,
                $"video.vol{index:00}+04.par2",
                par2Set.Volumes[0].Bytes,
                $"race-vol{index}"))
            .ToArray();
        var raceNzb = WriteNzb(
            "race-repairable.nzb",
            [
                race,
                NzbTestFixtures.PublishFile(Nntp, "video.par2", par2Set.IndexBytes, "race-par2idx"),
                .. racePar2Volumes,
            ]);

        // 11) healthy, but its first article can be gated to hold a resolve open at will.
        var slowOpen = NzbTestFixtures.PublishFile(Nntp, "video.mkv", Video, "slow-open");
        SlowOpenFirstSegmentId = slowOpen.SegmentIds[0];
        var slowOpenNzb = WriteNzb("slow-open.nzb", slowOpen);

        // 12) two independent PAR2 sets cover the same file name and length but describe
        //     different content; repair must reject the ambiguity instead of picking by size.
        var ambiguousMedia = NzbTestFixtures.PublishFile(
            Nntp, "ambiguous.mkv", Video, "ambiguous-media");
        var wrongVideo = Video.ToArray();
        wrongVideo[0] ^= 0x5a;
        var wrongSet = Par2TestWriter.Create(
            [("ambiguous.mkv", wrongVideo)], 4096, recoverySliceCount: 1);
        var correctSet = Par2TestWriter.Create(
            [("ambiguous.mkv", Video)], 4096, recoverySliceCount: 1);
        var ambiguousNzb = WriteNzb(
            "ambiguous-par2.nzb",
            ambiguousMedia,
            NzbTestFixtures.PublishFile(Nntp, "a.par2", wrongSet.IndexBytes, "ambiguous-wrong"),
            NzbTestFixtures.PublishFile(
                Nntp,
                "b.vol00+01.par2",
                correctSet.Volumes[0].Bytes,
                "ambiguous-correct"));

        // 13) a base PAR2 file may contain both the index packets and recovery slices.
        var embeddedMedia = NzbTestFixtures.PublishFile(
            Nntp, "video.mkv", RepairVideo, "embedded-par2-media");
        var embeddedDamaged = Math.Max(9, embeddedMedia.SegmentIds.Length * 3 / 5);
        Nntp.Articles.TryRemove(embeddedMedia.SegmentIds[embeddedDamaged], out _);
        Nntp.StatOnlyArticles.TryAdd(embeddedMedia.SegmentIds[embeddedDamaged], 0);
        var embeddedNzb = WriteNzb(
            "embedded-par2.nzb",
            embeddedMedia,
            NzbTestFixtures.PublishFile(
                Nntp,
                "video.par2",
                par2Set.Volumes[0].Bytes,
                "embedded-par2-index"));

        // --- boot the real server on a random loopback port ------------------------------

        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            EnvironmentName = Environments.Production,
        });
        builder.WebHost.UseUrls("http://127.0.0.1:0");
        builder.Logging.SetMinimumLevel(LogLevel.Warning);
        builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
        {
            // Keep the structured-logging output quiet in the test run.
            ["Serilog:MinimumLevel:Default"] = "Warning",
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:LoginAttemptsPerMinute"] = "100",
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_tempDir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_tempDir, "keys"),
            ["Streamarr:ConnectionBudget"] = "12",
            ["Streamarr:SessionTtlSeconds"] = "300",
            ["Streamarr:AllowLocalNzbFiles"] = "true",
            ["Streamarr:PreDownload:CachePath"] = Path.Combine(_tempDir, "pre-download"),
            ["Streamarr:PreDownload:MinimumFreeDiskBytes"] = "0",
            ["Streamarr:HealthCheck:SampleCount"] = "24",
            ["Streamarr:HealthCheck:StartupSampleCount"] = "8",
            ["Streamarr:HealthCheck:DeadMissingRatio"] = "0.5",
            ["Streamarr:Providers:0:Name"] = "mock",
            ["Streamarr:Providers:0:Host"] = Nntp.Host,
            ["Streamarr:Providers:0:Port"] = Nntp.Port.ToString(),
            ["Streamarr:Providers:0:UseSsl"] = "false",
            ["Streamarr:Providers:0:Username"] = Nntp.Username,
            ["Streamarr:Providers:0:Password"] = Nntp.Password,
            ["Streamarr:Providers:0:MaxConnections"] = "8",
            ["Streamarr:Repair:WorkspacePath"] = Path.Combine(_tempDir, "repair"),
            ["Streamarr:Repair:MinFreeDiskBytes"] = "0",
            ["Streamarr:Repair:MaxConnections"] = "4",
            ["Streamarr:Repair:WaitAtHoleTimeoutSeconds"] = "60",
            ["Streamarr:Repair:FailureBackoffSeconds"] = "1",
        });
        builder.AddStreamarrServer();

        _app = builder.Build();
        _app.UseStreamarrServer();
        await _app.StartAsync();

        BaseUrl = _app.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!.Addresses.First();

        // --- register the releases (M2 search will do this in production) ----------------

        var store = _app.Services.GetRequiredService<IReleaseStore>();
        Register(store, "tmdb-movie-1", DirectReleaseId, directNzb);
        Register(store, "tmdb-movie-2", RarReleaseId, rarNzb);
        Register(store, SingleHoleWorkId, SingleHoleReleaseId, singleHoleNzb, score: 900);
        Register(store, SingleHoleWorkId, SingleHoleFallbackReleaseId, singleHoleFallbackNzb, score: 850);
        Register(store, DeadWorkId, DeadReleaseId, deadNzb, score: 900);
        Register(store, DeadWorkId, FallbackReleaseId, fallbackNzb, score: 850);
        Register(store, DeadOnlyWorkId, DeadOnlyReleaseId, deadOnlyNzb, score: 700);
        Register(store, ProbeHoleWorkId, ProbeHoleReleaseId, probeHoleNzb, score: 900);
        Register(store, ProbeHoleWorkId, ProbeHoleFallbackReleaseId, probeHoleFallbackNzb, score: 850);
        Register(store, RepairableWorkId, RepairableReleaseId, repairableNzb, score: 900);
        Register(store, UnrepairableWorkId, UnrepairableReleaseId, unrepairableNzb, score: 900);
        Register(store, RaceRepairableWorkId, RaceRepairableReleaseId, raceNzb, score: 900);
        Register(store, SlowOpenWorkId, SlowOpenReleaseId, slowOpenNzb, score: 900);
        Register(store, AmbiguousPar2WorkId, AmbiguousPar2ReleaseId, ambiguousNzb, score: 900);
        Register(store, EmbeddedPar2WorkId, EmbeddedPar2ReleaseId, embeddedNzb, score: 900);
    }

    private static void Register(IReleaseStore store, string workId, string releaseId, string nzbPath, int score = 800)
        => store.Register(workId, new Release
        {
            ReleaseId = releaseId,
            Title = $"Example.2021.1080p.WEB-DL.x264-{releaseId}",
            Indexer = "mock-indexer",
            SizeBytes = 0,
            Score = score,
            NzbUrl = nzbPath,
        });

    private PublishedNzbFile Par2Decoy(string prefix)
    {
        // referenced by the NZB but intentionally never published: proves par2
        // companions are neither selected as primary nor health-sampled
        var junk = new byte[2048];
        return NzbTestFixtures.PublishFile(Nntp, "video.par2", junk, $"{prefix}-par2", publishArticle: _ => false);
    }

    private string WriteNzb(string name, params PublishedNzbFile[] files)
    {
        var path = Path.Combine(_tempDir, name);
        File.WriteAllText(path, NzbTestFixtures.BuildNzbXml(files));
        return path;
    }

    public async Task DisposeAsync()
    {
        if (_app != null!)
            await _app.DisposeAsync();
        if (Nntp != null!)
            await Nntp.DisposeAsync();
        if (_tempDir != null! && Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }
}

[CollectionDefinition("streamarr-server")]
public class StreamarrServerCollection : ICollectionFixture<StreamarrServerFixture>;
