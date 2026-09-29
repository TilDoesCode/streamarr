using System.Globalization;
using System.Text.Json;
using Streamarr.Core.Parser;

namespace Streamarr.DevWorld;

/// <summary>The checked-in fixture catalog (fixtures/catalog.json).</summary>
public sealed record DevCatalog
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public int SchemaVersion { get; init; }
    public CatalogDefaults Defaults { get; init; } = new();
    public Dictionary<string, VariantSpec> Variants { get; init; } = [];
    public List<MovieEntry> Movies { get; init; } = [];
    public List<SeriesEntry> Series { get; init; } = [];
    public DiscoverLists Discover { get; init; } = new();

    public const int SupportedSchemaVersion = 1;

    public static DevCatalog Load(string path)
    {
        var catalog = JsonSerializer.Deserialize<DevCatalog>(File.ReadAllText(path), Json)
                      ?? throw new InvalidDataException($"Empty catalog: {path}");
        return catalog.SchemaVersion == SupportedSchemaVersion
            ? catalog
            : throw new InvalidDataException($"{path}: schemaVersion {catalog.SchemaVersion} is not {SupportedSchemaVersion}.");
    }
}

public sealed record CatalogDefaults
{
    public int MovieDurationSeconds { get; init; } = 180;
    public int EpisodeDurationSeconds { get; init; } = 120;
    public int PartSizeBytes { get; init; } = 262_144;
}

/// <summary>Title keys of the canned TMDB trending/popular lists (viewer home rows), in order.</summary>
public sealed record DiscoverLists
{
    public List<string> TrendingMovies { get; init; } = [];
    public List<string> TrendingSeries { get; init; } = [];
    public List<string> PopularMovies { get; init; } = [];
    public List<string> PopularSeries { get; init; } = [];

    /// <summary>At most this many listed titles may have no release (they exercise the empty-versions state).</summary>
    public const int MaxTitlesWithoutReleases = 2;
}

public sealed record VariantSpec
{
    public string Label { get; init; } = string.Empty;
    public string Container { get; init; } = "mkv";
    public double NominalMbps { get; init; } = 5;
    public int? DurationSeconds { get; init; }
    public string? Fps { get; init; }
    public VideoSpec Video { get; init; } = new();
    public List<AudioSpec> Audio { get; init; } = [];
    public List<SubtitleSpec> Subtitles { get; init; } = [];
}

public sealed record VideoSpec
{
    public string Codec { get; init; } = "h264";
    public int Width { get; init; }
    public int Height { get; init; }
    public int BitDepth { get; init; } = 8;
    public string? Hdr { get; init; }
    public int Kbps { get; init; } = 400;
    public string? Aspect { get; init; }
}

public sealed record AudioSpec
{
    public string Codec { get; init; } = "aac";
    public int Channels { get; init; } = 2;
    public string Language { get; init; } = "eng";
    public string Title { get; init; } = string.Empty;
    public int? Kbps { get; init; }
    public bool Default { get; init; }
}

public sealed record SubtitleSpec
{
    public string Format { get; init; } = "srt";
    public string Language { get; init; } = "eng";
    public string Title { get; init; } = string.Empty;
    public bool Forced { get; init; }
}

