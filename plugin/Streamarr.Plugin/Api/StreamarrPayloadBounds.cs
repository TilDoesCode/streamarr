namespace Streamarr.Plugin.Api;

/// <summary>
/// Defensive bounds for data received from Core. Core is trusted, but a compromised or buggy
/// instance must not turn a Jellyfin search into an unbounded in-memory/persisted object graph.
/// </summary>
internal static class StreamarrPayloadBounds
{
    internal const int MaxWorksPerSearch = 20;
    internal const int MaxReleasesPerWork = 20;
    internal const int MaxMediaStreams = 64;
    internal const int MaxSeasonsPerSeries = 250;
    internal const int MaxEpisodesPerSeason = 1_000;

    internal static SearchResponse Normalize(SearchResponse response) => response with
    {
        Results = (response.Results ?? [])
            .Take(MaxWorksPerSearch)
            .Select(Normalize)
            .Where(work => work is not null)
            .Cast<WorkDto>()
            .ToArray(),
    };

    internal static WorkDto? Normalize(WorkDto? work)
    {
        if (work is null
            || !TryIdentifier(work.WorkId, 256, out var workId)
            || !TryText(work.Title, 512, required: true, out var title))
        {
            return null;
        }

        var mediaType = work.MediaType?.Trim().ToLowerInvariant();
        if (mediaType is not ("movie" or "tv" or "episode"))
            return null;

        return work with
        {
            WorkId = workId,
            MediaType = mediaType,
            Title = title!,
            Year = work.Year is >= 1800 and <= 3000 ? work.Year : null,
            TmdbId = work.TmdbId is > 0 ? work.TmdbId : null,
            ImdbId = BoundedText(work.ImdbId, 64),
            Overview = BoundedText(work.Overview, 8 * 1024),
            PosterUrl = BoundedHttpUrl(work.PosterUrl),
            BackdropUrl = BoundedHttpUrl(work.BackdropUrl),
            RuntimeMinutes = work.RuntimeMinutes is > 0 and <= 1440 ? work.RuntimeMinutes : null,
            OriginalTitle = BoundedText(work.OriginalTitle, 512),
            Tagline = BoundedText(work.Tagline, 2_048),
            OfficialRating = BoundedText(work.OfficialRating, 32),
            CommunityRating = Rating(work.CommunityRating),
            Genres = TextList(work.Genres, 64, 256),
            Studios = TextList(work.Studios, 64, 256),
            ProductionLocations = TextList(work.ProductionLocations, 64, 256),
            People = NormalizePeople(work.People),
            TrailerUrl = BoundedHttpUrl(work.TrailerUrl),
            Season = work.Season is >= 0 and <= 100_000 ? work.Season : null,
            Episode = work.Episode is >= 0 and <= 100_000 ? work.Episode : null,
            Releases = (work.Releases ?? [])
                .Take(MaxReleasesPerWork)
                .Select(Normalize)
                .Where(release => release is not null)
                .Cast<ReleaseDto>()
                .ToArray(),
        };
    }

    internal static TvSeriesSearchResponse Normalize(TvSeriesSearchResponse response) => response with
    {
        Results = (response.Results ?? [])
            .Take(3)
            .Select(Normalize)
            .Where(series => series is not null)
            .Cast<TvSeriesDto>()
            .ToArray(),
    };

    internal static TvSeriesDetailsResponse? Normalize(TvSeriesDetailsResponse? response)
    {
        var series = Normalize(response?.Series);
        if (series is null)
            return null;

        return response! with
        {
            Series = series,
            Seasons = (response.Seasons ?? [])
                .Take(MaxSeasonsPerSeries)
                .Select(Normalize)
                .Where(season => season is not null && season.TmdbId == series.TmdbId)
                .Cast<TvSeasonDto>()
                .OrderBy(season => season.SeasonNumber)
                .ToArray(),
        };
    }

