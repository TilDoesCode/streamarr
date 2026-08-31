using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Configuration;

namespace Streamarr.Plugin.Tests;

/// <summary>
/// Regression coverage for the plugin honoring Core's <c>Retry-After</c> header instead of always
/// falling back to its own fixed exponential backoff. Core's <c>SearchConcurrencyGate</c> rejects
/// with 429 + <c>Retry-After</c> when it is momentarily at capacity (e.g. two clients — Jellyfin
/// Web and Streamyfin — browsing at once); retrying sooner than that just re-hits the same full
/// gate and burns through the 3-attempt budget without ever succeeding.
/// </summary>
public class StreamarrApiClientRetryTests
{
    [Fact]
    public async Task Retries_a_429_after_the_delay_core_advertised_in_Retry_After()
    {
        var attempts = 0;
        var handler = new CallbackHandler(_ =>
        {
            attempts++;
            if (attempts == 1)
            {
                var rejected = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                rejected.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(
                    TimeSpan.FromMilliseconds(1_700));
                return rejected;
            }

            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        var observedDelays = new List<TimeSpan>();
        var config = new PluginConfiguration { ServerUrl = "https://core.example" };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config,
            retryDelay: (delay, _) =>
            {
                observedDelays.Add(delay);
                return Task.CompletedTask;
            });

        var result = await api.SearchAsync("dune", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(2, attempts);
        Assert.Single(observedDelays);
        // Must honor Core's advertised 1.7s, not the old fixed 250ms first-retry backoff.
        Assert.Equal(TimeSpan.FromMilliseconds(1_700), observedDelays[0]);
    }

    [Fact]
    public async Task Caps_an_unreasonably_large_Retry_After_instead_of_stalling_indefinitely()
    {
        var attempts = 0;
        var handler = new CallbackHandler(_ =>
        {
            attempts++;
            if (attempts == 1)
            {
                var rejected = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
                rejected.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(
                    TimeSpan.FromMinutes(5));
                return rejected;
            }

            return Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        var observedDelays = new List<TimeSpan>();
        var config = new PluginConfiguration { ServerUrl = "https://core.example" };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config,
            retryDelay: (delay, _) =>
            {
                observedDelays.Add(delay);
                return Task.CompletedTask;
            });

        _ = await api.SearchAsync("dune", CancellationToken.None);

        Assert.Single(observedDelays);
        Assert.True(observedDelays[0] <= TimeSpan.FromSeconds(5), $"Expected the delay to be capped, was {observedDelays[0]}.");
    }

    [Fact]
    public async Task Falls_back_to_exponential_backoff_when_core_gives_no_Retry_After_hint()
    {
        var attempts = 0;
        var handler = new CallbackHandler(_ =>
        {
            attempts++;
            return attempts < 3
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : Json(HttpStatusCode.OK, "{\"results\":[]}");
        });

        var observedDelays = new List<TimeSpan>();
        var config = new PluginConfiguration { ServerUrl = "https://core.example" };
        var api = new StreamarrApiClient(
            new HttpClient(handler),
            NullLogger<StreamarrApiClient>.Instance,
            () => config,
            retryDelay: (delay, _) =>
            {
                observedDelays.Add(delay);
                return Task.CompletedTask;
            });

        var result = await api.SearchAsync("dune", CancellationToken.None);

        Assert.NotNull(result);
        Assert.Equal(3, attempts);
        Assert.Equal(2, observedDelays.Count);
        Assert.Equal(TimeSpan.FromMilliseconds(250), observedDelays[0]);
        Assert.Equal(TimeSpan.FromMilliseconds(500), observedDelays[1]);
    }

    [Fact]
    public async Task Successful_retry_does_not_emit_a_warning_for_the_rejected_attempt()
    {
        var attempts = 0;
        var logger = new CollectingLogger<StreamarrApiClient>();
        var api = new StreamarrApiClient(
            new HttpClient(new CallbackHandler(_ => ++attempts == 1
                ? new HttpResponseMessage(HttpStatusCode.TooManyRequests)
                : Json(HttpStatusCode.OK, "{\"results\":[]}"))),
            logger,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            retryDelay: (_, _) => Task.CompletedTask);

        _ = await api.SearchAsync("dune", CancellationToken.None);

        Assert.Equal(2, attempts);
        Assert.DoesNotContain(logger.Events, entry => entry.Level >= LogLevel.Warning);
    }

    [Fact]
    public async Task Exhausted_retries_emit_one_final_warning()
    {
        var attempts = 0;
        var logger = new CollectingLogger<StreamarrApiClient>();
        var api = new StreamarrApiClient(
            new HttpClient(new CallbackHandler(_ =>
            {
                attempts++;
                return new HttpResponseMessage(HttpStatusCode.TooManyRequests);
            })),
            logger,
            () => new PluginConfiguration { ServerUrl = "https://core.example" },
            retryDelay: (_, _) => Task.CompletedTask);

        await Assert.ThrowsAsync<StreamarrApiException>(
            () => api.SearchAsync("dune", CancellationToken.None));

        Assert.Equal(3, attempts);
        var warning = Assert.Single(logger.Events, entry => entry.Level == LogLevel.Warning);
        Assert.Contains("after 3 attempt(s)", warning.Message, StringComparison.Ordinal);
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json"),
    };

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }

    private sealed class CollectingLogger<T> : ILogger<T>
    {
        public List<(LogLevel Level, string Message)> Events { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Events.Add((logLevel, formatter(state, exception)));
    }
}
