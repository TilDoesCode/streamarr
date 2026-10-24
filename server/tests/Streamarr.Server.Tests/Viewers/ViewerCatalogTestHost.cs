using System.Net.Http.Headers;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Media;
using Streamarr.Core.Providers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Tests.Integration;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>TMDB stand-in for the catalog: rated movies, two series and trending/popular lists with card fields only.</summary>
public sealed class CatalogTmdbFake : ITmdbClient
{
    public const int Movie = 501, RatedR = 502, Unrated = 503, KidsMovie = 504, BrokenMovie = 505, LanguageMovie = 506, ManyVersionsMovie = 507;
    public const int Show = 600, AdultShow = 601, BrokenShow = 602, AffinityShow = 603, PackShow = 604;

    private static readonly TmdbMatch[] Movies =
    [
        new()
        {
            MediaType = MediaType.Movie, TmdbId = Movie, ImdbId = "tt0000501", Title = "Catalog Movie", OriginalTitle = "Katalogfilm",
            Year = 2021, RuntimeMinutes = 120, OfficialRating = "PG-13", CommunityRating = 7.8F, Tagline = "Every version counts.",
            Overview = "A movie with many versions.", Genres = ["Drama", "Mystery"], PosterUrl = "https://img.example/501-poster.jpg",
            BackdropUrl = "https://img.example/501-backdrop.jpg", LogoUrl = "https://img.example/501-logo.png",
            People = [new TmdbPerson { Name = "Ada Actor", Type = "Actor", Role = "Lead" }],
        },
        new() { MediaType = MediaType.Movie, TmdbId = RatedR, Title = "Grown Up Movie", Year = 2020, RuntimeMinutes = 100, OfficialRating = "R" },
        new() { MediaType = MediaType.Movie, TmdbId = Unrated, Title = "Unrated Movie", Year = 2019, RuntimeMinutes = 90 },
        new() { MediaType = MediaType.Movie, TmdbId = KidsMovie, Title = "Kids Movie", Year = 2018, RuntimeMinutes = 80, OfficialRating = "G" },
        new() { MediaType = MediaType.Movie, TmdbId = BrokenMovie, Title = "Broken Movie", Year = 2017, RuntimeMinutes = 95, OfficialRating = "G" },
    ];

    /// <summary>Known to detail lookups only (never in search, rows or browse), so other tests' lists stay as they are.</summary>
    private static readonly TmdbMatch[] DetailOnly =
    [
        new() { MediaType = MediaType.Movie, TmdbId = LanguageMovie, Title = "Language Movie", Year = 2022, RuntimeMinutes = 100, OfficialRating = "PG" },
        new() { MediaType = MediaType.Movie, TmdbId = ManyVersionsMovie, Title = "Many Versions", Year = 2023, RuntimeMinutes = 130, OfficialRating = "PG" },
    ];

    private static readonly TmdbMatch[] Shows =
    [
        new() { MediaType = MediaType.Tv, TmdbId = Show, Title = "Catalog Show", Year = 2020, RuntimeMinutes = 45, OfficialRating = "12", LogoUrl = "https://img.example/600-logo.png" },
        new() { MediaType = MediaType.Tv, TmdbId = AdultShow, Title = "Adult Show", Year = 2021, RuntimeMinutes = 50, OfficialRating = "TV-MA" },
        new() { MediaType = MediaType.Tv, TmdbId = BrokenShow, Title = "Broken Show", Year = 2022, RuntimeMinutes = 30, OfficialRating = "TV-G" },
    ];

    /// <summary>Series known to detail lookups only, like <see cref="DetailOnly"/>.</summary>
    private static readonly TmdbMatch[] DetailOnlyShows =
    [
        new() { MediaType = MediaType.Tv, TmdbId = AffinityShow, Title = "Affinity Show", Year = 2023, RuntimeMinutes = 45, OfficialRating = "12" },
        new() { MediaType = MediaType.Tv, TmdbId = PackShow, Title = "Pack Show", Year = 2025, RuntimeMinutes = 25, OfficialRating = "12" },
    ];

