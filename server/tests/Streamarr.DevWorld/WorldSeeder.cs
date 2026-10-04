using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Media;
using Streamarr.Server.Config;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;
using Streamarr.Server.Services;
using Streamarr.Server.Viewers;
using Streamarr.Server.Viewers.Access;
using Streamarr.Server.Viewers.Auth;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld;

public sealed record SeededViewer(
    string Id,
    string Username,
    string DisplayName,
    string? Email,
    ViewerPermissions Permissions,
    string? TotpSecret,
    IReadOnlyList<string> RecoveryCodes,
    string Purpose);

public sealed record ReleaseRank(string ReleaseId, string WorkId, int Rank, int Score, string Health);

public sealed record ReleaseCheck(string ReleaseId, string WorkId, string Name, string Designed, string Actual, string? StreamUrl, double Seconds)
{
    public bool Passed => Actual == Designed;
}

/// <summary>Enables the viewer module, seeds the fixture accounts and pre-registers every release.</summary>
public static class WorldSeeder
{
    public const string AdminUsername = "admin";
    public const string AdminPassword = "streamarr-dev";
    public const string ApiKey = "devworld-api-key-0123456789abcdef";
    public const string ViewerPassword = "streamarr";
    public const string BenTotpSecret = "STREAMARRDEVWORLDBENTOTPSECRET23";

    public static async Task<IReadOnlyList<SeededViewer>> SeedViewersAsync(IServiceProvider services, CancellationToken ct)
    {
        await services.GetRequiredService<ViewerSettingsService>().SaveAsync(new ViewerSettings
        {
            Enabled = true,
            ServerName = "Streamarr Dev World",
            MinResumeDurationSeconds = 60,
            Email = new ViewerEmailSettings
            {
                Mode = ViewerEmailMode.Outbox,
                FromAddress = "devworld@streamarr.example",
                FromName = "Streamarr Dev World",
            },
        }, smtpPassword: null, ct);

        var accounts = services.GetRequiredService<ViewerAccountService>();
        var specs = new (string User, string Display, ViewerPermissions Permissions, string Purpose)[]
        {
            ("anna", "Anna", new ViewerPermissions(null, false, true, null), "adult, unrestricted, transcoding allowed"),
            ("ben", "Ben", new ViewerPermissions(null, false, true, null), "adult with TOTP two-factor enabled"),
            ("kind", "Kind", new ViewerPermissions(12, true, true, null), "child: max age 12, unrated blocked"),
            ("gast", "Gast", new ViewerPermissions(null, false, false, 1), "guest: no transcoding, max 1 concurrent stream"),
        };

        var seeded = new List<SeededViewer>();
        foreach (var (user, display, permissions, purpose) in specs)
        {
            var email = $"{user}@devworld.example";
            var existing = await ExistingViewerAsync(services, user, ct);
            var viewerId = existing?.Id ?? (await accounts.CreateAsync(
                new ViewerCreate(user, display, email, ViewerPassword, false, permissions, false), ct)).Viewer.Id;
            string? secret = null;
            IReadOnlyList<string> recovery = [];
            if (user == "ben")
            {
                secret = BenTotpSecret;
                recovery = Enumerable.Range(1, ViewerTotp.RecoveryCodeCount).Select(i => $"ben-recovery-{i:00}").ToList();
                if (existing?.TotpEnabledAt is null)
                    await EnableTotpAsync(services, viewerId, secret, recovery, ct);
            }

            seeded.Add(new SeededViewer(viewerId, user, display, email, permissions, secret, recovery, purpose));
        }

        return seeded;
    }

    /// <summary>Points a kept world's NNTP provider at this boot's mock server, whose port changes on every start.</summary>
    public static async Task SyncNntpProviderAsync(IServiceProvider services, MockNntpServer nntp, CancellationToken ct)
    {
        var providers = services.GetRequiredService<ProviderConfigService>();
        var kept = await providers.GetAsync(DevWorldHost.NntpProviderName, ct);
        if (kept is null || (kept.Host == nntp.Host && kept.Port == nntp.Port))
            return;
        await providers.UpdateAsync(kept.Id, new ProviderWrite { Name = kept.Name, Host = nntp.Host, Port = nntp.Port }, ct);
    }

    /// <summary>The seeded viewer kept from a previous run (DEVWORLD_KEEP_DATA=1); null on a fresh world.</summary>
    private static async Task<ViewerEntity?> ExistingViewerAsync(IServiceProvider services, string username, CancellationToken ct)
    {
        await using var db = await services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync(ct);
        return await db.Viewers.AsNoTracking().FirstOrDefaultAsync(v => v.Username == username, ct);
    }

