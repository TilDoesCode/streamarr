using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Options;

namespace Streamarr.Server.Logging;

internal sealed class JellyfinLogSource(
    IHttpClientFactory httpClientFactory,
    IOptions<JellyfinLogOptions> options,
    TimeProvider timeProvider) : IJellyfinLogSource
{
    internal const string HttpClientName = "streamarr-jellyfin-logs";
    internal const int MaximumLogBytes = 4 * 1024 * 1024;
    internal const int MaximumListBytes = 256 * 1024;

    private static readonly TimeSpan HardTimeout = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(15);
    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = true,
    };

    private readonly SemaphoreSlim _refreshLock = new(1, 1);
    private readonly JellyfinLogOptions _options = options.Value;
    private CacheEntry? _cache;

    public async ValueTask<JellyfinLogSnapshot> GetSnapshotAsync(
        CancellationToken cancellationToken = default)
    {
        var now = timeProvider.GetUtcNow();
        var resolved = ResolveConfiguration(_options, now);
        if (resolved.Failure is { } failure)
            return failure;

        var configuration = resolved.Configuration!;
        var cached = Volatile.Read(ref _cache);
        if (cached is not null
            && cached.ConfigurationKey == configuration.CacheKey
            && cached.ExpiresAtUtc > now)
        {
            return cached.Snapshot;
        }

        await _refreshLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            now = timeProvider.GetUtcNow();
            cached = _cache;
            if (cached is not null
                && cached.ConfigurationKey == configuration.CacheKey
                && cached.ExpiresAtUtc > now)
            {
                return cached.Snapshot;
            }

            JellyfinLogSnapshot snapshot;
            RemoteFileIdentity? sourceFile = null;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(HardTimeout);
            try
            {
                var refresh = await FetchAsync(
                    configuration,
                    cached?.ConfigurationKey == configuration.CacheKey ? cached : null,
                    timeout.Token).ConfigureAwait(false);
                snapshot = refresh.Snapshot;
                sourceFile = refresh.SourceFile;
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                snapshot = JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.TimedOut,
                    timeProvider.GetUtcNow(),
                    "Jellyfin did not answer within the log retrieval timeout.");
            }
            catch (HttpRequestException)
            {
                snapshot = JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.Unavailable,
                    timeProvider.GetUtcNow(),
                    "Jellyfin could not be reached.");
            }
            catch (JsonException)
            {
                snapshot = JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.InvalidResponse,
                    timeProvider.GetUtcNow(),
                    "Jellyfin returned an invalid log-file list.");
            }
            catch (Exception exception) when (exception is not OutOfMemoryException)
            {
                // This optional diagnostic source must never turn an integration fault
                // into a failed Core request. Do not return exception messages: they can
                // contain a remote URI or credentials supplied by the operator.
                snapshot = JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.Unavailable,
                    timeProvider.GetUtcNow(),
                    "Jellyfin logs are temporarily unavailable.");
            }

            Volatile.Write(
                ref _cache,
                new CacheEntry(
                    configuration.CacheKey,
                    timeProvider.GetUtcNow() + CacheDuration,
                    snapshot,
                    sourceFile));
            return snapshot;
        }
        finally
        {
            _refreshLock.Release();
        }
    }

    private async Task<FetchResult> FetchAsync(
        ResolvedConfiguration configuration,
        CacheEntry? previous,
        CancellationToken cancellationToken)
    {
        var client = httpClientFactory.CreateClient(HttpClientName);
        using var listRequest = CreateRequest(
            new Uri(configuration.BaseUri, "System/Logs"),
            configuration.ApiKey);
        using var listResponse = await client.SendAsync(
            listRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);

        if (listResponse.StatusCode != HttpStatusCode.OK)
            return new FetchResult(FailureForStatus(listResponse.StatusCode), null);

        var listPayload = await ReadBoundedAsync(
            listResponse.Content,
            MaximumListBytes,
            cancellationToken).ConfigureAwait(false);
        if (listPayload.ExceededLimit)
        {
            return new FetchResult(
                JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.InvalidResponse,
                    timeProvider.GetUtcNow(),
                    "Jellyfin returned an unexpectedly large log-file list."),
                null);
        }

        var files = JsonSerializer.Deserialize<List<JellyfinLogFile>>(
            listPayload.Content,
            SerializerOptions) ?? [];
        var selected = SelectPrimaryServerLog(files);
        if (selected is null)
        {
            return new FetchResult(
                new JellyfinLogSnapshot(
                    JellyfinLogFetchStatus.Available,
                    timeProvider.GetUtcNow(),
                    null,
                    null,
                    [],
                    false,
                    "Jellyfin did not report a primary server log file."),
                null);
        }

        var sourceFile = new RemoteFileIdentity(
            selected.Name,
            selected.Size,
            selected.DateModified);
        if (previous is
            {
                Snapshot.Status: JellyfinLogFetchStatus.Available,
                SourceFile: { } previousFile,
            }
            && previousFile == sourceFile)
        {
            // Cache expiry still validates remote metadata. Avoid downloading and
            // reparsing a multi-megabyte active log until Jellyfin reports a change.
            return new FetchResult(
                previous.Snapshot with { CheckedAtUtc = timeProvider.GetUtcNow() },
                sourceFile);
        }

        if (selected.Size > MaximumLogBytes)
        {
            return new FetchResult(
                JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.TooLarge,
                    timeProvider.GetUtcNow(),
                    $"The current Jellyfin server log exceeds the {MaximumLogBytes / (1024 * 1024)} MiB retrieval limit."),
                sourceFile);
        }

        var logUri = new Uri(
            configuration.BaseUri,
            $"System/Logs/Log?name={Uri.EscapeDataString(selected.Name)}");
        using var logRequest = CreateRequest(logUri, configuration.ApiKey);
        using var logResponse = await client.SendAsync(
            logRequest,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken).ConfigureAwait(false);

        if (logResponse.StatusCode != HttpStatusCode.OK)
        {
            return new FetchResult(
                FailureForStatus(logResponse.StatusCode),
                sourceFile);
        }

        var logPayload = await ReadBoundedAsync(
            logResponse.Content,
            MaximumLogBytes,
            cancellationToken).ConfigureAwait(false);
        if (logPayload.ExceededLimit)
        {
            return new FetchResult(
                JellyfinLogSnapshot.Failure(
                    JellyfinLogFetchStatus.TooLarge,
                    timeProvider.GetUtcNow(),
                    $"The current Jellyfin server log exceeds the {MaximumLogBytes / (1024 * 1024)} MiB retrieval limit."),
                sourceFile);
        }

        var parsed = JellyfinLogParser.Parse(
            Encoding.UTF8.GetString(logPayload.Content),
            configuration.ApiKey);
        return new FetchResult(
            new JellyfinLogSnapshot(
                JellyfinLogFetchStatus.Available,
                timeProvider.GetUtcNow(),
                selected.Name,
                selected.DateModified ?? selected.DateCreated,
                parsed.Entries,
                parsed.IsTruncated,
                parsed.Entries.Count == 0
                    ? "No Streamarr or warning/error/fatal entries were found in the current Jellyfin server log."
                    : null),
            sourceFile);
    }

    private JellyfinLogSnapshot FailureForStatus(HttpStatusCode statusCode)
        => statusCode switch
        {
            HttpStatusCode.Unauthorized => JellyfinLogSnapshot.Failure(
                JellyfinLogFetchStatus.Unauthorized,
                timeProvider.GetUtcNow(),
                "Jellyfin rejected the configured API key."),
            HttpStatusCode.Forbidden => JellyfinLogSnapshot.Failure(
                JellyfinLogFetchStatus.Forbidden,
                timeProvider.GetUtcNow(),
                "The configured Jellyfin API key is not allowed to read server logs."),
            _ => JellyfinLogSnapshot.Failure(
                JellyfinLogFetchStatus.Unavailable,
                timeProvider.GetUtcNow(),
                $"Jellyfin returned HTTP {(int)statusCode} while retrieving logs."),
        };

    private static HttpRequestMessage CreateRequest(Uri uri, string apiKey)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, uri);
        var authorization = string.Concat(
            "MediaBrowser Client=\"Streamarr\", Device=\"Core\", DeviceId=\"streamarr-core\", Version=\"",
            EscapeQuotedValue(GetCoreVersion()),
            "\", Token=\"",
            EscapeQuotedValue(apiKey),
            "\"");
        request.Headers.TryAddWithoutValidation("Authorization", authorization);
        request.Headers.Accept.ParseAdd("application/json, text/plain;q=0.9");
        return request;
    }

    private static string GetCoreVersion()
        => typeof(JellyfinLogSource).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?
            .InformationalVersion ?? "unknown";

    private static string EscapeQuotedValue(string value)
        => value.Replace("\\", "\\\\", StringComparison.Ordinal)
            .Replace("\"", "\\\"", StringComparison.Ordinal);

    private static JellyfinLogFile? SelectPrimaryServerLog(IEnumerable<JellyfinLogFile> files)
    {
        var eligible = files
            .Where(file => !string.IsNullOrWhiteSpace(file.Name))
            .Where(file => !IsTranscodeLog(file.Name))
            .ToArray();
        if (eligible.Length == 0)
            return null;

        var primary = eligible.Where(file => IsLikelyPrimaryLog(file.Name)).ToArray();
        return (primary.Length > 0 ? primary : eligible)
            .OrderByDescending(file => file.DateModified ?? file.DateCreated ?? DateTimeOffset.MinValue)
            .ThenByDescending(file => file.Size)
            .First();
    }

    private static bool IsTranscodeLog(string fileName)
        => fileName.Contains("ffmpeg", StringComparison.OrdinalIgnoreCase)
            || fileName.Contains("transcode", StringComparison.OrdinalIgnoreCase)
            || fileName.Contains("remux", StringComparison.OrdinalIgnoreCase);

    private static bool IsLikelyPrimaryLog(string fileName)
        => fileName.Contains("jellyfin", StringComparison.OrdinalIgnoreCase)
            || fileName.StartsWith("log", StringComparison.OrdinalIgnoreCase)
            || fileName.Contains("server", StringComparison.OrdinalIgnoreCase);

    private static (ResolvedConfiguration? Configuration, JellyfinLogSnapshot? Failure)
        ResolveConfiguration(JellyfinLogOptions options, DateTimeOffset checkedAtUtc)
    {
        var rawBaseUrl = options.BaseUrl?.Trim();
        var apiKey = options.ApiKey?.Trim();
        if (string.IsNullOrEmpty(rawBaseUrl) && string.IsNullOrEmpty(apiKey))
        {
            return (null, JellyfinLogSnapshot.Failure(
                JellyfinLogFetchStatus.Disabled,
                checkedAtUtc,
                "Jellyfin log retrieval is not configured."));
        }

        if (string.IsNullOrEmpty(rawBaseUrl)
            || string.IsNullOrEmpty(apiKey)
            || apiKey.Length > 4_096
            || apiKey.Any(char.IsControl)
            || !Uri.TryCreate(rawBaseUrl, UriKind.Absolute, out var parsed)
            || (parsed.Scheme != Uri.UriSchemeHttp && parsed.Scheme != Uri.UriSchemeHttps)
            || string.IsNullOrEmpty(parsed.Host)
            || !string.IsNullOrEmpty(parsed.UserInfo)
            || !string.IsNullOrEmpty(parsed.Query)
            || !string.IsNullOrEmpty(parsed.Fragment))
        {
            return (null, JellyfinLogSnapshot.Failure(
                JellyfinLogFetchStatus.Misconfigured,
                checkedAtUtc,
                "Streamarr:Jellyfin requires an HTTP(S) BaseUrl without credentials or a query string, and an ApiKey."));
        }

        var baseUrl = parsed.AbsoluteUri.EndsWith("/", StringComparison.Ordinal)
            ? parsed
            : new Uri(string.Concat(parsed.AbsoluteUri, "/"), UriKind.Absolute);
        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(apiKey)));
        return (new ResolvedConfiguration(
            baseUrl,
            apiKey,
            string.Concat(baseUrl.AbsoluteUri, "\0", keyHash)), null);
    }

    private static async Task<BoundedContent> ReadBoundedAsync(
        HttpContent content,
        int maximumBytes,
        CancellationToken cancellationToken)
    {
        if (content.Headers.ContentLength is > 0 and var contentLength
            && contentLength > maximumBytes)
        {
            return new BoundedContent([], true);
        }

        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        using var buffer = new MemoryStream(Math.Min(maximumBytes, 64 * 1024));
        var chunk = new byte[16 * 1024];
        while (buffer.Length <= maximumBytes)
        {
            var remaining = maximumBytes + 1 - (int)buffer.Length;
            var read = await stream.ReadAsync(
                chunk.AsMemory(0, Math.Min(chunk.Length, remaining)),
                cancellationToken).ConfigureAwait(false);
            if (read == 0)
                break;

            buffer.Write(chunk, 0, read);
        }

        return buffer.Length > maximumBytes
            ? new BoundedContent([], true)
            : new BoundedContent(buffer.ToArray(), false);
    }

    private sealed record ResolvedConfiguration(Uri BaseUri, string ApiKey, string CacheKey);
    private sealed record CacheEntry(
        string ConfigurationKey,
        DateTimeOffset ExpiresAtUtc,
        JellyfinLogSnapshot Snapshot,
        RemoteFileIdentity? SourceFile);
    private sealed record RemoteFileIdentity(
        string Name,
        long Size,
        DateTimeOffset? DateModified);
    private sealed record FetchResult(
        JellyfinLogSnapshot Snapshot,
        RemoteFileIdentity? SourceFile);
    private sealed record BoundedContent(byte[] Content, bool ExceededLimit);

    private sealed class JellyfinLogFile
    {
        [JsonPropertyName("Name")]
        public string Name { get; init; } = string.Empty;

        [JsonPropertyName("Size")]
        public long Size { get; init; }

        [JsonPropertyName("DateCreated")]
        public DateTimeOffset? DateCreated { get; init; }

        [JsonPropertyName("DateModified")]
        public DateTimeOffset? DateModified { get; init; }
    }
}