    private int _detailLookups;

    public int DetailLookups => Volatile.Read(ref _detailLookups);

    public Task<IReadOnlyList<TmdbMatch>> SearchCandidatesAsync(string query, MediaType? mediaType, CancellationToken cancellationToken)
        => Task.FromResult<IReadOnlyList<TmdbMatch>>(Movies.Concat(Shows)
            .Where(m => (mediaType is null || m.MediaType == mediaType) && m.Title.Contains(query, StringComparison.OrdinalIgnoreCase))
            .Select(Card)
            .ToList());

    public Task<TmdbMatch?> SearchAnyAsync(string query, CancellationToken cancellationToken)
        => Task.FromResult(Movies.Concat(Shows).FirstOrDefault(m => Same(m.Title, query)));

    public Task<TmdbMatch?> SearchMovieAsync(string title, int? year, CancellationToken cancellationToken)
        => Task.FromResult(Movies.Concat(DetailOnly).FirstOrDefault(m => Same(m.Title, title)));

    public Task<TmdbMatch?> SearchTvAsync(string title, CancellationToken cancellationToken)
        => Task.FromResult(Shows.Concat(DetailOnlyShows).FirstOrDefault(m => Same(m.Title, title)));

    public Task<TmdbMatch?> GetMovieAsync(int tmdbId, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _detailLookups);
        var movie = Movies.Concat(DetailOnly).FirstOrDefault(m => m.TmdbId == tmdbId);
        return Task.FromResult(TmdbLanguage.Current == "de" && movie is not null ? movie with { Title = $"Der {movie.Title}" } : movie);
    }

    public Task<TmdbMatch?> GetTvAsync(int tmdbId, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _detailLookups);
        return Task.FromResult(Shows.Concat(DetailOnlyShows).FirstOrDefault(m => m.TmdbId == tmdbId));
    }

    public Task<TmdbTvSeriesCatalog?> GetTvSeriesCatalogAsync(int tmdbId, CancellationToken cancellationToken)
        => Task.FromResult(Shows.Concat(DetailOnlyShows).FirstOrDefault(s => s.TmdbId == tmdbId) is { } show
            ? new TmdbTvSeriesCatalog
            {
                Series = TmdbLanguage.Current == "de" ? show with { Title = $"Die {show.Title}" } : show,
                Seasons =
                [
                    new TmdbSeasonSummary { SeasonNumber = 0, Title = "Specials", EpisodeCount = 1 },
                    new TmdbSeasonSummary { SeasonNumber = 1, Title = "Season 1", EpisodeCount = 3, AirDate = "2020-01-01" },
                    new TmdbSeasonSummary { SeasonNumber = 2, Title = "Season 2", EpisodeCount = 2, AirDate = "2021-01-01" },
                ],
            }
            : null);

    public Task<TmdbTvSeasonCatalog?> GetTvSeasonCatalogAsync(int tmdbId, int seasonNumber, CancellationToken cancellationToken)
    {
        if (Shows.Concat(DetailOnlyShows).All(s => s.TmdbId != tmdbId))
            return Task.FromResult<TmdbTvSeasonCatalog?>(null);
        TmdbEpisode[]? episodes = seasonNumber switch
        {
            0 => [Episode(1, "2019-06-01", null)],
            1 => [Episode(1, "2020-01-01", 44), Episode(2, "2020-01-08", 46), Episode(3, "2020-01-15", null)],
            2 => [Episode(1, "2021-01-01", 45), Episode(2, "2099-01-01", null)],
            _ => null,
        };
        return Task.FromResult(episodes is null ? null : new TmdbTvSeasonCatalog
        {
            TmdbId = tmdbId,
            SeasonNumber = seasonNumber,
            Title = seasonNumber == 0 ? "Specials" : $"Season {seasonNumber}",
            Overview = $"Season {seasonNumber} overview.",
            Episodes = episodes,
        });
    }

    public Task<TmdbMatch?> FindByImdbAsync(string imdbId, CancellationToken cancellationToken) => Task.FromResult<TmdbMatch?>(null);

    public Task<IReadOnlyList<TmdbMatch>> GetTrendingAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Task.FromResult(List(mediaType == MediaType.Movie ? [Movie, RatedR, Unrated, KidsMovie] : [Show, AdultShow], mediaType));

    public Task<IReadOnlyList<TmdbMatch>> GetPopularAsync(MediaType mediaType, CancellationToken cancellationToken)
        => Task.FromResult(List(mediaType == MediaType.Movie ? [KidsMovie, Movie] : [AdultShow], mediaType));

    public const int DiscoverPageSize = 2;
    public const int DramaGenre = 18;

    private int _discoverCalls, _genreCalls;

    public int DiscoverCalls => Volatile.Read(ref _discoverCalls);
    public int GenreCalls => Volatile.Read(ref _genreCalls);
    public TmdbDiscoverQuery? LastDiscover { get; private set; }

    /// <summary>All titles of the type in id order (reversed for newest), two per page; only the main movie is a drama.</summary>
    public Task<TmdbDiscoverPage> DiscoverAsync(TmdbDiscoverQuery query, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _discoverCalls);
        LastDiscover = query;
        var all = (query.MediaType == MediaType.Movie ? Movies : Shows)
            .Where(m => query.GenreId is null || (query.GenreId == DramaGenre && m.TmdbId == Movie))
            .Select(m => m.TmdbId)
            .ToList();
        if (query.Sort == TmdbDiscoverSort.Newest)
            all.Reverse();
        var pages = (all.Count + DiscoverPageSize - 1) / DiscoverPageSize;
        var ids = all.Skip((query.Page - 1) * DiscoverPageSize).Take(DiscoverPageSize).ToArray();
        return Task.FromResult(new TmdbDiscoverPage(List(ids, query.MediaType), query.Page, pages, all.Count));
    }

    public Task<IReadOnlyList<TmdbGenre>> GetGenresAsync(MediaType mediaType, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _genreCalls);
        return Task.FromResult<IReadOnlyList<TmdbGenre>>(mediaType == MediaType.Movie
            ? [new TmdbGenre(DramaGenre, "Drama"), new TmdbGenre(9648, TmdbLanguage.Current == "de" ? "Rätsel" : "Mystery")]
            : [new TmdbGenre(10765, "Sci-Fi & Fantasy")]);
    }

    private static IReadOnlyList<TmdbMatch> List(int[] ids, MediaType type)
        => ids.Select(id => (type == MediaType.Movie ? Movies : Shows).Single(m => m.TmdbId == id)).Select(Card).ToList();

    private static TmdbMatch Card(TmdbMatch full) => full with { OfficialRating = null, Genres = [], People = [], LogoUrl = null, RuntimeMinutes = null };

    private static bool Same(string a, string b) => string.Equals(a.Replace('.', ' '), b.Replace('.', ' '), StringComparison.OrdinalIgnoreCase);

    private static TmdbEpisode Episode(int number, string airDate, int? runtime)
        => new() { EpisodeNumber = number, Title = $"Episode {number}", AirDate = airDate, RuntimeMinutes = runtime, StillUrl = $"https://img.example/still-{number}.jpg" };
}