    private static async Task EnableTotpAsync(IServiceProvider services, string viewerId, string secret, IReadOnlyList<string> recovery, CancellationToken ct)
    {
        var protector = services.GetRequiredService<ISecretProtector>();
        var now = DateTimeOffset.UtcNow;
        await using var db = await services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync(ct);
        var viewer = await db.Viewers.SingleAsync(v => v.Id == viewerId, ct);
        viewer.TotpSecretEncrypted = protector.Protect(secret);
        viewer.TotpEnabledAt = now;
        viewer.UpdatedAt = now;
        db.ViewerRecoveryCodes.AddRange(recovery.Select(code => new ViewerRecoveryCodeEntity
        {
            ViewerId = viewerId,
            CodeHash = ViewerTotp.HashRecoveryCode(code),
            CreatedAt = now,
        }));
        await db.SaveChangesAsync(ct);
    }

    /// <summary>Registers every release via the real search pipeline and records ranks; throws when a fixture release is hidden or rejected.</summary>
    public static async Task<IReadOnlyDictionary<string, ReleaseRank>> WarmUpAsync(IServiceProvider services, PublicationStore store, CancellationToken ct)
    {
        var search = services.GetRequiredService<SearchService>();
        var tv = services.GetRequiredService<TvCatalogService>();
        var ranks = new Dictionary<string, ReleaseRank>(StringComparer.Ordinal);
        var problems = new List<string>();
        var byId = store.Releases.ToDictionary(r => r.ReleaseId, StringComparer.Ordinal);

        foreach (var group in store.Releases.Where(r => r.Plan.MediaType == "movie").GroupBy(r => r.Plan.Title.TmdbId))
        {
            var title = group.First().Plan.Title;
            var aggregation = await search.SearchAsync(new SearchQuery { Q = title.Title, Type = "movie", TmdbId = title.TmdbId }, ct);
            var work = aggregation.Works.FirstOrDefault(w => w.WorkId == $"tmdb-movie-{title.TmdbId}");
            Record(work?.WorkId, work?.Releases ?? []);
        }

        foreach (var series in store.Releases.Where(r => r.Plan.MediaType == "tv").Select(r => r.Plan.Title).OfType<SeriesEntry>().DistinctBy(s => s.TmdbId))
        {
            foreach (var season in series.Seasons.Where(s => s.Episodes.Any(e => e.Releases.Count > 0)))
            {
                var details = await tv.GetSeasonAsync(series.TmdbId, season.SeasonNumber, profileId: null, ct)
                              ?? throw new InvalidOperationException($"{series.Title} season {season.SeasonNumber} did not load.");
                foreach (var episode in details.Episodes)
                {
                    for (var i = 0; i < episode.Releases.Count; i++)
                    {
                        var dto = episode.Releases[i];
                        var key = $"{episode.WorkId}|{dto.ReleaseId}";
                        ranks[key] = new ReleaseRank(dto.ReleaseId, episode.WorkId, i + 1, dto.Score, dto.Health);
                    }
                }
            }
        }

        foreach (var release in store.Releases)
        {
            foreach (var workId in WorkIdsOf(release))
            {
                if (!ranks.ContainsKey($"{workId}|{release.ReleaseId}"))
                    problems.Add($"{release.Plan.Name} is not listed (or rejected) for {workId}.");
            }
        }

        if (!store.Releases.Any(r => r.Plan.Entry.Health == "dead"
                                     && ranks.TryGetValue($"{r.Plan.WorkId}|{r.ReleaseId}", out var rank) && rank.Rank == 1))
            problems.Add("No dead release is ranked first anywhere; the auto-fallback scenario would not trigger.");

        if (problems.Count > 0)
            throw new InvalidOperationException("Dev World warm-up found fixture problems:\n  " + string.Join("\n  ", problems));
        return ranks;

        void Record(string? workId, IReadOnlyList<Release> releases)
        {
            if (workId is null)
                return;
            for (var i = 0; i < releases.Count; i++)
            {
                var release = releases[i];
                if (release.Rejected)
                    problems.Add($"{release.Title} is rejected: {string.Join("; ", release.RejectionReasons)}");
                if (byId.ContainsKey(release.ReleaseId))
                    ranks[$"{workId}|{release.ReleaseId}"] = new ReleaseRank(release.ReleaseId, workId, i + 1, release.Score, release.Health.ToString().ToLowerInvariant());
            }
        }
    }

