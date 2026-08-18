using System.Net;
using System.Text;
using Streamarr.Server.Logging;

namespace Streamarr.Server.Tests.Logging;

public sealed class JellyfinLogSourceTests
{
    private const string ApiKey = "jellyfin-secret-api-key";

    [Fact]
    public async Task DisabledSourceDoesNotMakeARequest()
    {
        var handler = new SequenceHandler(_ => throw new InvalidOperationException("Unexpected request."));
        var source = CreateSource(handler, new JellyfinLogOptions());

        var snapshot = await source.GetSnapshotAsync();

        Assert.Equal(JellyfinLogFetchStatus.Disabled, snapshot.Status);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task FetchesNewestPrimaryLogWithCanonicalAuthorizationAndSanitizesRelevantLines()
    {
        var list = """
            [
              { "Name": "log_20260816.log", "Size": 400, "DateModified": "2026-08-16T12:00:00Z" },
              { "Name": "ffmpeg-transcode-newest.txt", "Size": 200, "DateModified": "2026-08-17T13:00:00Z" },
              { "Name": "jellyfin_20260817.log", "Size": 600, "DateModified": "2026-08-17T12:00:00Z" }
            ]
            """;
        var capability = new string('b', 48);
        var rawLog = string.Join('\n',
            "[2026-08-17 11:59:58.000 +00:00] [INF] Ordinary Jellyfin request",
            $"[2026-08-17 11:59:59.000 +00:00] [INF] Streamarr opened token=playback-token api_key={ApiKey}",
            "[2026-08-17 12:00:00.000 +00:00] [WRN] Slow response",
            $"[2026-08-17 12:00:01.000 +00:00] [ERR] Failure Token=another-secret /api/v1/stream/{capability} /api/v1/sessions/{capability}/articles",
            "System.InvalidOperationException: decoder failed",
            "   at Streamarr.Plugin.Open(String token=stack-secret)",
            "[2026-08-17 12:00:02.000 +00:00] [INF] Unrelated request",
            "this continuation must not be retained");
        var handler = new SequenceHandler(
            _ => Response(HttpStatusCode.OK, list, "application/json"),
            _ => Response(HttpStatusCode.OK, rawLog, "text/plain"));
        var source = CreateSource(handler, ConfiguredOptions());

        var first = await source.GetSnapshotAsync();
        var cached = await source.GetSnapshotAsync();

        Assert.Same(first, cached);
        Assert.Equal(JellyfinLogFetchStatus.Available, first.Status);
        Assert.Equal("jellyfin_20260817.log", first.SourceFileName);
        Assert.Equal(3, first.Entries.Count);
        Assert.Collection(
            first.Entries,
            entry =>
            {
                Assert.Equal("Information", entry.Level);
                Assert.Contains("Streamarr opened", entry.Message, StringComparison.Ordinal);
                Assert.DoesNotContain(ApiKey, entry.Message, StringComparison.Ordinal);
                Assert.DoesNotContain("playback-token", entry.Message, StringComparison.Ordinal);
                Assert.Equal(
                    new DateTimeOffset(2026, 8, 17, 11, 59, 59, TimeSpan.Zero),
                    entry.Timestamp);
            },
            entry => Assert.Equal("Warning", entry.Level),
            entry =>
            {
                Assert.Equal("Error", entry.Level);
                Assert.DoesNotContain("another-secret", entry.Message, StringComparison.Ordinal);
                Assert.DoesNotContain(capability, entry.Message, StringComparison.Ordinal);
                Assert.Contains("/api/v1/sessions/{capability}/articles", entry.Message, StringComparison.Ordinal);
                Assert.DoesNotContain("stack-secret", entry.Message, StringComparison.Ordinal);
                Assert.Contains("System.InvalidOperationException", entry.Message, StringComparison.Ordinal);
                Assert.Contains("at Streamarr.Plugin.Open", entry.Message, StringComparison.Ordinal);
                Assert.DoesNotContain("must not be retained", entry.Message, StringComparison.Ordinal);
            });

        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal("/jellyfin/System/Logs", handler.Requests[0].Uri.AbsolutePath);
        Assert.Equal("/jellyfin/System/Logs/Log", handler.Requests[1].Uri.AbsolutePath);
        Assert.Equal("jellyfin_20260817.log", GetQueryValue(handler.Requests[1].Uri, "name"));
        Assert.All(handler.Requests, request =>
        {
            Assert.StartsWith("MediaBrowser Client=\"Streamarr\"", request.Authorization, StringComparison.Ordinal);
            Assert.Contains("Device=\"Core\"", request.Authorization, StringComparison.Ordinal);
            Assert.Contains("DeviceId=\"streamarr-core\"", request.Authorization, StringComparison.Ordinal);
            Assert.Contains("Version=\"", request.Authorization, StringComparison.Ordinal);
            Assert.Contains($"Token=\"{ApiKey}\"", request.Authorization, StringComparison.Ordinal);
            Assert.DoesNotContain(ApiKey, request.Uri.AbsoluteUri, StringComparison.Ordinal);
        });
    }

    [Fact]
    public async Task AuthenticationFailureIsReturnedAsStatus()
    {
        var handler = new SequenceHandler(_ => Response(HttpStatusCode.Unauthorized, ""));
        var source = CreateSource(handler, ConfiguredOptions());

        var snapshot = await source.GetSnapshotAsync();

        Assert.Equal(JellyfinLogFetchStatus.Unauthorized, snapshot.Status);
        Assert.Empty(snapshot.Entries);
    }

    [Fact]
    public async Task RefusesServerLogAboveHardLimitBeforeDownloadingIt()
    {
        var list = $$"""
            [
              {
                "Name": "jellyfin.log",
                "Size": {{JellyfinLogSource.MaximumLogBytes + 1}},
                "DateModified": "2026-08-17T12:00:00Z"
              }
            ]
            """;
        var handler = new SequenceHandler(_ => Response(HttpStatusCode.OK, list, "application/json"));
        var source = CreateSource(handler, ConfiguredOptions());

        var snapshot = await source.GetSnapshotAsync();

        Assert.Equal(JellyfinLogFetchStatus.TooLarge, snapshot.Status);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task InvalidPartialConfigurationIsReturnedAsStatus()
    {
        var handler = new SequenceHandler(_ => throw new InvalidOperationException("Unexpected request."));
        var source = CreateSource(handler, new JellyfinLogOptions
        {
            BaseUrl = "http://jellyfin:8096",
        });

        var snapshot = await source.GetSnapshotAsync();

        Assert.Equal(JellyfinLogFetchStatus.Misconfigured, snapshot.Status);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ExpiredCacheReusesParsedEntriesWhenRemoteMetadataIsUnchanged()
    {
        var list = """
            [
              { "Name": "jellyfin.log", "Size": 100, "DateModified": "2026-08-17T12:00:00Z" }
            ]
            """;
        var handler = new SequenceHandler(
            _ => Response(HttpStatusCode.OK, list, "application/json"),
            _ => Response(HttpStatusCode.OK, "[2026-08-17 12:00:00Z] [ERR] failure", "text/plain"),
            _ => Response(HttpStatusCode.OK, list, "application/json"));
        var time = new ManualTimeProvider(
            new DateTimeOffset(2026, 8, 17, 12, 0, 0, TimeSpan.Zero));
        var source = CreateSource(handler, ConfiguredOptions(), time);

        var initial = await source.GetSnapshotAsync();
        time.Advance(TimeSpan.FromSeconds(16));
        var refreshed = await source.GetSnapshotAsync();

        Assert.Equal(JellyfinLogFetchStatus.Available, refreshed.Status);
        Assert.Same(initial.Entries, refreshed.Entries);
        Assert.True(refreshed.CheckedAtUtc > initial.CheckedAtUtc);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal("/jellyfin/System/Logs", handler.Requests[0].Uri.AbsolutePath);
        Assert.Equal("/jellyfin/System/Logs/Log", handler.Requests[1].Uri.AbsolutePath);
        Assert.Equal("/jellyfin/System/Logs", handler.Requests[2].Uri.AbsolutePath);
    }

    private static JellyfinLogOptions ConfiguredOptions()
        => new()
        {
            BaseUrl = "http://jellyfin:8096/jellyfin",
            ApiKey = ApiKey,
        };

    private static JellyfinLogSource CreateSource(
        HttpMessageHandler handler,
        JellyfinLogOptions options,
        TimeProvider? timeProvider = null)
    {
        var client = new HttpClient(handler)
        {
            Timeout = Timeout.InfiniteTimeSpan,
        };
        return new JellyfinLogSource(
            new StubHttpClientFactory(client),
            Microsoft.Extensions.Options.Options.Create(options),
            timeProvider ?? TimeProvider.System);
    }

    private static HttpResponseMessage Response(
        HttpStatusCode status,
        string content,
        string mediaType = "text/plain")
        => new(status)
        {
            Content = new StringContent(content, Encoding.UTF8, mediaType),
        };

    private static string? GetQueryValue(Uri uri, string name)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            if (Uri.UnescapeDataString(pair[0]).Equals(name, StringComparison.Ordinal))
                return pair.Length == 2 ? Uri.UnescapeDataString(pair[1]) : string.Empty;
        }

        return null;
    }

    private sealed class StubHttpClientFactory(HttpClient client) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name)
        {
            Assert.Equal(JellyfinLogSource.HttpClientName, name);
            return client;
        }
    }

    private sealed class SequenceHandler(params Func<HttpRequestMessage, HttpResponseMessage>[] responses)
        : HttpMessageHandler
    {
        private readonly Queue<Func<HttpRequestMessage, HttpResponseMessage>> _responses = new(responses);

        public List<CapturedRequest> Requests { get; } = [];

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var authorization = request.Headers.TryGetValues("Authorization", out var values)
                ? Assert.Single(values)
                : string.Empty;
            Requests.Add(new CapturedRequest(request.RequestUri!, authorization));
            return Task.FromResult(_responses.Dequeue()(request));
        }
    }

    private sealed record CapturedRequest(Uri Uri, string Authorization);

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        private DateTimeOffset _now = now;

        public override DateTimeOffset GetUtcNow() => _now;

        public void Advance(TimeSpan duration) => _now += duration;
    }
}