/// <summary>Indexer stand-in: canned releases per TMDB id and season; counts every fan-out.</summary>
public sealed class CatalogNewznabFake : INewznabClient
{
    public const string NzbHost = "nzb.catalog.example";

    private int _searches;

    public int Searches => Volatile.Read(ref _searches);

    /// <summary>Free-text term and TMDB language of every indexer search.</summary>
    public System.Collections.Concurrent.ConcurrentQueue<(string? Term, string? Language)> Queries { get; } = new();

    public static readonly string[] MovieReleases =
    [
        "Catalog.Movie.2021.2160p.UHD.BluRay.TrueHD.Atmos.7.1.DV.HDR10.x265-GRP",
        "Catalog.Movie.2021.1080p.WEB-DL.DDP5.1.H.264-GRP",
        "Catalog.Movie.2021.720p.WEB-DL.AAC2.0.H.264.MP4-GRP",
        "Catalog.Movie.2021.1080p.WEB-DL.Opus.5.1.AV1-GRP",
    ];

    /// <summary>The same 1080p BluRay in English (untagged, largest), German and French.</summary>
    public static readonly string[] LanguageReleases =
    [
        "Language.Movie.2022.1080p.BluRay.DTS.x264-GRP",
        "Language.Movie.2022.German.DL.1080p.BluRay.DTS.x264-GRP",
        "Language.Movie.2022.FRENCH.1080p.BluRay.DTS.x264-GRP",
    ];