    /// <summary>Resolves every release for each of its works without fallback, so each designed health (ready/degraded/dead) is proven.</summary>
    public static async Task<IReadOnlyList<ReleaseCheck>> CheckReleasesAsync(IServiceProvider services, PublicationStore store, string localUrl, CancellationToken ct)
    {
        var resolver = services.GetRequiredService<ResolveService>();
        var checks = new List<ReleaseCheck>();
        foreach (var release in store.Releases)
        {
            foreach (var workId in WorkIdsOf(release))
            {
                var watch = System.Diagnostics.Stopwatch.StartNew();
                string actual;
                string? streamUrl = null;
                try
                {
                    var response = await resolver.ResolveAsync(
                        release.ReleaseId, workId, "devworld-check", autoFallback: false,
                        token => $"{localUrl}/api/v1/stream/{token}", token => $"{localUrl}/api/v1/stream/{token}", ct);
                    actual = response.Status;
                    streamUrl = response.StreamUrl;
                }
                catch (Exception e) when (!ct.IsCancellationRequested)
                {
                    actual = $"{e.GetType().Name}: {e.Message}";
                }

                checks.Add(new ReleaseCheck(release.ReleaseId, workId, release.Plan.Name, release.Plan.Entry.Health, actual, streamUrl, watch.Elapsed.TotalSeconds));
            }
        }

        return checks;
    }

    private static IEnumerable<string> WorkIdsOf(PublishedRelease release)
        => release.Plan.IsSeasonPack
            ? ((SeriesEntry)release.Plan.Title).Seasons.Single(s => s.SeasonNumber == release.Plan.Season)
                .Episodes.Select(e => $"tmdb-tv-{release.Plan.Title.TmdbId}-s{release.Plan.Season:00}e{e.EpisodeNumber:00}")
            : [release.Plan.WorkId];

    /// <summary>The machine-readable description of the running world (devworld.json).</summary>
    public static object BuildManifest(
        DevWorldOptions options,
        WorldPlan plan,
        PublicationStore store,
        IReadOnlyDictionary<string, GeneratedMedia> media,
        IReadOnlyList<SeededViewer> viewers,
        IReadOnlyDictionary<string, ReleaseRank> ranks,
        object timings,
        object? snapshot)
    {
        var kid = viewers.Single(v => v.Username == "kind").Permissions;

        object ReleaseJson(PublishedRelease r, string workId)
        {
            ranks.TryGetValue($"{workId}|{r.ReleaseId}", out var rank);
            var files = r.Plan.Files.Select(f =>
            {
                var generated = media[f.Media.Key];
                return new
                {
                    fileName = f.FileName,
                    cachePath = Path.GetRelativePath(options.CacheDir, generated.Path),
                    sizeBytes = generated.SizeBytes,
                    durationSeconds = Math.Round(generated.Probe.DurationSeconds, 2),
                    container = generated.Probe.FormatName,
                    streams = generated.Probe.Streams.Select(s => new
                    {
                        s.Index, type = s.CodecType, codec = s.CodecName, s.Profile, s.PixFmt, s.Width, s.Height,
                        s.ColorTransfer, s.Channels, s.ChannelLayout, s.Language, s.Title, s.Default, s.Forced,
                    }),
                };
            }).ToList();
            return new
            {
                releaseId = r.ReleaseId,
                name = r.Plan.Name,
                variant = r.Plan.Entry.Variant,
                variantLabel = r.Plan.Files[0].Media.Variant.Label,
                health = r.Plan.Entry.Health,
                rank = rank?.Rank,
                score = rank?.Score,
                seasonPack = r.Plan.IsSeasonPack,
                reportedSizeBytes = r.Plan.ReportedSizeBytes,
                grabs = r.Plan.Entry.Grabs,
                ageDays = r.Plan.Entry.AgeDays,
                partSizeBytes = r.Files[0].PartSize,
                articles = r.Files.Sum(f => f.TotalParts),
                files,
            };
        }

        List<string> MovieIds(IEnumerable<string> keys) => [.. keys.Select(k => $"tmdb-movie-{plan.Catalog.Movies.Single(m => m.Key == k).TmdbId}")];
        List<string> SeriesIds(IEnumerable<string> keys) => [.. keys.Select(k => $"tmdb-tv-{plan.Catalog.Series.Single(m => m.Key == k).TmdbId}")];