    internal static TvSeasonDetailsResponse? Normalize(TvSeasonDetailsResponse? response)
    {
        var series = Normalize(response?.Series);
        var season = Normalize(response?.Season);
        if (series is null || season is null || series.TmdbId != season.TmdbId)
            return null;

        return response! with
        {
            Series = series,
            Season = season,
            Episodes = (response.Episodes ?? [])
                .Take(MaxEpisodesPerSeason)
                .Select(Normalize)
                .Where(episode => episode is not null
                                  && episode.TmdbId == series.TmdbId
                                  && episode.SeasonNumber == season.SeasonNumber)
                .Cast<TvEpisodeDto>()
                .OrderBy(episode => episode.EpisodeNumber)
                .ToArray(),
        };
    }

    internal static ResolveResponse? Normalize(ResolveResponse? response)
    {
        if (response is null || !TryIdentifier(response.ReleaseId, 256, out var releaseId))
            return null;

        return response with
        {
            ReleaseId = releaseId,
            Status = BoundedText(response.Status, 32) ?? "dead",
            StreamUrl = BoundedText(response.StreamUrl, 2048),
            Container = BoundedText(response.Container, 32),
            SizeBytes = response.SizeBytes is >= 0 ? response.SizeBytes : null,
            RunTimeTicks = response.RunTimeTicks is >= 0 ? response.RunTimeTicks : null,
            MediaStreams = (response.MediaStreams ?? [])
                .Take(MaxMediaStreams)
                .Where(stream => stream is not null)
                .Select(stream => stream with
                {
                    Type = BoundedText(stream.Type, 16) ?? "Video",
                    Codec = BoundedText(stream.Codec, 32),
                    Width = stream.Width is > 0 and <= 32_768 ? stream.Width : null,
                    Height = stream.Height is > 0 and <= 32_768 ? stream.Height : null,
                    Channels = stream.Channels is > 0 and <= 128 ? stream.Channels : null,
                    Language = BoundedText(stream.Language, 32),
                })
                .ToArray(),
            SessionTtlSeconds = Math.Clamp(response.SessionTtlSeconds, 0, 2_592_000),
            SuggestedFallbackReleaseId = TryIdentifier(response.SuggestedFallbackReleaseId, 256, out var fallback)
                ? fallback
                : null,
            FallbackFromReleaseId = TryIdentifier(response.FallbackFromReleaseId, 256, out var fallbackFrom)
                ? fallbackFrom
                : null,
            Attempts = (response.Attempts ?? [])
                .Take(16)
                .Where(attempt => attempt is not null)
                .Where(attempt => TryIdentifier(attempt.ReleaseId, 256, out _))
                .Select(attempt => attempt with
                {
                    Status = BoundedText(attempt.Status, 32) ?? "unknown",
                })
                .ToArray(),
        };
    }

    internal static HealthResponse Normalize(HealthResponse response) => response with
    {
        Status = BoundedText(response.Status, 64),
        Version = BoundedText(response.Version, 64),
        Indexers = Normalize(response.Indexers),
        Providers = Normalize(response.Providers),
    };

    internal static CapsResponse Normalize(CapsResponse response) => response with
    {
        MediaTypes = (response.MediaTypes ?? [])
            .Take(16)
            .Select(value => BoundedText(value, 32))
            .Where(value => value is not null)
            .Cast<string>()
            .ToArray(),
        Categories = (response.Categories ?? [])
            .Take(128)
            .Where(value => value is not null)
            .Select(value => value with { Name = BoundedText(value.Name, 128) ?? string.Empty })
            .ToArray(),
        Providers = (response.Providers ?? [])
            .Take(128)
            .Where(value => value is not null)
            .Select(value => value with { Name = BoundedText(value.Name, 128) ?? string.Empty })
            .ToArray(),
    };

    private static IReadOnlyList<ReachabilityStatus> Normalize(IReadOnlyList<ReachabilityStatus>? values)
        => (values ?? [])
            .Take(64)
            .Where(value => value is not null)
            .Select(value => value with
            {
                Name = BoundedText(value.Name, 128),
                Error = BoundedText(value.Error, 512),
            })
            .ToArray();

