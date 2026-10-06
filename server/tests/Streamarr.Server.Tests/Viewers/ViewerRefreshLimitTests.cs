using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog.Events;
using Streamarr.Server.Logging;
using Streamarr.Server.Options;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>POST /viewer/auth/refresh is limited per client IP and per presented token; real app cadences never hit it.</summary>
public sealed class ViewerRefreshLimiterTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 6, 12, 0, 30, TimeSpan.Zero);

    private static (ViewerRefreshLimiter Limiter, ManualClock Clock, ListLogger Log) Create(int perIp = 60, int perToken = 10)
    {
        var clock = new ManualClock(Start);
        var log = new ListLogger();
        var options = Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
        {
            ViewerRefreshPerIpPerMinute = perIp,
            ViewerRefreshPerTokenPerMinute = perToken,
        });
        return (new ViewerRefreshLimiter(options, clock, log), clock, log);
    }

    [Fact]
    public void A_Household_Of_Twenty_Apps_Refreshing_Every_Few_Minutes_Is_Never_Limited()
    {
        var (limiter, clock, _) = Create();
        var tokens = Enumerable.Range(0, 20).Select(i => $"device-{i}-0").ToArray();
        for (var minute = 0; minute < 24 * 60; minute++)
        {
            for (var device = 0; device < tokens.Length; device++)
            {
                if ((minute + device) % 5 != 0 && minute != 0)
                    continue;
                // Each refresh is sent twice (a retry after a lost answer replays the previous token), then rotates.
                Assert.Null(limiter.Acquire("203.0.113.7", tokens[device]));
                Assert.Null(limiter.Acquire("203.0.113.7", tokens[device]));
                tokens[device] = $"device-{device}-{minute}";
            }
            clock.Advance(TimeSpan.FromMinutes(1));
        }
    }

    [Fact]
    public void A_Flood_From_One_Address_Gets_Retry_After_Until_The_Window_Ends()
    {
        var (limiter, clock, _) = Create();
        for (var i = 0; i < 60; i++)
            Assert.Null(limiter.Acquire("198.51.100.1", $"random-{i}"));
        clock.Advance(TimeSpan.FromSeconds(20));
        var wait = limiter.Acquire("198.51.100.1", "random-61");
        Assert.NotNull(wait);
        Assert.Equal(TimeSpan.FromSeconds(40), wait);
        Assert.Null(limiter.Acquire("198.51.100.2", "other-client"));

        clock.Advance(TimeSpan.FromSeconds(40));
        Assert.Null(limiter.Acquire("198.51.100.1", "random-62"));
    }

    [Fact]
    public void One_Token_Replayed_From_Many_Addresses_Is_Limited_Per_Token()
    {
        var (limiter, _, _) = Create();
        for (var i = 0; i < 10; i++)
            Assert.Null(limiter.Acquire($"192.0.2.{i}", "stolen"));
        Assert.NotNull(limiter.Acquire("192.0.2.200", "stolen"));
        Assert.Null(limiter.Acquire("192.0.2.200", "own-token"));
    }

    [Fact]
    public void Rate_Limit_Lines_Are_Aggregated_Per_Window()
    {
        var (limiter, clock, log) = Create(perIp: 1);
        for (var i = 0; i < 1_000; i++)
            limiter.Acquire($"10.0.{i / 250}.{i % 250}", null);
        for (var i = 0; i < 1_000; i++)
            limiter.Acquire($"10.0.{i / 250}.{i % 250}", null);
        Assert.Equal(5, log.Lines.Count);
        clock.Advance(TimeSpan.FromMinutes(1));
        limiter.Acquire("10.0.0.0", null);
        limiter.Acquire("10.0.0.0", null);
        Assert.Equal(7, log.Lines.Count);
        Assert.Contains("995 further refusals", log.Lines[5]);
    }

    [Fact]
    public void Tracked_Keys_Stay_Bounded_Under_A_Random_Token_Flood()
    {
        var (limiter, clock, _) = Create(perIp: 10_000);
        for (var i = 0; i < ViewerRefreshLimiter.MaxKeys + 500; i++)
            limiter.Acquire("198.51.100.9", $"random-{i}");
        Assert.True(limiter.TrackedKeys <= ViewerRefreshLimiter.MaxKeys);
        clock.Advance(TimeSpan.FromMinutes(1));
        limiter.Acquire("198.51.100.9", "after-the-window");
        Assert.True(limiter.TrackedKeys <= 2);
    }

    [Fact]
    public void LogBudget_Allows_Its_Lines_Then_Reports_The_Rest_Once()
    {
        var budget = new LogBudget(2, TimeSpan.FromMinutes(1));
        Assert.True(budget.TryTake(Start, out var none) && none == 0);
        Assert.True(budget.TryTake(Start, out _));
        Assert.False(budget.TryTake(Start, out _));
        Assert.False(budget.TryTake(Start.AddSeconds(59), out _));
        Assert.True(budget.TryTake(Start.AddMinutes(1), out var suppressed));
        Assert.Equal(2, suppressed);
        Assert.True(budget.TryTake(Start.AddMinutes(1), out var again) && again == 0);
    }

    private sealed class ListLogger : ILogger<ViewerRefreshLimiter>
    {
        public List<string> Lines { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
            => Lines.Add(formatter(state, exception));

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();

            public void Dispose()
            {
            }
        }
    }
}