        object Access(TitleEntry title) => new
        {
            officialRating = title.OfficialRating,
            minimumAge = ContentRatings.MinimumAge(title.OfficialRating),
            kindAllowed = IsAllowed(title, kid),
            certifications = title.Certifications,
        };

        var titles = new List<object>();
        foreach (var movie in plan.Catalog.Movies)
        {
            var workId = $"tmdb-movie-{movie.TmdbId}";
            titles.Add(new
            {
                key = movie.Key, type = "movie", tmdbId = movie.TmdbId, imdbId = movie.ImdbId, title = movie.Title,
                year = movie.Year, workId, runtimeMinutes = movie.RuntimeMinutes, access = Access(movie),
                posterUrl = DevWorldArtwork.Resolve(movie.PosterUrl, options.LocalUrl), backdropUrl = DevWorldArtwork.Resolve(movie.BackdropUrl, options.LocalUrl), logoUrl = movie.LogoUrl, license = movie.License,
                releases = store.Releases.Where(r => r.Plan.WorkId == workId)
                    .OrderBy(r => ranks.GetValueOrDefault($"{workId}|{r.ReleaseId}")?.Rank ?? 99)
                    .Select(r => ReleaseJson(r, workId)).ToList(),
            });
        }

        foreach (var series in plan.Catalog.Series)
        {
            titles.Add(new
            {
                key = series.Key, type = "tv", tmdbId = series.TmdbId, imdbId = series.ImdbId, title = series.Title,
                year = series.Year, seriesWorkId = $"tmdb-tv-{series.TmdbId}", access = Access(series),
                posterUrl = DevWorldArtwork.Resolve(series.PosterUrl, options.LocalUrl), backdropUrl = DevWorldArtwork.Resolve(series.BackdropUrl, options.LocalUrl), logoUrl = series.LogoUrl, license = series.License,
                seasons = series.Seasons.Select(season => new
                {
                    seasonNumber = season.SeasonNumber,
                    seasonWorkId = $"tmdb-tv-{series.TmdbId}-s{season.SeasonNumber:00}",
                    seasonPacks = store.Releases.Where(r => r.Plan.Title == series && r.Plan.IsSeasonPack && r.Plan.Season == season.SeasonNumber)
                        .Select(r => new { releaseId = r.ReleaseId, name = r.Plan.Name, variant = r.Plan.Entry.Variant }).ToList(),
                    episodes = season.Episodes.Select(episode =>
                    {
                        var workId = $"tmdb-tv-{series.TmdbId}-s{season.SeasonNumber:00}e{episode.EpisodeNumber:00}";
                        return new
                        {
                            episodeNumber = episode.EpisodeNumber, workId, title = episode.Title, airDate = episode.AirDate,
                            releases = store.Releases
                                .Where(r => r.Plan.WorkId == workId || (r.Plan.IsSeasonPack && r.Plan.Title == series && r.Plan.Season == season.SeasonNumber))
                                .OrderBy(r => ranks.GetValueOrDefault($"{workId}|{r.ReleaseId}")?.Rank ?? 99)
                                .Select(r => ReleaseJson(r, workId)).ToList(),
                        };
                    }).ToList(),
                }).ToList(),
            });
        }

        var dead = store.Releases.Where(r => r.Plan.Entry.Health == "dead").Select(r =>
        {
            var fallback = store.Releases
                .Where(o => o.Plan.WorkId == r.Plan.WorkId && o.Plan.Entry.Health != "dead")
                .OrderBy(o => ranks.GetValueOrDefault($"{r.Plan.WorkId}|{o.ReleaseId}")?.Rank ?? 99)
                .FirstOrDefault();
            return new
            {
                workId = r.Plan.WorkId,
                deadReleaseId = r.ReleaseId,
                deadName = r.Plan.Name,
                deadRank = ranks.GetValueOrDefault($"{r.Plan.WorkId}|{r.ReleaseId}")?.Rank,
                expectedFallbackReleaseId = fallback?.ReleaseId,
                expectedFallbackName = fallback?.Plan.Name,
            };
        }).ToList();

        List<string> lan = options.BindsAllInterfaces
            ? System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
                .Where(n => n.OperationalStatus == System.Net.NetworkInformation.OperationalStatus.Up)
                .SelectMany(n => n.GetIPProperties().UnicastAddresses)
                .Where(a => a.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && !System.Net.IPAddress.IsLoopback(a.Address))
                .Select(a => $"http://{a.Address}:{options.Port}")
                .Distinct()
                .ToList()
            : [];

