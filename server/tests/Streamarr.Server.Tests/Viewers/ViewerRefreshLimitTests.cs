using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Serilog.Events;
using Streamarr.Server.Logging;
using Streamarr.Server.Options;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Tests.Viewers;

/// <summary>POST /viewer/auth/refresh is limited by failures per client IP and per presented token; real app cadences never hit it.</summary>
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

    /// <summary>What the controller does: a live token passes an address that used up its failures; a refused refresh counts.</summary>
    private static TimeSpan? Refresh(ViewerRefreshLimiter limiter, string ip, string? token, bool live)
    {
        if (limiter.Check(ip, token) is { } limit && !(limit.ByAddress && live))
        {
            limiter.NoteLimited(limit, ip);
            return limit.Wait;
        }
        if (!live)
            limiter.NoteFailure(ip);
        return null;
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
                Assert.Null(Refresh(limiter, "203.0.113.7", tokens[device], live: true));
                Assert.Null(Refresh(limiter, "203.0.113.7", tokens[device], live: true));
                tokens[device] = $"device-{device}-{minute}";
            }
            clock.Advance(TimeSpan.FromMinutes(1));
        }
    }

    [Fact]
    public void Successful_Refreshes_Never_Use_The_Address_Budget()
    {
        var (limiter, _, _) = Create(perIp: 5);
        for (var i = 0; i < 50; i++)
            Assert.Null(Refresh(limiter, "203.0.113.8", $"device-{i}", live: true));
        for (var i = 0; i < 5; i++)
            Assert.Null(Refresh(limiter, "203.0.113.8", $"random-{i}", live: false));
        Assert.NotNull(Refresh(limiter, "203.0.113.8", "random-5", live: false));
    }

    [Fact]
    public void A_Flood_From_One_Address_Gets_Retry_After_Until_The_Window_Ends()
    {
        var (limiter, clock, _) = Create();
        for (var i = 0; i < 60; i++)
            Assert.Null(Refresh(limiter, "198.51.100.1", $"random-{i}", live: false));
        clock.Advance(TimeSpan.FromSeconds(20));
        Assert.Equal(TimeSpan.FromSeconds(40), Refresh(limiter, "198.51.100.1", "random-61", live: false));
        Assert.Equal(TimeSpan.FromSeconds(40), Refresh(limiter, "198.51.100.1", null, live: false));
        Assert.Null(Refresh(limiter, "198.51.100.2", "other-client", live: false));

        clock.Advance(TimeSpan.FromSeconds(40));
        Assert.Null(Refresh(limiter, "198.51.100.1", "random-62", live: false));
    }

    [Fact]
    public void A_Live_Token_Behind_A_Flooding_Address_Still_Refreshes_While_The_Flood_Stays_Limited()
    {
        var (limiter, _, _) = Create();
        for (var i = 0; i < 60; i++)
            Refresh(limiter, "198.51.100.3", $"random-{i}", live: false);
        var limit = limiter.Check("198.51.100.3", "anna");
        Assert.True(limit is { ByAddress: true });
        Assert.Null(Refresh(limiter, "198.51.100.3", "anna-2", live: true));
        Assert.NotNull(Refresh(limiter, "198.51.100.3", "random-60", live: false));
        Assert.NotNull(Refresh(limiter, "198.51.100.3", null, live: false));
    }

    [Fact]
    public void One_Token_Replayed_From_Many_Addresses_Is_Limited_Per_Token_Even_When_Live()
    {
        var (limiter, _, _) = Create();
        for (var i = 0; i < 10; i++)
            Assert.Null(Refresh(limiter, $"192.0.2.{i}", "stolen", live: true));
        var limit = limiter.Check("192.0.2.200", "stolen");
        Assert.True(limit is { ByAddress: false });
        Assert.NotNull(Refresh(limiter, "192.0.2.200", "stolen", live: true));
        Assert.Null(Refresh(limiter, "192.0.2.200", "own-token", live: true));
    }

    [Fact]
    public void Rate_Limit_Lines_Are_Aggregated_Per_Window()
    {
        var (limiter, clock, log) = Create(perIp: 1);
        for (var i = 0; i < 1_000; i++)
            Refresh(limiter, $"10.0.{i / 250}.{i % 250}", null, live: false);
        for (var i = 0; i < 1_000; i++)
            Refresh(limiter, $"10.0.{i / 250}.{i % 250}", null, live: false);
        Assert.Equal(5, log.Lines.Count);
        clock.Advance(TimeSpan.FromMinutes(1));
        Refresh(limiter, "10.0.0.0", null, live: false);
        Refresh(limiter, "10.0.0.0", null, live: false);
        Assert.Equal(7, log.Lines.Count);
        Assert.Contains("995 further refusals", log.Lines[5]);
    }

    [Fact]
    public void Tracked_Keys_Stay_Bounded_Under_A_Random_Token_Flood()
    {
        var (limiter, clock, _) = Create(perIp: 10_000);
        for (var i = 0; i < ViewerRefreshLimiter.MaxKeys + 500; i++)
            Refresh(limiter, "198.51.100.9", $"random-{i}", live: false);
        Assert.True(limiter.TrackedKeys <= ViewerRefreshLimiter.MaxKeys);
        clock.Advance(TimeSpan.FromMinutes(1));
        Refresh(limiter, "198.51.100.9", "after-the-window", live: false);
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
        var store = factory.Services.GetRequiredService<CoreLogStore>();
        int Lines(string text) => store.Read(new CoreLogQuery(LogEventLevel.Information, null), 500).Entries.Count(e => e.Message.Contains(text, StringComparison.Ordinal));
        var (refusedBefore, limitedBefore) = (Lines("Viewer refresh refused: Unknown"), Lines("Viewer refresh rate limited"));
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

        // The flood adds at most five refusal lines, five limiter lines and no per-request warning (other tests of the fixture flood too).
        Assert.InRange(Lines("Viewer refresh refused: Unknown") - refusedBefore, 1, 5);
        Assert.InRange(Lines("Viewer refresh rate limited") - limitedBefore, 1, 5);
        var feed = store.Read(new CoreLogQuery(LogEventLevel.Information, null), 500).Entries;
        Assert.DoesNotContain(feed, e => e.Message.Contains("/api/v1/viewer/auth/refresh completed 429", StringComparison.Ordinal));

        NextWindow();
        using var after = await RefreshAsync(anon, refresh);
        Assert.Equal(HttpStatusCode.OK, after.StatusCode);
    }

    [Fact]
    public async Task A_Flooder_Behind_The_Same_Address_Never_Locks_Out_A_Live_Session()
    {
        NextWindow();
        await ViewerApi.CreateAsync(_admin, new { username = "neighbour", password = Password });
        await ViewerApi.CreateAsync(_admin, new { username = "leaver", password = Password });
        using var anon = factory.CreateClient();
        var refresh = (await ViewerApi.SignInAsync(anon, "neighbour", Password)).GetProperty("refreshToken").GetString()!;
        var revoked = (await ViewerApi.SignInAsync(anon, "leaver", Password)).GetProperty("refreshToken").GetString()!;
        using (var logout = await anon.PostAsJsonAsync("/api/v1/viewer/auth/logout", new { refreshToken = revoked }))
            Assert.Equal(HttpStatusCode.NoContent, logout.StatusCode);

        for (var i = 0; i < 60; i++)
            (await RefreshAsync(anon, ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix))).Dispose();
        using (var flood = await RefreshAsync(anon, ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix)))
            Assert.Equal(HttpStatusCode.TooManyRequests, flood.StatusCode);

        for (var i = 0; i < 3; i++)
        {
            using var live = await RefreshAsync(anon, refresh);
            Assert.Equal(HttpStatusCode.OK, live.StatusCode);
            refresh = (await live.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("refreshToken").GetString()!;
            using var flood = await RefreshAsync(anon, ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix));
            Assert.Equal(HttpStatusCode.TooManyRequests, flood.StatusCode);
        }
        using (var ended = await RefreshAsync(anon, revoked))
            Assert.Equal(HttpStatusCode.TooManyRequests, ended.StatusCode);
        using (var malformed = await anon.PostAsJsonAsync("/api/v1/viewer/auth/refresh", new { refreshToken = "nope" }))
            Assert.Equal(HttpStatusCode.TooManyRequests, malformed.StatusCode);
    }

    [Fact]
    public async Task An_Expired_But_Unrevoked_Token_Does_Not_Pass_The_Exhausted_Address_Gate()
    {
        NextWindow();
        await ViewerApi.CreateAsync(_admin, new { username = "lapsed", password = Password });
        using var anon = factory.CreateClient();
        var session = await ViewerApi.SignInAsync(anon, "lapsed", Password);
        var refresh = session.GetProperty("refreshToken").GetString()!;
        var sessionId = session.GetProperty("sessionId").GetString()!;
        var past = factory.Clock.GetUtcNow().AddSeconds(-1);
        await using (var db = await factory.Services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync())
            await db.ViewerSessions.Where(s => s.Id == sessionId).ExecuteUpdateAsync(s => s.SetProperty(x => x.RefreshExpiresAt, past));

        for (var i = 0; i < 60; i++)
            (await RefreshAsync(anon, ViewerAuth.NewToken(ViewerAuth.RefreshTokenPrefix))).Dispose();
        using var expired = await RefreshAsync(anon, refresh);
        Assert.Equal(HttpStatusCode.TooManyRequests, expired.StatusCode);
        Assert.True(expired.Headers.RetryAfter is not null);

        NextWindow();
        using var after = await RefreshAsync(anon, refresh);
        Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
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
