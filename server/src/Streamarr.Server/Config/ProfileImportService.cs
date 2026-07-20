using System.Globalization;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;
using Streamarr.Core.Profiles;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Config;

public sealed class ProfileImportException(string message, bool requestError = false) : Exception(message)
{
    public bool RequestError { get; } = requestError;
}

/// <summary>Reads and translates Sonarr/Radarr quality profiles and custom-format scores.</summary>
public sealed class ProfileImportService(HttpClient http, TimeProvider timeProvider)
{
    private const int MaxResponseBytes = 4 * 1024 * 1024;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 48,
    };

    public async Task<ProfileImportPreviewResponse> PreviewAsync(
        ProfileImportPreviewRequest request,
        CancellationToken ct)
    {
        var source = ValidateSource(request?.Source);
        var baseUri = ValidateConnection(request?.BaseUrl, request?.ApiKey);
        var loaded = await LoadAsync(source, baseUri, request!.ApiKey, ct);
        return MapPreview(source, loaded);
    }

    public async Task<IReadOnlyList<QualityProfile>> BuildImportsAsync(
        ProfileImportRequest request,
        CancellationToken ct)
    {
        var source = ValidateSource(request?.Source);
        var baseUri = ValidateConnection(request?.BaseUrl, request?.ApiKey);
        if (request?.Profiles is null or { Count: 0 } || request.Profiles.Count > 100 ||
            request.Profiles.Select(profile => profile.ExternalId).Distinct().Count() != request.Profiles.Count)
        {
            throw new ProfileImportException("Select one or more unique profiles to import.", true);
        }

        if (request.Profiles.Any(profile => !ValidScope(profile.AppliesTo)))
            throw new ProfileImportException("Each imported profile must apply to movies, shows, or both.", true);

        var loaded = await LoadAsync(source, baseUri, request.ApiKey, ct);
        var preview = MapPreview(source, loaded);
        var byId = preview.Profiles.ToDictionary(profile => profile.ExternalId);
        var importedAt = timeProvider.GetUtcNow();
        var results = new List<QualityProfile>(request.Profiles.Count);
        foreach (var selection in request.Profiles)
        {
            if (!byId.TryGetValue(selection.ExternalId, out var candidate))
            {
                throw new ProfileImportException(
                    $"Profile {selection.ExternalId.ToString(CultureInfo.InvariantCulture)} no longer exists in {SourceName(source)}.",
                    true);
            }

            results.Add(candidate.Profile with
            {
                AppliesTo = selection.AppliesTo.ToLowerInvariant(),
                ImportedAtUtc = importedAt,
            });
        }

        return results;
    }

    private async Task<LoadedArr> LoadAsync(string source, Uri baseUri, string apiKey, CancellationToken ct)
    {
        try
        {
            var statusTask = GetAsync<ArrStatus>(baseUri, "system/status", apiKey, ct);
            var profilesTask = GetAsync<List<ArrQualityProfile>>(baseUri, "qualityprofile", apiKey, ct);
            var formatsTask = GetAsync<List<ArrCustomFormat>>(baseUri, "customformat", apiKey, ct);
            await Task.WhenAll(statusTask, profilesTask, formatsTask);
            return new LoadedArr(
                await statusTask,
                await profilesTask ?? [],
                await formatsTask ?? []);
        }
        catch (ProfileImportException)
        {
            throw;
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            throw new ProfileImportException($"{SourceName(source)} did not respond in time.");
        }
        catch (HttpRequestException)
        {
            throw new ProfileImportException($"Could not connect to {SourceName(source)} at the supplied URL.");
        }
        catch (JsonException)
        {
            throw new ProfileImportException($"{SourceName(source)} returned an unreadable API response.");
        }
    }

    private async Task<T?> GetAsync<T>(Uri baseUri, string endpoint, string apiKey, CancellationToken ct)
    {
        var uri = new Uri($"{baseUri.AbsoluteUri.TrimEnd('/')}/api/v3/{endpoint}", UriKind.Absolute);
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        request.Headers.Add("X-Api-Key", apiKey);
        request.Headers.Accept.ParseAdd("application/json");
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        if (!response.IsSuccessStatusCode)
        {
            var message = response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden
                ? "The API key was rejected."
                : $"The API returned HTTP {(int)response.StatusCode}.";
            throw new ProfileImportException(message);
        }

        if (response.Content.Headers.ContentLength is > MaxResponseBytes)
            throw new ProfileImportException("The API response was larger than the import limit.");

        await response.Content.LoadIntoBufferAsync(MaxResponseBytes);
        return await response.Content.ReadFromJsonAsync<T>(Json, ct);
    }

    private static ProfileImportPreviewResponse MapPreview(string source, LoadedArr loaded)
    {
        var formats = loaded.Formats.ToDictionary(format => format.Id);
        var candidates = loaded.Profiles
            .OrderBy(profile => profile.Name, StringComparer.OrdinalIgnoreCase)
            .Select(profile => MapCandidate(source, profile, formats))
            .ToArray();

        return new ProfileImportPreviewResponse
        {
            Source = source,
            InstanceName = string.IsNullOrWhiteSpace(loaded.Status?.InstanceName)
                ? SourceName(source)
                : loaded.Status.InstanceName,
            Version = loaded.Status?.Version,
            Profiles = candidates,
        };
    }

    private static ProfileImportCandidate MapCandidate(
        string source,
        ArrQualityProfile external,
        IReadOnlyDictionary<int, ArrCustomFormat> formats)
    {
        var qualities = FlattenQualities(external.Items ?? [])
            .Where(quality => quality.Allowed)
            .Select(quality => quality.Quality?.Name ?? quality.Name)
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Reverse()
            .ToArray();

        var customFormats = (external.FormatItems ?? [])
            .Where(item => item.Score != 0 && formats.ContainsKey(item.Format))
            .Select(item => MapFormat(source, item, formats[item.Format]))
            .ToArray();
        var allConditions = customFormats.SelectMany(format => format.Conditions).ToArray();
        var supported = allConditions.Count(IsSupported);
        var language = source == "radarr" ? LanguageNameToIso(external.Language?.Name) : null;
        var profile = new QualityProfile
        {
            Name = external.Name?.Trim() ?? $"Imported profile {external.Id}",
            AppliesTo = source == "radarr" ? "movies" : "shows",
            ImportedFrom = source,
            ImportedProfileId = external.Id,
            PreferredResolutions = qualities
                .Select(ResolutionFromQuality)
                .Where(value => value is not null)
                .Cast<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray(),
            PreferredSources = qualities
                .Select(SourceFromQuality)
                .Where(value => value is not null)
                .Cast<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray(),
            PreferredLanguages = language is null ? [] : [language],
            CustomFormats = customFormats,
            MinimumCustomFormatScore = external.MinFormatScore,
            SizeBands = new Dictionary<string, SizeBand>(
                DefaultProfiles.Standard.SizeBands,
                StringComparer.OrdinalIgnoreCase),
        };

        return new ProfileImportCandidate
        {
            ExternalId = external.Id,
            Name = profile.Name,
            SuggestedAppliesTo = profile.AppliesTo,
            QualityCount = qualities.Length,
            ScoredFormatCount = customFormats.Length,
            SupportedConditionCount = supported,
            UnsupportedConditionCount = allConditions.Length - supported,
            Profile = profile,
        };
    }

    private static IEnumerable<ArrQualityItem> FlattenQualities(IEnumerable<ArrQualityItem> items)
    {
        foreach (var item in items)
        {
            if (item.Items is { Count: > 0 })
            {
                foreach (var child in FlattenQualities(item.Items))
                    yield return child;
            }
            else
            {
                yield return item;
            }
        }
    }

    private static CustomFormatScore MapFormat(
        string source,
        ArrFormatItem score,
        ArrCustomFormat format) => new()
    {
        Name = string.IsNullOrWhiteSpace(score.Name) ? format.Name ?? $"Format {format.Id}" : score.Name,
        Score = score.Score,
        Conditions = (format.Specifications ?? [])
            .Select(specification => MapCondition(source, specification))
            .ToArray(),
    };

    private static CustomFormatCondition MapCondition(string source, ArrSpecification specification)
    {
        var implementation = Normalize(specification.Implementation);
        return new CustomFormatCondition
        {
            Name = specification.Name ?? string.Empty,
            Implementation = specification.Implementation ?? string.Empty,
            Negate = specification.Negate,
            Required = specification.Required,
            Value = ConvertValue(source, implementation, Field(specification, "value")),
            Min = NumberField(specification, "min"),
            Max = NumberField(specification, "max"),
            ExceptLanguage = BoolField(specification, "exceptLanguage"),
        };
    }

    private static string? ConvertValue(string source, string implementation, JsonElement? field)
    {
        if (field is null)
            return null;
        if (implementation is "releasetitle" or "releasegroup" or "edition")
            return field.Value.ValueKind == JsonValueKind.String ? field.Value.GetString() : field.Value.ToString();

        if (!TryInt(field.Value, out var value))
            return field.Value.ToString();

        return implementation switch
        {
            "resolution" => value <= 0 ? "SD" : $"{value.ToString(CultureInfo.InvariantCulture)}p",
            "source" => source == "radarr" ? RadarrSource(value) : SonarrSource(value),
            "qualitymodifier" => value switch
            {
                1 => "REGIONAL",
                2 => "SCR",
                3 => "HDTV",
                4 => "BluRay",
                5 => "Remux",
                _ => null,
            },
            "language" => source == "radarr" ? RadarrLanguage(value) : SonarrLanguage(value),
            "releasetype" => value switch
            {
                1 => "single-episode",
                2 => "multi-episode",
                3 => "season-pack",
                _ => null,
            },
            _ => field.Value.ToString(),
        };
    }

    private static string? RadarrSource(int value) => value switch
    {
        1 => "CAM",
        2 => "TS",
        3 => "TC",
        4 => "WORKPRINT",
        5 => "DVD,DVDR,SCR,REGIONAL",
        6 => "HDTV,PDTV,SDTV,TVRip,DSR",
        7 => "WEB-DL",
        8 => "WEBRip",
        9 => "BluRay,Remux,BDRip,BRRip",
        _ => null,
    };

    private static string? SonarrSource(int value) => value switch
    {
        1 => "HDTV,PDTV,SDTV,TVRip,DSR",
        2 => "HDTV",
        3 => "WEB-DL",
        4 => "WEBRip",
        5 => "DVD,DVDR",
        6 => "BluRay,BDRip,BRRip",
        7 => "Remux",
        _ => null,
    };

    private static string? RadarrLanguage(int value) => value switch
    {
        -2 => "original", -1 => "*", 1 => "en", 2 => "fr", 3 => "es", 4 => "de",
        5 => "it", 6 => "da", 7 => "nl", 8 => "ja", 9 => "is", 10 => "zh",
        11 => "ru", 12 => "pl", 13 => "vi", 14 => "sv", 15 => "no", 16 => "fi",
        17 => "tr", 18 => "pt", 19 => "nl", 20 => "el", 21 => "ko", 22 => "hu",
        23 => "he", 24 => "lt", 25 => "cs", 26 => "hi", 27 => "ro", 28 => "th",
        29 => "bg", 30 => "pt-BR", 31 => "ar", 32 => "uk", 33 => "fa", 34 => "bn",
        35 => "sk", 36 => "lv", 37 => "es-419", 38 => "ca", 39 => "hr", 40 => "sr",
        41 => "bs", 42 => "et", 43 => "ta", 44 => "id", 45 => "te", 46 => "mk",
        47 => "sl", 48 => "ml", 49 => "kn", 50 => "sq", 51 => "af", 52 => "mr",
        53 => "tl", 54 => "ur", 55 => "rm", 56 => "mn", 57 => "ka", _ => null,
    };

    private static string? SonarrLanguage(int value) => value switch
    {
        -2 => "original", 1 => "en", 2 => "fr", 3 => "es", 4 => "de", 5 => "it",
        6 => "da", 7 => "nl", 8 => "ja", 9 => "is", 10 => "zh", 11 => "ru",
        12 => "pl", 13 => "vi", 14 => "sv", 15 => "no", 16 => "fi", 17 => "tr",
        18 => "pt", 19 => "nl", 20 => "el", 21 => "ko", 22 => "hu", 23 => "he",
        24 => "lt", 25 => "cs", 26 => "ar", 27 => "hi", 28 => "bg", 29 => "ml",
        30 => "uk", 31 => "sk", 32 => "th", 33 => "pt-BR", 34 => "es-419", 35 => "ro",
        36 => "lv", 37 => "fa", 38 => "ca", 39 => "hr", 40 => "sr", 41 => "bs",
        42 => "et", 43 => "ta", 44 => "id", 45 => "mk", 46 => "sl", _ => null,
    };

    private static string? LanguageNameToIso(string? name) => name?.Trim().ToLowerInvariant() switch
    {
        "english" => "en", "french" => "fr", "spanish" => "es", "german" => "de",
        "italian" => "it", "dutch" => "nl", "japanese" => "ja", "chinese" => "zh",
        "russian" => "ru", "polish" => "pl", "swedish" => "sv", "norwegian" => "no",
        "finnish" => "fi", "portuguese" => "pt", "korean" => "ko", "czech" => "cs",
        "arabic" => "ar", "hindi" => "hi", "portuguese (brazil)" => "pt-BR",
        "spanish (latino)" => "es-419", _ => null,
    };

    private static string? ResolutionFromQuality(string name)
    {
        var match = System.Text.RegularExpressions.Regex.Match(name, @"(?<!\d)(2160|1080|720|576|540|480|360)p", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return match.Success ? $"{match.Groups[1].Value}p" : null;
    }

    private static string? SourceFromQuality(string name)
    {
        if (name.Contains("Remux", StringComparison.OrdinalIgnoreCase)) return "Remux";
        if (name.Contains("Bluray", StringComparison.OrdinalIgnoreCase)) return "BluRay";
        if (name.Contains("WEBDL", StringComparison.OrdinalIgnoreCase) || name.Contains("WEB-DL", StringComparison.OrdinalIgnoreCase)) return "WEB-DL";
        if (name.Contains("WEBRip", StringComparison.OrdinalIgnoreCase)) return "WEBRip";
        if (name.Contains("HDTV", StringComparison.OrdinalIgnoreCase)) return "HDTV";
        if (name.Contains("SDTV", StringComparison.OrdinalIgnoreCase)) return "SDTV";
        if (name.Contains("DVD", StringComparison.OrdinalIgnoreCase)) return "DVD";
        if (name.Contains("CAM", StringComparison.OrdinalIgnoreCase)) return "CAM";
        if (name.Contains("TELESYNC", StringComparison.OrdinalIgnoreCase)) return "TS";
        if (name.Contains("TELECINE", StringComparison.OrdinalIgnoreCase)) return "TC";
        if (name.Contains("WORKPRINT", StringComparison.OrdinalIgnoreCase)) return "WORKPRINT";
        return null;
    }

    private static bool IsSupported(CustomFormatCondition condition)
    {
        var implementation = Normalize(condition.Implementation);
        return implementation switch
        {
            "releasetitle" or "releasegroup" or "edition" or "resolution" or "source" or
            "qualitymodifier" or "releasetype" => !string.IsNullOrWhiteSpace(condition.Value),
            "language" => !string.IsNullOrWhiteSpace(condition.Value) && condition.Value != "original",
            "size" or "year" => condition.Min is not null && condition.Max is not null,
            _ => false,
        };
    }

    private static JsonElement? Field(ArrSpecification specification, string name)
        => specification.Fields is not null && specification.Fields.TryGetValue(name, out var value)
            ? value
            : null;

    private static double? NumberField(ArrSpecification specification, string name)
    {
        var value = Field(specification, name);
        if (value is null) return null;
        if (value.Value.ValueKind == JsonValueKind.Number && value.Value.TryGetDouble(out var number)) return number;
        return double.TryParse(value.Value.ToString(), NumberStyles.Float, CultureInfo.InvariantCulture, out number)
            ? number
            : null;
    }

    private static bool BoolField(ArrSpecification specification, string name)
    {
        var value = Field(specification, name);
        if (value is null) return false;
        if (value.Value.ValueKind is JsonValueKind.True or JsonValueKind.False) return value.Value.GetBoolean();
        return bool.TryParse(value.Value.ToString(), out var parsed) && parsed;
    }

    private static bool TryInt(JsonElement value, out int parsed)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt32(out parsed)) return true;
        return int.TryParse(value.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed);
    }

    private static string ValidateSource(string? source)
    {
        var normalized = source?.Trim().ToLowerInvariant();
        return normalized is "sonarr" or "radarr"
            ? normalized
            : throw new ProfileImportException("Source must be Sonarr or Radarr.", true);
    }

    private static Uri ValidateConnection(string? baseUrl, string? apiKey)
    {
        if (string.IsNullOrWhiteSpace(baseUrl) || baseUrl.Length > 2048 ||
            !Uri.TryCreate(baseUrl, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") || string.IsNullOrWhiteSpace(uri.Host) ||
            !string.IsNullOrEmpty(uri.UserInfo) || !string.IsNullOrEmpty(uri.Query) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new ProfileImportException("Base URL must be an absolute HTTP(S) URL without credentials or a query string.", true);
        }

        if (string.IsNullOrWhiteSpace(apiKey) || apiKey.Length > 256 || apiKey.Any(char.IsControl))
            throw new ProfileImportException("Enter a valid API key.", true);
        return uri;
    }

    private static bool ValidScope(string? value)
        => value is not null && (value.Equals("both", StringComparison.OrdinalIgnoreCase) ||
                                 value.Equals("movies", StringComparison.OrdinalIgnoreCase) ||
                                 value.Equals("shows", StringComparison.OrdinalIgnoreCase));

    private static string SourceName(string source)
        => source == "radarr" ? "Radarr" : "Sonarr";

    private static string Normalize(string? value)
    {
        var normalized = new string((value ?? string.Empty).Where(char.IsLetterOrDigit)
            .Select(char.ToLowerInvariant)
            .ToArray());
        return normalized.EndsWith("specification", StringComparison.Ordinal)
            ? normalized[..^"specification".Length]
            : normalized;
    }

    private sealed record LoadedArr(ArrStatus? Status, List<ArrQualityProfile> Profiles, List<ArrCustomFormat> Formats);

    private sealed record ArrStatus
    {
        public string? InstanceName { get; init; }
        public string? Version { get; init; }
    }

    private sealed record ArrQualityProfile
    {
        public int Id { get; init; }
        public string? Name { get; init; }
        public int MinFormatScore { get; init; }
        public List<ArrQualityItem>? Items { get; init; }
        public List<ArrFormatItem>? FormatItems { get; init; }
        public ArrLanguage? Language { get; init; }
    }

    private sealed record ArrLanguage { public string? Name { get; init; } }

    private sealed record ArrQualityItem
    {
        public string Name { get; init; } = string.Empty;
        public bool Allowed { get; init; }
        public ArrQuality? Quality { get; init; }
        public List<ArrQualityItem>? Items { get; init; }
    }

    private sealed record ArrQuality { public string? Name { get; init; } }

    private sealed record ArrFormatItem
    {
        public int Format { get; init; }
        public string? Name { get; init; }
        public int Score { get; init; }
    }

    private sealed record ArrCustomFormat
    {
        public int Id { get; init; }
        public string? Name { get; init; }
        public List<ArrSpecification>? Specifications { get; init; }
    }

    private sealed record ArrSpecification
    {
        public string? Name { get; init; }
        public string? Implementation { get; init; }
        public bool Negate { get; init; }
        public bool Required { get; init; }
        public Dictionary<string, JsonElement>? Fields { get; init; }
    }
}