        return new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            url = options.LocalUrl,
            urls = new { local = options.LocalUrl, androidEmulator = options.AndroidEmulatorUrl, lan },
            port = options.Port,
            snapshot,
            timings,
            cacheDir = options.CacheDir,
            admin = new { username = AdminUsername, password = AdminPassword, apiKey = ApiKey },
            viewerPassword = ViewerPassword,
            viewers = viewers.Select(v => new
            {
                id = v.Id, username = v.Username, password = ViewerPassword, displayName = v.DisplayName, email = v.Email,
                purpose = v.Purpose,
                permissions = new { maxAge = v.Permissions.MaxAge, blockUnrated = v.Permissions.BlockUnrated, allowTranscoding = v.Permissions.AllowTranscoding, maxConcurrentStreams = v.Permissions.MaxConcurrentStreams },
                totp = v.TotpSecret is null ? null : new { secret = v.TotpSecret, codeUrl = $"{options.LocalUrl}/devworld/totp/{v.Username}", recoveryCodes = v.RecoveryCodes },
            }),
            helpers = new
            {
                ready = $"{options.LocalUrl}/devworld/ready",
                manifest = $"{options.LocalUrl}/devworld.json",
                totp = $"{options.LocalUrl}/devworld/totp/ben",
                outbox = $"{options.LocalUrl}/devworld/outbox",
            },
            scenarios = new
            {
                deadFallback = dead,
                degraded = store.Releases.Where(r => r.Plan.Entry.Health == "degraded")
                    .Select(r => new { workId = r.Plan.WorkId, releaseId = r.ReleaseId, name = r.Plan.Name }),
                legacyTranscode = store.Releases.Where(r => r.Plan.Files[0].Media.Variant.Video.Codec == "mpeg2video")
                    .Select(r => new { workId = r.Plan.WorkId, releaseId = r.ReleaseId, name = r.Plan.Name }),
                seasonPacks = store.Releases.Where(r => r.Plan.IsSeasonPack)
                    .Select(r => new { seasonWorkId = r.Plan.WorkId, releaseId = r.ReleaseId, name = r.Plan.Name }),
                noVersions = plan.Catalog.Movies.Where(m => m.Releases.Count == 0)
                    .Select(m => new { workId = $"tmdb-movie-{m.TmdbId}", title = m.Title }),
                missingArtwork = plan.Catalog.Series
                    .SelectMany(s => s.Seasons.Select(season => (Series: s, Season: season)))
                    .Where(x => x.Season.PosterUrl is null || x.Season.Episodes.Any(e => e.StillUrl is null))
                    .Select(x => new
                    {
                        seriesWorkId = $"tmdb-tv-{x.Series.TmdbId}",
                        seasonNumber = x.Season.SeasonNumber,
                        seasonPoster = x.Season.PosterUrl is not null,
                        episodesWithoutStill = x.Season.Episodes.Where(e => e.StillUrl is null).Select(e => e.EpisodeNumber).ToList(),
                    }),
                ageGate = new
                {
                    viewer = "kind",
                    maxAge = kid.MaxAge,
                    blocked = plan.Catalog.Movies.Cast<TitleEntry>().Concat(plan.Catalog.Series)
                        .Where(t => !IsAllowed(t, kid)).Select(t => new { t.Title, t.OfficialRating }).ToList(),
                    allowed = plan.Catalog.Movies.Cast<TitleEntry>().Concat(plan.Catalog.Series)
                        .Where(t => IsAllowed(t, kid)).Select(t => new { t.Title, t.OfficialRating }).ToList(),
                },
            },
            discover = new
            {
                endpoint = $"{options.LocalUrl}/api/v1/viewer/catalog/discover",
                trendingMovies = MovieIds(plan.Catalog.Discover.TrendingMovies),
                trendingSeries = SeriesIds(plan.Catalog.Discover.TrendingSeries),
                popularMovies = MovieIds(plan.Catalog.Discover.PopularMovies),
                popularSeries = SeriesIds(plan.Catalog.Discover.PopularSeries),
            },
            variants = plan.Catalog.Variants.ToDictionary(v => v.Key, v => new
            {
                v.Value.Label,
                releaseIds = store.Releases.Where(r => r.Plan.Entry.Variant == v.Key).Select(r => r.ReleaseId).ToList(),
            }),
            titles,
        };
    }

    private static bool IsAllowed(TitleEntry title, ViewerPermissions permissions)
    {
        var minimumAge = ContentRatings.MinimumAge(title.OfficialRating);
        return minimumAge is null ? !permissions.BlockUnrated : minimumAge <= permissions.MaxAge;
    }
}