    /// <summary>150 distinct releases of one movie (resolutions, sources, codecs, audio, languages, groups): the version sheet's worst case.</summary>
    public static readonly string[] ManyReleases =
    [
        .. from resolution in new[] { "2160p", "1080p", "720p" }
        from source in new[] { "UHD.BluRay", "BluRay", "WEB-DL", "WEBRip", "BluRay.REMUX" }
        from video in new[] { "x265", "H.264", "AV1", "HEVC.10bit", "x264" }
        from tail in new[] { "TrueHD.Atmos.7.1", "German.DL.DTS-HD.MA.5.1" }
        select $"Many.Versions.2023.{(tail.StartsWith("German", StringComparison.Ordinal) ? "German.DL." : "")}{resolution}.{source}.{tail.Replace("German.DL.", "", StringComparison.Ordinal)}.{video}-G{resolution[0]}{source.Length}{video.Length}",
    ];

    /// <summary>Season 1 of the affinity show: two equal WEB-DL groups (BETA a PROPER, so ranked first) and a German one.</summary>
    public static readonly string[] AffinityReleases =
    [
        "Affinity.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-ALPHA",
        "Affinity.Show.S01E01.PROPER.1080p.WEB-DL.DDP5.1.H.264-BETA",
        "Affinity.Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-ALPHA",
        "Affinity.Show.S01E02.PROPER.1080p.WEB-DL.DDP5.1.H.264-BETA",
        "Affinity.Show.S01E02.German.1080p.WEB-DL.DDP5.1.H.264-GAMMA",
    ];

    /// <summary>The user's report: a 1080p and a 4K HDR10 pack of one group, each from two indexers (sizes a little apart), a single episode and another 4K group.</summary>
    public static readonly string[] PackReleases =
    [
        "Pack.Show.S01.German.DL.AAC.1080p.NF.WEB.H264-snk",
        "Pack.Show.S01E02.German.DL.AAC.1080p.NF.WEB.H264-snk",
        "Pack.Show.S01.German.DL.AAC.2160p.HDR.NF.WEB.H265-snk",
        "Pack.Show.S01.German.DL.2160p.WEB.HEVC-OTHER",
    ];

    public Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
        => Task.FromResult(new NewznabCapabilities());

