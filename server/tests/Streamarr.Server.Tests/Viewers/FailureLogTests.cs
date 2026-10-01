using System.Net;
using Microsoft.Extensions.Logging;
using Streamarr.Server.Viewers;

namespace Streamarr.Server.Tests.Viewers;

public sealed class FailureLogTests
{
    [Fact]
    public void FirstFailurePerCause_IsAWarning_RepeatsAreDebug()
    {
        var logger = new Capture();
        var log = new FailureLog(logger);

        log.Log(new HttpRequestException("x", null, HttpStatusCode.ServiceUnavailable), "Palette for {Url} failed", "a");
        log.Log(new HttpRequestException("x", null, HttpStatusCode.ServiceUnavailable), "Palette for {Url} failed", "b");
        log.Log(new HttpRequestException("x", null, HttpStatusCode.NotFound), "Palette for {Url} failed", "c");
        log.Log(new TimeoutException(), "Palette for {Url} failed", "d");

        Assert.Equal([LogLevel.Warning, LogLevel.Debug, LogLevel.Warning, LogLevel.Warning], logger.Levels);
    }

    private sealed class Capture : ILogger
    {
        public List<LogLevel> Levels { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter) => Levels.Add(logLevel);
    }
}
