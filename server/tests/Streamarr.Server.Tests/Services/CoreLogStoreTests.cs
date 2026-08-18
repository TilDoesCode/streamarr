using Microsoft.AspNetCore.Http;
using Serilog;
using Serilog.Context;
using Serilog.Events;
using Streamarr.Server.Logging;

namespace Streamarr.Server.Tests.Services;

public sealed class CoreLogStoreTests
{
    [Fact]
    public void Store_IsBounded_NewestFirst_AndHonorsLevelAndSearch()
    {
        var store = new CoreLogStore(16);
        using var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .WriteTo.Sink(store)
            .CreateLogger();

        for (var index = 0; index < 20; index++)
            logger.Information("diagnostic item {Index}", index);
        logger.Warning("distinct warning");

        var all = store.Read(new CoreLogQuery(LogEventLevel.Verbose, null), 500);
        Assert.Equal(16, all.Entries.Count);
        Assert.Equal("distinct warning", all.Entries[0].Message);
        Assert.DoesNotContain(all.Entries, entry => entry.Message.Contains("item 0", StringComparison.Ordinal));

        var filtered = store.Read(new CoreLogQuery(LogEventLevel.Warning, "distinct"), 10);
        Assert.Single(filtered.Entries);
        Assert.Equal(LogEventLevel.Warning, filtered.Entries[0].Level);
    }

    [Fact]
    public void Store_RedactsSecrets_Truncates_AndKeepsCorrelationOutOfTheMessage()
    {
        var store = new CoreLogStore();
        using var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .Enrich.FromLogContext()
            .WriteTo.Sink(store)
            .CreateLogger();

        using (LogContext.PushProperty(LogPropertyNames.ReleaseId, "rel-42"))
        using (LogContext.PushProperty(LogPropertyNames.WorkId, "work-7"))
        using (LogContext.PushProperty(LogPropertyNames.StreamAttemptId, "attempt-1"))
        {
            logger.Error(
                "Authorization: Bearer super-secret and api_key=also-secret {Padding}",
                new string('x', CoreLogStore.MaximumMessageLength + 100));
        }

        var entry = Assert.Single(store.Read(
            new CoreLogQuery(
                LogEventLevel.Verbose,
                null,
                new LogCorrelation("attempt-1", null, null, null)),
            10).Entries);

        Assert.Equal("rel-42", entry.ReleaseId);
        Assert.Equal("work-7", entry.WorkId);
        Assert.DoesNotContain("super-secret", entry.Message, StringComparison.Ordinal);
        Assert.DoesNotContain("also-secret", entry.Message, StringComparison.Ordinal);
        Assert.True(entry.Message.Length <= CoreLogStore.MaximumMessageLength + 1);
    }

    [Fact]
    public void Correlation_DoesNotLeakBetweenAttemptsForTheSameRelease()
    {
        var store = new CoreLogStore();
        using var logger = new LoggerConfiguration()
            .MinimumLevel.Verbose()
            .Enrich.FromLogContext()
            .WriteTo.Sink(store)
            .CreateLogger();

        foreach (var attempt in (string[])["attempt-one", "attempt-two"])
        {
            using (LogContext.PushProperty(LogPropertyNames.ReleaseId, "shared-release"))
            using (LogContext.PushProperty(LogPropertyNames.StreamAttemptId, attempt))
                logger.Warning("diagnostic for {Attempt}", attempt);
        }

        var entries = store.Read(
            new CoreLogQuery(
                LogEventLevel.Verbose,
                null,
                new LogCorrelation("attempt-one", "shared-release", null, null)),
            10).Entries;

        var entry = Assert.Single(entries);
        Assert.Contains("attempt-one", entry.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void SanitizerRedactsAllCapabilityRoutesAndPreservesOperationSuffix()
    {
        var token = new string('a', 48);
        var raw = string.Join(' ',
            $"/api/v1/stream/{token}",
            $"/api/v1/sessions/{token}/articles",
            $"/api/v1/ephemeral-files/{token}",
            $"/api/v1/playback-sessions/{token}/cancel",
            $"/api/v1/streams/{token}");

        var sanitized = LogSanitizer.SanitizeAndTruncate(raw, 10_000);

        Assert.DoesNotContain(token, sanitized, StringComparison.Ordinal);
        Assert.Contains("/api/v1/sessions/{capability}/articles", sanitized, StringComparison.Ordinal);
        Assert.Contains("/api/v1/playback-sessions/{capability}/cancel", sanitized, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("/api/v1/health", 503, 15_000, LogEventLevel.Verbose)]
    [InlineData("/api/v1/logs", 200, 5, LogEventLevel.Verbose)]
    [InlineData("/api/v1/logs", 401, 5, LogEventLevel.Debug)]
    [InlineData("/api/v1/search", 200, 5, LogEventLevel.Debug)]
    [InlineData("/api/v1/search", 404, 5, LogEventLevel.Debug)]
    [InlineData("/api/v1/search", 408, 5, LogEventLevel.Warning)]
    [InlineData("/api/v1/search", 429, 5, LogEventLevel.Warning)]
    [InlineData("/api/v1/search", 500, 5, LogEventLevel.Error)]
    [InlineData("/api/v1/search", 200, 2_500, LogEventLevel.Information)]
    [InlineData("/api/v1/search", 200, 12_000, LogEventLevel.Warning)]
    [InlineData("/api/v1/stream/secret", 200, 12_000, LogEventLevel.Debug)]
    public void RequestLogPolicy_UsesSignalBasedLevels(
        string path,
        int status,
        double elapsed,
        LogEventLevel expected)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Response.StatusCode = status;

        Assert.Equal(expected, StreamarrServerBootstrap.GetRequestLogLevel(context, elapsed, null));
    }
}