    public Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        Interlocked.Increment(ref _searches);
        Queries.Enqueue((query.Term, TmdbLanguage.Current));
        NewznabItem[] items = query switch
        {
            { TmdbId: CatalogTmdbFake.BrokenMovie } or { TmdbId: CatalogTmdbFake.BrokenShow } => throw new HttpRequestException("indexer down"),
            { TmdbId: CatalogTmdbFake.Movie } =>
            [
                Item(MovieReleases[0], 40_000_000_000),
                Item(MovieReleases[1], 8_000_000_000),
                Item(MovieReleases[2], 3_000_000_000),
                Item(MovieReleases[3], 5_000_000_000),
                Item("Catalog.Movie.2021.1080p.WEB-DL.x264.sample-GRP", 4_000_000_000),
            ],
            { TmdbId: CatalogTmdbFake.LanguageMovie } =>
            [
                Item(LanguageReleases[0], 12_500_000_000),
                Item(LanguageReleases[1], 12_000_000_000),
                Item(LanguageReleases[2], 11_500_000_000),
            ],
            { TmdbId: CatalogTmdbFake.ManyVersionsMovie } => ManyReleases.Select((title, i) => Item(title, 4_000_000_000 + i * 150_000_000L)).ToArray(),
            { TmdbId: CatalogTmdbFake.RatedR } => [Item("Grown.Up.Movie.2020.1080p.WEB-DL.DDP5.1.H.264-GRP", 7_000_000_000)],
            { TmdbId: CatalogTmdbFake.Show, Season: 1 } =>
            [
                Item("Catalog.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP", 2_000_000_000),
                Item("Catalog.Show.S01E01.720p.HDTV.x264-GRP", 1_000_000_000),
                Item("Catalog.Show.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRP", 2_100_000_000),
                Item("Catalog.Show.S01.1080p.BluRay.DD5.1.x264-PACK", 9_000_000_000),
            ],
            { TmdbId: CatalogTmdbFake.Show, Season: 2 } => [Item("Catalog.Show.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP", 2_000_000_000)],
            { TmdbId: CatalogTmdbFake.AffinityShow, Season: 1 } => AffinityReleases.Select(title => Item(title, 2_000_000_000)).ToArray(),
            { TmdbId: CatalogTmdbFake.PackShow, Season: 1 } =>
            [
                Item(PackReleases[0], 15_600_000_000),
                Item(PackReleases[0], 15_640_000_000, "second-indexer"),
                Item(PackReleases[1], 1_500_000_000),
                Item(PackReleases[2], 31_200_000_000),
                Item(PackReleases[2], 31_180_000_000, "second-indexer"),
                Item(PackReleases[3], 27_200_000_000),
            ],
            { TmdbId: CatalogTmdbFake.AdultShow } => [Item("Adult.Show.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRP", 2_000_000_000)],
            _ => [],
        };
        return Task.FromResult(new NewznabSearchResponse { Items = items, Total = items.Length });
    }

    private static NewznabItem Item(string title, long size, string? copy = null) => new()
    {
        Title = title,
        Guid = $"guid-{copy}{title}",
        SizeBytes = size,
        Grabs = 42,
        NzbUrl = $"https://{NzbHost}/get/{Uri.EscapeDataString(title)}.nzb",
        PublishDate = DateTimeOffset.UtcNow.AddDays(-3),
    };
}

public class ViewerCatalogFactory : WebApplicationFactory<Program>
{
    /// <summary>Off by default so tests that count indexer searches are not raced by background lookups.</summary>
    protected virtual bool SpecWarmup => false;

    public const string ApiKey = "machine-key-for-catalog-tests-0123456789";
    public const string IndexerName = "catalog-indexer-name";
    public const string IndexerKey = "catalog-indexer-secret-key";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-catalog-").FullName;
    private readonly SemaphoreSlim _adminGate = new(1, 1);
    private string? _adminToken;

    public ManualClock Clock { get; } = new(DateTimeOffset.UtcNow);
    public CatalogTmdbFake Tmdb { get; } = new();
    public CatalogNewznabFake Newznab { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerVersionsCacheSeconds"] = "600",
            ["Streamarr:SpecWarmup:Enabled"] = SpecWarmup ? "true" : "false",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Indexers:0:Name"] = IndexerName,
            ["Streamarr:Indexers:0:BaseUrl"] = "https://indexer.catalog.example",
            ["Streamarr:Indexers:0:ApiKey"] = IndexerKey,
            ["Streamarr:Indexers:0:Categories:0"] = "2000",
            ["Streamarr:Indexers:0:Categories:1"] = "5000",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient>(Tmdb);
            services.RemoveAll<INewznabClient>();
            services.AddSingleton<INewznabClient>(Newznab);
        });
    }

    /// <summary>Admin JWTs are minted once, before tests move the shared clock ahead of the validator's wall clock.</summary>
    public async Task<HttpClient> AdminAsync()
    {
        await _adminGate.WaitAsync();
        try
        {
            _adminToken ??= await TestAuth.LoginAsAdminAsync(CreateClient());
        }
        finally
        {
            _adminGate.Release();
        }
        return Bearer(_adminToken);
    }

    public HttpClient Bearer(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}

/// <summary>The catalog host with spec warm-up on.</summary>
public sealed class ViewerCatalogWarmupFactory : ViewerCatalogFactory
{
    protected override bool SpecWarmup => true;
}