public abstract record TitleEntry
{
    public string Key { get; init; } = string.Empty;
    public int TmdbId { get; init; }
    public string? ImdbId { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? TitleDe { get; init; }
    public string? OriginalTitle { get; init; }
    public int? Year { get; init; }
    public string? Overview { get; init; }
    public string? Tagline { get; init; }
    public List<string> Genres { get; init; } = [];
    public float? CommunityRating { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? LogoUrl { get; init; }
    public string? License { get; init; }
    public string AccentColor { get; init; } = "#888888";
    public string Fps { get; init; } = "24000/1001";
    public int? RuntimeMinutes { get; init; }
    public Dictionary<string, string> Certifications { get; init; } = [];
    public string? OfficialRating { get; init; }
}

public sealed record MovieEntry : TitleEntry
{
    public List<ReleaseEntry> Releases { get; init; } = [];
}

public sealed record SeriesEntry : TitleEntry
{
    public List<SeasonEntry> Seasons { get; init; } = [];
    public List<ReleaseEntry> SeasonPacks { get; init; } = [];
}

public sealed record SeasonEntry
{
    public int SeasonNumber { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? PosterUrl { get; init; }
    public List<EpisodeEntry> Episodes { get; init; } = [];
}

public sealed record EpisodeEntry
{
    public int EpisodeNumber { get; init; }
    public string Title { get; init; } = string.Empty;
    public string? AirDate { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? Overview { get; init; }
    public string? StillUrl { get; init; }
    public List<ReleaseEntry> Releases { get; init; } = [];
}

public sealed record ReleaseEntry
{
    public string Name { get; init; } = string.Empty;
    public string Variant { get; init; } = string.Empty;
    public int Grabs { get; init; }
    public int AgeDays { get; init; }
    /// <summary>ready | dead | degraded.</summary>
    public string Health { get; init; } = "ready";
    public double? NominalMbps { get; init; }
    /// <summary>Season packs only.</summary>
    public int? Season { get; init; }
}

/// <summary>One generated media file: a (title or episode, variant) pair.</summary>
public sealed record PlannedMedia(
    string Key,
    string VariantId,
    VariantSpec Variant,
    string BurnTitle,
    string BurnLabel,
    int DurationSeconds,
    string Fps,
    string AccentColor)
{
    public string Extension => Variant.Container;
}

/// <summary>One indexer release: a name, its health script and the media file(s) its NZB carries.</summary>
public sealed record PlannedRelease(
    ReleaseEntry Entry,
    TitleEntry Title,
    string MediaType,
    int? Season,
    int? Episode,
    string WorkId,
    int RuntimeMinutes,
    IReadOnlyList<(PlannedMedia Media, string FileName)> Files)
{
    public string Name => Entry.Name;
    public string Guid => $"devworld:{Entry.Name}";
    public bool IsSeasonPack => MediaType == "tv" && Episode is null;

    /// <summary>What the indexer reports: nominal bitrate x TMDB runtime x file count.</summary>
    public long ReportedSizeBytes
        => (long)((Entry.NominalMbps ?? Files[0].Media.Variant.NominalMbps) * 1_000_000 / 8 * RuntimeMinutes * 60 * Files.Count);
}

public sealed class WorldPlan
{
    public required DevCatalog Catalog { get; init; }
    public required IReadOnlyList<PlannedMedia> Media { get; init; }
    public required IReadOnlyList<PlannedRelease> Releases { get; init; }

    public static WorldPlan Build(DevCatalog catalog)
    {
        var media = new Dictionary<string, PlannedMedia>(StringComparer.Ordinal);
        var releases = new List<PlannedRelease>();
        var problems = new List<string>();

        PlannedMedia MediaFor(TitleEntry title, string key, string burnTitle, string variantId, int defaultDuration)
        {
            if (!catalog.Variants.TryGetValue(variantId, out var variant))
                throw new InvalidDataException($"Unknown variant '{variantId}' for {key}.");
            var mediaKey = $"{key}__{variantId}";
            if (!media.TryGetValue(mediaKey, out var planned))
            {
                planned = new PlannedMedia(
                    mediaKey, variantId, variant, burnTitle, variant.Label,
                    variant.DurationSeconds ?? defaultDuration, variant.Fps ?? title.Fps, title.AccentColor);
                media[mediaKey] = planned;
            }

            return planned;
        }

        foreach (var movie in catalog.Movies)
        {
            var burn = $"{movie.Title} ({movie.Year})";
            foreach (var entry in movie.Releases)
            {
                var file = MediaFor(movie, movie.Key, burn, entry.Variant, catalog.Defaults.MovieDurationSeconds);
                var release = new PlannedRelease(entry, movie, "movie", null, null, $"tmdb-movie-{movie.TmdbId}",
                    movie.RuntimeMinutes ?? 90, [(file, $"{entry.Name}.{file.Extension}")]);
                problems.AddRange(Validate(release));
                releases.Add(release);
            }
        }

        foreach (var series in catalog.Series)
        {
            foreach (var season in series.Seasons)
            {
                foreach (var episode in season.Episodes)
                {
                    var key = $"{series.Key}-s{season.SeasonNumber:00}e{episode.EpisodeNumber:00}";
                    var burn = $"{series.Title} S{season.SeasonNumber:00}E{episode.EpisodeNumber:00} {episode.Title}";
                    foreach (var entry in episode.Releases)
                    {
                        var file = MediaFor(series, key, burn, entry.Variant, catalog.Defaults.EpisodeDurationSeconds);
                        var release = new PlannedRelease(entry, series, "tv", season.SeasonNumber, episode.EpisodeNumber,
                            $"tmdb-tv-{series.TmdbId}-s{season.SeasonNumber:00}e{episode.EpisodeNumber:00}",
                            episode.RuntimeMinutes ?? series.RuntimeMinutes ?? 45, [(file, $"{entry.Name}.{file.Extension}")]);
                        problems.AddRange(Validate(release));
                        releases.Add(release);
                    }
                }
            }

            foreach (var pack in series.SeasonPacks)
            {
                var season = series.Seasons.Single(s => s.SeasonNumber == pack.Season);
                var files = new List<(PlannedMedia, string)>();
                foreach (var episode in season.Episodes)
                {
                    var key = $"{series.Key}-s{season.SeasonNumber:00}e{episode.EpisodeNumber:00}";
                    var mediaKey = $"{key}__{pack.Variant}";
                    if (!media.TryGetValue(mediaKey, out var file))
                    {
                        problems.Add($"{pack.Name}: season pack reuses episode media, but {mediaKey} has no episode release.");
                        continue;
                    }

                    var episodeName = pack.Name.Replace(
                        $"S{season.SeasonNumber:00}.", $"S{season.SeasonNumber:00}E{episode.EpisodeNumber:00}.", StringComparison.Ordinal);
                    files.Add((file, $"{episodeName}.{file.Extension}"));
                }

                var release = new PlannedRelease(pack, series, "tv", season.SeasonNumber, null,
                    $"tmdb-tv-{series.TmdbId}-s{season.SeasonNumber:00}", series.RuntimeMinutes ?? 45, files);
                problems.AddRange(Validate(release));
                releases.Add(release);
            }
        }

        if (releases.Select(r => r.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != releases.Count)
            problems.Add("Release names must be unique.");
        problems.AddRange(ValidateDiscover(catalog, releases));
        if (problems.Count > 0)
            throw new InvalidDataException("Fixture catalog is inconsistent:\n  " + string.Join("\n  ", problems));

        return new WorldPlan { Catalog = catalog, Media = media.Values.ToList(), Releases = releases };
    }

    /// <summary>Home rows may only list catalog titles of the right type, and at most two of them without any release.</summary>
    private static IEnumerable<string> ValidateDiscover(DevCatalog catalog, IReadOnlyList<PlannedRelease> releases)
    {
        var movies = catalog.Movies.ToDictionary(m => m.Key, StringComparer.Ordinal);
        var series = catalog.Series.ToDictionary(s => s.Key, StringComparer.Ordinal);
        var lists = new (string Name, List<string> Keys, bool Movie)[]
        {
            ("trendingMovies", catalog.Discover.TrendingMovies, true),
            ("trendingSeries", catalog.Discover.TrendingSeries, false),
            ("popularMovies", catalog.Discover.PopularMovies, true),
            ("popularSeries", catalog.Discover.PopularSeries, false),
        };
        foreach (var (name, keys, movie) in lists)
        {
            foreach (var key in keys.Where(k => movie ? !movies.ContainsKey(k) : !series.ContainsKey(k)))
                yield return $"discover.{name}: '{key}' is not a catalog {(movie ? "movie" : "series")}.";
        }

        var playable = releases.Select(r => r.Title.Key).ToHashSet(StringComparer.Ordinal);
        var empty = lists.SelectMany(l => l.Keys).Distinct().Where(k => !playable.Contains(k)).ToList();
        if (empty.Count > DiscoverLists.MaxTitlesWithoutReleases)
            yield return $"discover lists {empty.Count} titles without releases ({string.Join(", ", empty)}); at most {DiscoverLists.MaxTitlesWithoutReleases} are allowed.";
    }

    /// <summary>The ranker must see what the file really is: the parsed name has to match the variant.</summary>
    private static IEnumerable<string> Validate(PlannedRelease release)
    {
        var parsed = ReleaseParser.Parse(release.Name);
        var variant = release.Files[0].Media.Variant;
        var primaryAudio = variant.Audio.FirstOrDefault(a => a.Default) ?? variant.Audio[0];

        var expected = new Dictionary<string, (string? Want, string? Got)>
        {
            ["resolution"] = ($"{variant.Video.Height}p", parsed.Resolution),
            ["videoCodec"] = (variant.Video.Codec switch
            {
                "h264" => "x264",
                "hevc" => "x265",
                "av1" => "AV1",
                "mpeg2video" => "MPEG-2",
                var other => other,
            }, parsed.VideoCodec),
            ["audioCodec"] = (primaryAudio.Codec switch
            {
                "aac" => "AAC",
                "eac3" => "DDP",
                "ac3" => "DD",
                "dts" => "DTS",
                "truehd" => "TrueHD",
                "opus" => "Opus",
                var other => other,
            }, parsed.AudioCodec),
            ["audioChannels"] = (primaryAudio.Channels switch { 2 => "2.0", 6 => "5.1", 8 => "7.1", var c => $"{c}" }, parsed.AudioChannels),
            ["hdr"] = (variant.Video.Hdr == "hdr10" ? "HDR10" : null, parsed.Hdr),
        };

        foreach (var (field, (want, got)) in expected)
        {
            if (!string.Equals(want, got, StringComparison.Ordinal))
                yield return $"{release.Name}: {field} parses as '{got ?? "null"}' but the variant '{release.Entry.Variant}' is '{want ?? "null"}'.";
        }

        var hasGerman = variant.Audio.Any(a => a.Language == "ger");
        if (hasGerman != parsed.Languages.Contains("de"))
            yield return $"{release.Name}: German audio is {(hasGerman ? "present" : "absent")} but the name parses languages [{string.Join(",", parsed.Languages)}].";

        var normalizedTitle = Normalize(release.Title.Title);
        if (!string.Equals(Normalize(parsed.Title ?? string.Empty), normalizedTitle, StringComparison.Ordinal))
            yield return $"{release.Name}: title parses as '{parsed.Title}' instead of '{release.Title.Title}'.";

        if (release.MediaType == "movie")
        {
            if (parsed.MediaType != ParsedMediaType.Movie || parsed.Year != release.Title.Year)
                yield return $"{release.Name}: expected a movie of {release.Title.Year}, parsed {parsed.MediaType} {parsed.Year}.";
        }
        else if (release.IsSeasonPack)
        {
            if (!parsed.SeasonPack || parsed.Season != release.Season)
                yield return $"{release.Name}: expected a season {release.Season} pack.";
        }
        else if (parsed.Season != release.Season || parsed.Episodes.Count != 1 || parsed.Episodes[0] != release.Episode)
        {
            yield return $"{release.Name}: expected S{release.Season:00}E{release.Episode:00}.";
        }

        if (release.Entry.Health is not ("ready" or "dead" or "degraded"))
            yield return $"{release.Name}: health must be ready, dead or degraded.";
    }

    private static string Normalize(string value)
        => string.Join(' ', value.ToLower(CultureInfo.InvariantCulture)
            .Split((char[])[' ', '.', '-', '_', ':', '\'', '(', ')'], StringSplitOptions.RemoveEmptyEntries));
}