/// <summary>The production defaults (60 per client, 10 per token per minute), end to end.</summary>
public sealed class ViewerRefreshLimitFactory : ViewerApiFactory
{
    protected override void Configure(Dictionary<string, string?> settings)
    {
        settings.Remove("Streamarr:ViewerRefreshPerIpPerMinute");
        settings.Remove("Streamarr:ViewerRefreshPerTokenPerMinute");
    }
}

/// <summary>Serial for the log feed (see <see cref="ViewerRefreshLogTests"/>).</summary>
[Collection("viewer-refresh-logs")]
public sealed class ViewerRefreshLimitApiTests(ViewerRefreshLimitFactory factory) : IClassFixture<ViewerRefreshLimitFactory>, IAsyncLifetime
{
    private const string Password = "correct horse battery";
    private HttpClient _admin = null!;

    public async Task InitializeAsync()
    {
        _admin = await factory.AdminAsync();
        await ViewerApi.ConfigureAsync(_admin, new { enabled = true, email = new { mode = "outbox" } });
    }

    public Task DisposeAsync()
    {
        _admin.Dispose();
        return Task.CompletedTask;
    }

    private static Task<HttpResponseMessage> RefreshAsync(HttpClient anon, string refreshToken)
        => anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken });

    private void NextWindow() => factory.Clock.Advance(ViewerRefreshLimiter.Window);

    [Fact]
    public async Task An_App_Refreshing_Every_Few_Minutes_Never_Gets_429_And_A_Flood_Does()
    {
        NextWindow();
        await ViewerApi.CreateAsync(_admin, new { username = "cadence", password = Password });
        using var anon = factory.CreateClient();
        var refresh = (await ViewerApi.SignInAsync(anon, "cadence", Password)).GetProperty("refreshToken").GetString()!;
        for (var i = 0; i < 40; i++)
        {
            using var response = await RefreshAsync(anon, refresh);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            refresh = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refreshToken").GetString()!;
            factory.Clock.Advance(TimeSpan.FromMinutes(3));
        }

        NextWindow();
        var statuses = new List<HttpStatusCode>();
        HttpResponseMessage? limited = null;
        for (var i = 0; i < 70; i++)
        {
            var response = await RefreshAsync(anon, ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix));
            statuses.Add(response.StatusCode);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                limited ??= response;
        }
        Assert.Equal(60, statuses.Count(s => s == HttpStatusCode.Unauthorized));
        Assert.Equal(10, statuses.Count(s => s == HttpStatusCode.TooManyRequests));
        Assert.NotNull(limited);
        Assert.Equal(TimeSpan.FromSeconds(60), limited!.Headers.RetryAfter?.Delta);
        Assert.Equal("rate_limited", (await limited.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("error").GetProperty("code").GetString());

        // The flood leaves at most five refusal lines, five limiter lines and no per-request warning in the log feed.
        var store = factory.Services.GetRequiredService<CoreLogStore>();
        var feed = store.Read(new CoreLogQuery(LogEventLevel.Information, null), 500).Entries;
        Assert.InRange(feed.Count(e => e.Message.Contains("Viewer refresh refused: Unknown", StringComparison.Ordinal)), 1, 5);
        Assert.InRange(feed.Count(e => e.Message.Contains("Viewer refresh rate limited", StringComparison.Ordinal)), 1, 5);
        Assert.DoesNotContain(feed, e => e.Message.Contains("/api/v1/viewer/auth/refresh completed 429", StringComparison.Ordinal));

        NextWindow();
        using var after = await RefreshAsync(anon, refresh);
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
    }

    [Fact]
    public async Task One_Token_Presented_Over_And_Over_Is_Limited_On_Its_Own()
    {
        NextWindow();
        await ViewerApi.CreateAsync(_admin, new { username = "replayer", password = Password });
        using var anon = factory.CreateClient();
        var refresh = (await ViewerApi.SignInAsync(anon, "replayer", Password)).GetProperty("refreshToken").GetString()!;
        using var first = await RefreshAsync(anon, refresh);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var statuses = new List<HttpStatusCode>();
        for (var i = 0; i < 11; i++)
            statuses.Add((await RefreshAsync(anon, refresh)).StatusCode);
        Assert.Equal(9, statuses.Count(s => s == HttpStatusCode.OK));
        Assert.Equal(HttpStatusCode.TooManyRequests, statuses[^1]);
    }
}
