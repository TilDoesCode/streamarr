using System.Net;
using Streamarr.Core.Tests.Indexers;
using Streamarr.Core.Tmdb;

namespace Streamarr.Core.Tests.Tmdb;

/// <summary>
/// Characterizes the exact timing gap behind the "metadata loads unreliably" bug report: TMDB
/// occasionally rate-limits (HTTP 429) or hiccups, and <see cref="TmdbClient"/> correctly retries
/// and eventually succeeds — but that retry sequence, played out with the project's own default
/// <see cref="TmdbOptions"/> backoff settings, can legitimately take well over ten seconds. The
/// Jellyfin plugin's season/episode hierarchy population budget
/// (<c>StreamarrSearchActionFilter.HierarchyTimeout</c>) used to be only 12 seconds — shorter than
/// this — so a TMDB response that was merely slow, not actually broken, was discarded by the
/// plugin before Core even finished, and the client saw an empty/partial result with no visible
/// error. These tests pin down the numbers that motivated widening that budget to 25s: comfortably
/// above <see cref="TmdbOptions.RequestTimeoutSeconds"/>'s 20s default ceiling, which is itself
/// comfortably above what a realistic multi-retry 429 sequence takes.
///
/// No wall-clock time is spent: <see cref="TmdbClient"/>'s retry delay is injectable, so these
/// tests capture the delays the production backoff logic actually computes (honoring TMDB's
/// Retry-After and the configured cap) and reason about their sum directly.
/// </summary>
public class TmdbSlowButSuccessfulRetryTests
{
    [Fact]
    public async Task A_repeatedly_rate_limited_lookup_can_take_longer_than_the_old_12s_hierarchy_budget_yet_still_succeed()
    {
        // Production defaults (TmdbOptions.cs): MaxTransientRetries=3 (4 attempts total),
        // RetryMaxDelayMilliseconds=5000 — TMDB's own Retry-After is honored up to that 5s cap.
        var options = new TmdbOptions { ApiKey = "test-key" };
        Assert.Equal(3, options.TransientRetryCount);
        Assert.Equal(TimeSpan.FromSeconds(5), options.RetryMaxDelay);

        var attempts = 0;
        var handler = new StubHttpMessageHandler(_ =>
        {
            attempts++;
            if (attempts <= 3)
            {
                // TMDB advertises a Retry-After at or above the configured cap on every one of
                // the three permitted retries — a real, if unlucky, rate-limit sequence.
                var response = StubHttpMessageHandler.Status(HttpStatusCode.TooManyRequests);
                response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(
                    TimeSpan.FromSeconds(6));
                return response;
            }

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(
                    """{"id":693134,"title":"Dune: Part Two","release_date":"2024-03-01"}""",
                    System.Text.Encoding.UTF8,
                    "application/json"),
            };
        });

        var observedDelays = new List<TimeSpan>();
        var client = new TmdbClient(
            new HttpClient(handler),
            options,
            retryDelay: (delay, _) =>
            {
                observedDelays.Add(delay);
                return Task.CompletedTask;
            });

        var result = await client.GetMovieAsync(693134, CancellationToken.None);

        // It genuinely succeeds — this is not a broken/permanently-failing lookup.
        Assert.NotNull(result);
        Assert.Equal(4, attempts);
        Assert.Equal(3, observedDelays.Count);

        // Each retry is capped at RetryMaxDelay (5s), not the full 6s TMDB advertised.
        Assert.All(observedDelays, delay => Assert.Equal(TimeSpan.FromSeconds(5), delay));

        var totalBackoff = observedDelays.Aggregate(TimeSpan.Zero, (sum, delay) => sum + delay);

        // This is the crux of the bug: total backoff alone (ignoring network/JSON overhead)
        // already exceeds what used to be the plugin's entire hierarchy-population budget (12s),
        // even though the lookup was always going to succeed on the 4th attempt.
        Assert.True(
            totalBackoff > TimeSpan.FromSeconds(12),
            $"Expected the retry sequence to exceed the old 12s hierarchy budget, took {totalBackoff}.");

        // But it fits within TmdbOptions' own worst-case ceiling (RequestTimeoutSeconds, 20s
        // default) that CachingTmdbClient enforces around the whole retry loop — so a plugin
        // budget with headroom over that 20s ceiling (the fixed 25s HierarchyTimeout) will not
        // discard this response.
        Assert.True(
            totalBackoff < TimeSpan.FromSeconds(options.RequestTimeoutSeconds),
            $"Expected the retry sequence to fit inside the {options.RequestTimeoutSeconds}s TMDB ceiling, took {totalBackoff}.");
    }
}
