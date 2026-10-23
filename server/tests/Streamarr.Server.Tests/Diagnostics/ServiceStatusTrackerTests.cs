using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Options;
using Streamarr.Server.Services;
using Streamarr.Server.Services.Diagnostics;
using Streamarr.Server.Tests.Viewers;

namespace Streamarr.Server.Tests.Diagnostics;

/// <summary>Viewer status categories, impacts, since tracking and the debounced outage/recovery notifications.</summary>
public sealed class ServiceStatusTrackerTests
{
    private readonly ManualClock _clock = new(new DateTimeOffset(2026, 10, 24, 12, 0, 0, TimeSpan.Zero));
    private readonly PushoverNotificationService _pushover;
    private readonly ServiceStatusTracker _tracker;

    public ServiceStatusTrackerTests()
    {
        _pushover = new PushoverNotificationService(null!, null!, _clock, NullLogger<PushoverNotificationService>.Instance);
        _tracker = new ServiceStatusTracker(
            null!,
            _pushover,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()),
            _clock,
            NullLogger<ServiceStatusTracker>.Instance);
        _tracker.PinAdminNotified(true);
    }

    private static DiagnosticsComponent C(string kind, string status, string? code = null, int n = 1)
        => new() { Id = $"{kind}:{n}", Kind = kind, Name = $"{kind} {n}", Status = status, ErrorCode = code };

    private static List<DiagnosticsComponent> Healthy() =>
    [
        C("database", "ok"), C("metadata", "ok"), C("provider", "ok"), C("provider", "ok", n: 2),
        C("indexer", "ok"), C("indexer", "ok", n: 2), C("disk", "ok"), C("streams", "ok"),
    ];

    private static List<DiagnosticsComponent> ProvidersDown()
    {
        var components = Healthy();
        components[2] = C("provider", "down", "timeout");
        components[3] = C("provider", "down", "auth_failed", 2);
        return components;
    }

    private DependencySnapshot Check() => new()
    {
        Indexers = [new DependencyProbe { Id = "i1", Name = "NZB Planet", Reachable = true }, new DependencyProbe { Id = "i2", Name = "Second Indexer", Reachable = true }],
        Providers = [new DependencyProbe { Id = "p1", Name = "Eweka Main", Reachable = false }, new DependencyProbe { Id = "p2", Name = "Backup Block", Reachable = false }],
        CheckedAt = _clock.GetUtcNow(),
    };

    private ServiceStatusResponse Observe(List<DiagnosticsComponent> components)
    {
        var status = _tracker.Observe(components, Check());
        _clock.Advance(TimeSpan.FromMinutes(3));
        return status;
    }

    private List<NotificationEvent> Sent()
    {
        var events = new List<NotificationEvent>();
        while (_pushover.TryDequeue(out var e))
            events.Add(e);
        return events;
    }

    [Fact]
    public void Healthy_IsOkWithFourOkCategoriesAndNoSince()
    {
        var status = Observe(Healthy());

        Assert.Equal("ok", status.State);
        Assert.Equal(["search", "usenet", "metadata", "server"], status.Categories.Select(c => c.Id));
        Assert.All(status.Categories, c => Assert.Equal("ok", c.State));
        Assert.Empty(status.Impacts);
        Assert.Null(status.Since);
        Assert.Equal(2, status.Categories.Single(c => c.Id == "usenet").Total);
    }

    [Theory]
    [InlineData("provider", "down", "down", "usenet", "playbackUnavailable")]
    [InlineData("indexer", "down", "down", "search", "searchUnavailable")]
    [InlineData("metadata", "down", "degraded", "metadata", "newTitlesUnavailable")]
    [InlineData("database", "down", "down", "server", "playbackUnavailable")]
    public void CategoryDown_MapsToStateAndImpact(string kind, string componentStatus, string overall, string category, string impact)
    {
        var components = Healthy().Select(c => c.Kind == kind ? c with { Status = componentStatus, ErrorCode = "unreachable" } : c).ToList();

        var status = Observe(components);

        Assert.Equal(overall, status.State);
        Assert.Equal("down", status.Categories.Single(c => c.Id == category).State);
        Assert.Equal(impact, status.Impacts[0]);
    }

    [Fact]
    public void PartialAndSlowProblems_AreDegradedWithMilderImpacts()
    {
        var components = Healthy();
        components[2] = C("provider", "down", "unreachable");
        components[4] = C("indexer", "degraded", "slow");
        components[^1] = C("streams", "degraded", "exhausted");

        var status = Observe(components);

        Assert.Equal("degraded", status.State);
        var usenet = status.Categories.Single(c => c.Id == "usenet");
        Assert.Equal(("degraded", 1, 2), (usenet.State, usenet.Affected, usenet.Total));
        Assert.Equal(["playbackMayFail", "slowerThanUsual"], status.Impacts);
    }

    [Fact]
    public void NoIndexersConfigured_IsSearchDown_AndUnconfiguredTmdbIsIgnored()
    {
        var components = Healthy().Where(c => c.Kind != "indexer").ToList();
        components[1] = C("metadata", "unconfigured", "not_configured");

        var status = Observe(components);

        Assert.Equal("down", status.Categories.Single(c => c.Id == "search").State);
        Assert.Equal("ok", status.Categories.Single(c => c.Id == "metadata").State);
        Assert.Equal(["searchUnavailable"], status.Impacts);
    }

    [Fact]
    public void Since_IsTheFirstFailingCheck_KeptAcrossWorsening_AndClearedOnRecovery()
    {
        var start = _clock.GetUtcNow();
        var partial = Healthy();
        partial[2] = C("provider", "down", "timeout");

        Assert.Equal(start, Observe(partial).Since);
        var worse = Observe(ProvidersDown());
        Assert.Equal("down", worse.State);
        Assert.Equal(start, worse.Since);
        Assert.Equal(start, worse.Categories.Single(c => c.Id == "usenet").Since);

        var indexerAlso = ProvidersDown();
        indexerAlso[4] = C("indexer", "down", "timeout");
        var later = _clock.GetUtcNow();
        var both = Observe(indexerAlso);
        Assert.Equal(start, both.Since);
        Assert.Equal(later, both.Categories.Single(c => c.Id == "search").Since);

        var healed = Observe(Healthy());
        Assert.Equal("ok", healed.State);
        Assert.Null(healed.Since);
        Assert.All(healed.Categories, c => Assert.Null(c.Since));
        Assert.Equal("ok", _tracker.Current!.State);
    }

    [Fact]
    public void Notification_OnlyAfterTwoChecks_OnceForStart_OnceForRecovery()
    {
        Observe(ProvidersDown());
        Assert.Empty(Sent());

        Observe(ProvidersDown());
        var outage = Assert.Single(Sent());
        Assert.Equal(NotificationEventKind.ServiceOutage, outage.Kind);
        Assert.Contains("Usenet providers: down 2 of 2 (Eweka Main, Backup Block)", outage.Message);
        Assert.Contains("playbackUnavailable", outage.Message);
        Assert.True(_tracker.OutageAnnounced);

        for (var i = 0; i < 5; i++)
            Observe(ProvidersDown());
        Assert.Empty(Sent());

        Observe(Healthy());
        Assert.Empty(Sent());
        Observe(Healthy());
        var recovered = Assert.Single(Sent());
        Assert.Equal(NotificationEventKind.ServiceRecovered, recovered.Kind);
        Assert.Contains("24 minutes", recovered.Message);
        Assert.False(_tracker.OutageAnnounced);

        Observe(Healthy());
        Assert.Empty(Sent());
    }

    [Fact]
    public void Notification_SingleFailedCheckOrFlapping_SendsNothing()
    {
        for (var i = 0; i < 4; i++)
        {
            Observe(ProvidersDown());
            Observe(Healthy());
        }
        Assert.Empty(Sent());
    }

    [Fact]
    public void Notification_ReportsReusingTheSameSnapshot_DoNotCountAsChecks()
    {
        var snapshot = Check();
        _tracker.Observe(ProvidersDown(), snapshot);
        _tracker.Observe(ProvidersDown(), snapshot);
        _tracker.Observe(ProvidersDown(), snapshot);

        Assert.Empty(Sent());
        Assert.Equal("down", _tracker.Current!.State);
    }

    [Fact]
    public void Notification_SlownessAndBusyStreams_NeverPage()
    {
        var components = Healthy();
        components[2] = C("provider", "degraded", "slow");
        components[^1] = C("streams", "degraded", "exhausted");

        for (var i = 0; i < 4; i++)
            Assert.Equal("degraded", Observe(components).State);

        Assert.Empty(Sent());
    }

    [Fact]
    public void Notification_WaitsForTheOptIn_ThenAnnouncesAPersistingOutage_AndNeverAnOrphanRecovery()
    {
        _tracker.PinAdminNotified(false);
        Observe(ProvidersDown());
        Observe(ProvidersDown());
        Observe(Healthy());
        Observe(Healthy());
        Assert.Empty(Sent());

        Observe(ProvidersDown());
        Observe(ProvidersDown());
        Assert.Empty(Sent());
        _tracker.PinAdminNotified(true);
        Observe(ProvidersDown());
        Assert.Equal(NotificationEventKind.ServiceOutage, Assert.Single(Sent()).Kind);
    }

    [Fact]
    public void Notification_RespectsTheConfiguredCheckCount()
    {
        var tracker = new ServiceStatusTracker(
            null!,
            _pushover,
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions { Diagnostics = new DiagnosticsOptions { NotifyAfterChecks = 3 } }),
            _clock,
            NullLogger<ServiceStatusTracker>.Instance);
        tracker.PinAdminNotified(true);

        for (var i = 0; i < 2; i++)
        {
            tracker.Observe(ProvidersDown(), Check());
            _clock.Advance(TimeSpan.FromMinutes(1));
        }
        Assert.Empty(Sent());
        tracker.Observe(ProvidersDown(), Check());
        Assert.Single(Sent());
    }
}