    private static ReleaseDto? Normalize(ReleaseDto? release)
    {
        if (release is null || !TryIdentifier(release.ReleaseId, 256, out var releaseId))
            return null;

        var quality = release.Quality ?? new QualityDto();
        return release with
        {
            ReleaseId = releaseId,
            Title = BoundedText(release.Title, 512) ?? releaseId,
            Indexer = BoundedText(release.Indexer, 128) ?? string.Empty,
            SizeBytes = Math.Max(0, release.SizeBytes),
            Quality = quality with
            {
                Resolution = BoundedText(quality.Resolution, 64),
                Source = BoundedText(quality.Source, 64),
                Codec = BoundedText(quality.Codec, 64),
                Hdr = BoundedText(quality.Hdr, 64),
                Audio = BoundedText(quality.Audio, 64),
                Edition = BoundedText(quality.Edition, 128),
            },
            Languages = (release.Languages ?? [])
                .Take(8)
                .Select(language => BoundedText(language, 32))
                .Where(language => language is not null)
                .Cast<string>()
                .ToArray(),
            ReleaseGroup = BoundedText(release.ReleaseGroup, 128),
            AgeDays = Math.Max(0, release.AgeDays),
            Grabs = Math.Max(0, release.Grabs),
            RejectionReasons = (release.RejectionReasons ?? [])
                .Take(8)
                .Select(reason => BoundedText(reason, 256))
                .Where(reason => reason is not null)
                .Cast<string>()
                .ToArray(),
            Health = BoundedText(release.Health, 32) ?? "unknown",
        };
    }

    private static IReadOnlyList<string> TextList(
        IReadOnlyList<string>? values,
        int take,
        int maxChars)
        => (values ?? [])
            .Take(take)
            .Select(value => BoundedText(value, maxChars))
            .Where(value => value is not null)
            .Cast<string>()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

    private static IReadOnlyList<PersonDto> NormalizePeople(IReadOnlyList<PersonDto>? people)
        => (people ?? [])
            .Take(100)
            .Where(person => person is not null)
            .Select(person => person with
            {
                Name = BoundedText(person.Name, 256) ?? string.Empty,
                Type = BoundedText(person.Type, 32) ?? string.Empty,
                Role = BoundedText(person.Role, 256),
                SortOrder = person.SortOrder is >= 0 and <= 10_000 ? person.SortOrder : null,
                TmdbId = person.TmdbId is > 0 ? person.TmdbId : null,
                ProfileUrl = BoundedHttpUrl(person.ProfileUrl),
            })
            .Where(person => person.Name.Length > 0
                             && person.Type is "Actor" or "Director" or "Writer" or "Producer" or "Composer")
            .ToArray();

    private static float? Rating(float? value)
        => value is >= 0 and <= 10 ? value : null;

    private static TvSeriesDto? Normalize(TvSeriesDto? series)
    {
        if (series is null
            || series.TmdbId <= 0
            || !TryIdentifier(series.WorkId, 256, out var workId)
            || !TryText(series.Title, 512, required: true, out var title))
        {
            return null;
        }

        return series with
        {
            WorkId = workId,
            MediaType = "series",
            Title = title!,
            Year = series.Year is >= 1800 and <= 3000 ? series.Year : null,
            ImdbId = BoundedText(series.ImdbId, 64),
            Overview = BoundedText(series.Overview, 8 * 1024),
            PosterUrl = BoundedHttpUrl(series.PosterUrl),
            BackdropUrl = BoundedHttpUrl(series.BackdropUrl),
            RuntimeMinutes = series.RuntimeMinutes is > 0 and <= 1440 ? series.RuntimeMinutes : null,
            SeasonCount = series.SeasonCount is >= 0 and <= MaxSeasonsPerSeries ? series.SeasonCount : null,
            EpisodeCount = series.EpisodeCount is >= 0 and <= 100_000 ? series.EpisodeCount : null,
            OriginalTitle = BoundedText(series.OriginalTitle, 512),
            Tagline = BoundedText(series.Tagline, 2_048),
            OfficialRating = BoundedText(series.OfficialRating, 32),
            CommunityRating = Rating(series.CommunityRating),
            Genres = TextList(series.Genres, 64, 256),
            Studios = TextList(series.Studios, 64, 256),
            ProductionLocations = TextList(series.ProductionLocations, 64, 256),
            People = NormalizePeople(series.People),
            TrailerUrl = BoundedHttpUrl(series.TrailerUrl),
        };
    }

    private static TvSeasonDto? Normalize(TvSeasonDto? season)
    {
        if (season is null
            || season.TmdbId <= 0
            || season.SeasonNumber is < 0 or > 100_000
            || !TryIdentifier(season.WorkId, 256, out var workId)
            || !TryText(season.Title, 512, required: true, out var title))
        {
            return null;
        }

        return season with
        {
            WorkId = workId,
            MediaType = "season",
            Title = title!,
            Overview = BoundedText(season.Overview, 8 * 1024),
            AirDate = BoundedText(season.AirDate, 32),
            PosterUrl = BoundedHttpUrl(season.PosterUrl),
            EpisodeCount = Math.Clamp(season.EpisodeCount, 0, MaxEpisodesPerSeason),
        };
    }

    private static TvEpisodeDto? Normalize(TvEpisodeDto? episode)
    {
        if (episode is null
            || episode.TmdbId <= 0
            || episode.SeasonNumber is < 0 or > 100_000
            || episode.EpisodeNumber is < 1 or > 100_000
            || !TryIdentifier(episode.WorkId, 256, out var workId)
            || !TryText(episode.SeriesTitle, 512, required: true, out var seriesTitle)
            || !TryText(episode.Title, 512, required: true, out var title))
        {
            return null;
        }

        return episode with
        {
            WorkId = workId,
            MediaType = "episode",
            SeriesTitle = seriesTitle!,
            Title = title!,
            Overview = BoundedText(episode.Overview, 8 * 1024),
            AirDate = BoundedText(episode.AirDate, 32),
            RuntimeMinutes = episode.RuntimeMinutes is > 0 and <= 1440 ? episode.RuntimeMinutes : null,
            StillUrl = BoundedHttpUrl(episode.StillUrl),
            CommunityRating = Rating(episode.CommunityRating),
            People = NormalizePeople(episode.People),
            Releases = (episode.Releases ?? [])
                .Take(MaxReleasesPerWork)
                .Select(Normalize)
                .Where(release => release is not null)
                .Cast<ReleaseDto>()
                .ToArray(),
        };
    }

    private static string? BoundedHttpUrl(string? value)
    {
        var bounded = BoundedText(value, 2048);
        return bounded is not null
               && Uri.TryCreate(bounded, UriKind.Absolute, out var uri)
               && (string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
                   || string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
               && string.IsNullOrEmpty(uri.UserInfo)
            ? bounded
            : null;
    }

    private static bool TryIdentifier(string? value, int maximumLength, out string bounded)
    {
        bounded = value ?? string.Empty;
        return bounded.Length is > 0
               && bounded.Length <= maximumLength
               && !string.IsNullOrWhiteSpace(bounded)
               && string.Equals(bounded, bounded.Trim(), StringComparison.Ordinal)
               && !bounded.Any(char.IsControl);
    }

    private static bool TryText(string? value, int maximumLength, bool required, out string? bounded)
    {
        bounded = BoundedText(value, maximumLength);
        return !required || !string.IsNullOrWhiteSpace(bounded);
    }

    private static string? BoundedText(string? value, int maximumLength)
    {
        if (string.IsNullOrEmpty(value))
            return null;

        var source = value.AsSpan(0, Math.Min(value.Length, maximumLength));
        var result = new char[source.Length];
        for (var index = 0; index < source.Length; index++)
            result[index] = char.IsControl(source[index]) ? ' ' : source[index];
        var normalized = new string(result).Trim();
        return normalized.Length == 0 ? null : normalized;
    }
}
