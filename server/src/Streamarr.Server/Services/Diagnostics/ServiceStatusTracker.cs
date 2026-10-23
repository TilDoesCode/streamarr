using System.Globalization;
using Microsoft.Extensions.Options;
using Streamarr.Server.Config;
using Streamarr.Server.Contracts;
using Streamarr.Server.Controllers;
using Streamarr.Server.Options;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>
/// Turns diagnostics reports into the viewer service status (categories, impacts, since) and sends the operator one
/// debounced "service outage" and one "service recovered" notification per problem.
/// </summary>
public sealed class ServiceStatusTracker(
    NotificationConfigService notificationConfig,
    PushoverNotificationService notifications,
    IOptions<StreamarrOptions> options,
    TimeProvider time,
    ILogger<ServiceStatusTracker> logger)
{
    public const string Ok = "ok";
    public const string Degraded = "degraded";
    public const string Down = "down";

    private static readonly string[] CategoryOrder = ["search", "usenet", "metadata", "server"];
    private static readonly string[] ImpactOrder =
        ["playbackUnavailable", "searchUnavailable", "playbackMayFail", "searchMayBeIncomplete", "newTitlesUnavailable", "slowerThanUsual"];
    private static readonly TimeSpan NotifyFlagLifetime = TimeSpan.FromSeconds(30);

    private readonly object _lock = new();
    private readonly SemaphoreSlim _flagGate = new(1, 1);
    private ServiceStatusResponse? _current;
    private DateTimeOffset? _since;
    private readonly Dictionary<string, DateTimeOffset> _categorySince = new(StringComparer.Ordinal);
    private DateTimeOffset _lastCheckedAt;
    private int _problemChecks;
    private int _okChecks;
    private bool _announced;
    private DateTimeOffset _announcedSince;
    private bool _adminNotified;
    private DateTimeOffset _flagReadAt = DateTimeOffset.MinValue;

    /// <summary>The latest status, or null before the first check.</summary>
    public ServiceStatusResponse? Current
    {
        get
        {
            lock (_lock)
                return _current is null ? null : _current with { AdminNotified = _adminNotified };
        }
    }

    /// <summary>Whether an outage notification was sent and its recovery is still pending.</summary>
    public bool OutageAnnounced
    {
        get
        {
            lock (_lock)
                return _announced;
        }
    }

    /// <summary>Records one report (unredacted components plus the snapshot they came from) and returns the new status.</summary>
    public ServiceStatusResponse Observe(IReadOnlyList<DiagnosticsComponent> components, DependencySnapshot snapshot)
    {
        var evaluation = Evaluate(components);
        var now = time.GetUtcNow();
        NotificationEvent? pending = null;
        ServiceStatusResponse status;
        lock (_lock)
        {
            if (evaluation.State == Ok)
                _since = null;
            else
                _since ??= now;

            var categories = new List<ServiceStatusCategory>(evaluation.Categories.Count);
            foreach (var category in evaluation.Categories)
            {
                DateTimeOffset? since = null;
                if (category.State == Ok)
                    _categorySince.Remove(category.Id);
                else
                {
                    if (!_categorySince.TryGetValue(category.Id, out var started))
                        _categorySince[category.Id] = started = now;
                    since = started;
                }
                categories.Add(new ServiceStatusCategory
                {
                    Id = category.Id,
                    State = category.State,
                    Since = since,
                    Affected = category.Affected,
                    Total = category.Total,
                });
            }

            // Notifications count distinct dependency checks only; reports reusing a cached snapshot do not advance them.
            if (snapshot.CheckedAt != _lastCheckedAt)
            {
                _lastCheckedAt = snapshot.CheckedAt;
                pending = Debounce(evaluation, components, snapshot, now);
            }

            status = new ServiceStatusResponse
            {
                State = evaluation.State,
                Categories = categories,
                Impacts = evaluation.Impacts,
                Since = _since,
                CheckedAt = snapshot.CheckedAt,
                AdminNotified = _adminNotified,
            };
            _current = status;
        }
        if (pending is not null && !notifications.Enqueue(pending))
            logger.LogWarning("Service status notification dropped: the notification queue is full");
        return status;
    }

    /// <summary>Whether the operator is notified about outages (cached for a few seconds; the config is one row).</summary>
    public async Task<bool> AdminNotifiedAsync(CancellationToken ct)
    {
        if (time.GetUtcNow() - _flagReadAt < NotifyFlagLifetime)
            return _adminNotified;
        await _flagGate.WaitAsync(ct);
        try
        {
            if (time.GetUtcNow() - _flagReadAt < NotifyFlagLifetime)
                return _adminNotified;
            bool flag;
            try
            {
                var config = await notificationConfig.GetAsync(ct);
                flag = config.Enabled && config.NotifyServiceStatus &&
                       !string.IsNullOrEmpty(config.AppTokenEncrypted) && !string.IsNullOrEmpty(config.UserKeyEncrypted);
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                logger.LogDebug(e, "Notification config unavailable for the service status");
                flag = false;
            }
            lock (_lock)
                _adminNotified = flag;
            _flagReadAt = time.GetUtcNow();
            return flag;
        }
        finally
        {
            _flagGate.Release();
        }
    }

    /// <summary>Tests: pins the notification flag without a config read.</summary>
    internal void PinAdminNotified(bool value)
    {
        lock (_lock)
            _adminNotified = value;
        _flagReadAt = DateTimeOffset.MaxValue - TimeSpan.FromDays(365);
    }

    /// <summary>Forgets the cached notification flag (after the admin saves the notification settings).</summary>
    public void InvalidateNotificationFlag() => _flagReadAt = DateTimeOffset.MinValue;

    private NotificationEvent? Debounce(
        Evaluation evaluation,
        IReadOnlyList<DiagnosticsComponent> components,
        DependencySnapshot snapshot,
        DateTimeOffset now)
    {
        var threshold = Math.Max(1, options.Value.Diagnostics.NotifyAfterChecks);
        if (evaluation.Notable)
        {
            _problemChecks++;
            _okChecks = 0;
            // Only announce while the operator is subscribed, so enabling it mid-outage still sends the start.
            if (_announced || _problemChecks < threshold || !_adminNotified)
                return null;
            _announced = true;
            _announcedSince = _since ?? now;
            return new NotificationEvent(
                NotificationEventKind.ServiceOutage,
                evaluation.State == Down ? "Streamarr service outage" : "Streamarr service degraded",
                OutageMessage(evaluation, components, snapshot),
                "service-status");
        }

        _okChecks++;
        _problemChecks = 0;
        if (!_announced || _okChecks < threshold)
            return null;
        _announced = false;
        return new NotificationEvent(
            NotificationEventKind.ServiceRecovered,
            "Streamarr service recovered",
            $"Search, Usenet, metadata and the server work again after {Duration(now - _announcedSince)}.",
            "service-status");
    }

    private static string OutageMessage(Evaluation evaluation, IReadOnlyList<DiagnosticsComponent> components, DependencySnapshot snapshot)
    {
        var lines = new List<string>();
        foreach (var category in evaluation.Categories.Where(c => c.State != Ok))
        {
            var failing = category.Id switch
            {
                "search" => Names(components, "indexer", snapshot.Indexers),
                "usenet" => Names(components, "provider", snapshot.Providers),
                _ => components.Where(c => Category(c) == category.Id && c.Status is Down or Degraded).Select(c => c.Name).ToList(),
            };
            var label = category.Id switch
            {
                "search" => "Indexers",
                "usenet" => "Usenet providers",
                "metadata" => "Metadata (TMDB)",
                _ => "Server",
            };
            var count = category.Total > 1 ? string.Create(CultureInfo.InvariantCulture, $" {category.Affected} of {category.Total}") : "";
            var names = failing.Count > 0 ? $" ({string.Join(", ", failing)})" : category.Total == 0 ? " (none configured)" : "";
            lines.Add($"{label}: {category.State}{count}{names}");
        }
        lines.Add("Viewers see: " + string.Join(", ", evaluation.Impacts));
        return string.Join("\n", lines);
    }

    private static List<string> Names(IReadOnlyList<DiagnosticsComponent> components, string kind, IReadOnlyList<DependencyProbe> probes)
        => components.Where(c => c.Kind == kind)
            .Select((c, i) => (c, i))
            .Where(x => x.c.Status is Down or Degraded)
            .Select(x => x.i < probes.Count ? probes[x.i].Name : x.c.Name)
            .ToList();

    private static string Duration(TimeSpan duration)
        => duration.TotalHours >= 1
            ? string.Create(CultureInfo.InvariantCulture, $"{duration.TotalHours:0.#} hours")
            : string.Create(CultureInfo.InvariantCulture, $"{Math.Max(1, duration.TotalMinutes):0} minutes");

    private static string? Category(DiagnosticsComponent component) => component.Kind switch
    {
        "indexer" => "search",
        "provider" => "usenet",
        "metadata" => "metadata",
        "database" or "disk" or "streams" => "server",
        _ => null,
    };

    internal sealed record CategoryEvaluation(string Id, string State, int Affected, int Total, bool LoadOnly);

    internal sealed record Evaluation(string State, IReadOnlyList<CategoryEvaluation> Categories, IReadOnlyList<string> Impacts, bool Notable);

    /// <summary>Maps report components to the four viewer categories, the overall state and impact codes.</summary>
    internal static Evaluation Evaluate(IReadOnlyList<DiagnosticsComponent> components)
    {
        var categories = new List<CategoryEvaluation>();
        var impacts = new HashSet<string>(StringComparer.Ordinal);
        foreach (var id in CategoryOrder)
        {
            var parts = components.Where(c => Category(c) == id && c.Status != "unconfigured").ToList();
            var failing = parts.Where(c => c.Status is Down or Degraded).ToList();
            var slowOnly = failing.Count > 0 && failing.All(c => c.ErrorCode == "slow");
            var loadOnly = failing.Count > 0 && failing.All(c => c.ErrorCode is "slow" or "exhausted");
            var state = id switch
            {
                "search" or "usenet" => parts.Count == 0 || parts.All(c => c.Status == Down) ? Down
                    : failing.Count > 0 ? Degraded : Ok,
                "metadata" => parts.Any(c => c.Status == Down) ? Down : failing.Count > 0 ? Degraded : Ok,
                _ => parts.Any(c => c is { Kind: "database", Status: Down }) ? Down : failing.Count > 0 ? Degraded : Ok,
            };
            if (state != Ok && slowOnly && state != Down)
                impacts.Add("slowerThanUsual");
            else if (state == Down)
            {
                switch (id)
                {
                    case "search":
                        impacts.Add("searchUnavailable");
                        break;
                    case "usenet":
                        impacts.Add("playbackUnavailable");
                        break;
                    case "metadata":
                        impacts.Add("newTitlesUnavailable");
                        break;
                    default:
                        impacts.Add("playbackUnavailable");
                        impacts.Add("searchUnavailable");
                        break;
                }
            }
            else if (state == Degraded)
            {
                impacts.Add(id switch
                {
                    "search" => "searchMayBeIncomplete",
                    "metadata" => "slowerThanUsual",
                    _ => "playbackMayFail",
                });
            }
            categories.Add(new CategoryEvaluation(id, state, parts.Count == 0 ? 0 : failing.Count, parts.Count, state != Down && loadOnly));
        }

        var overall = categories.Any(c => c.State == Down && c.Id != "metadata") ? Down
            : categories.Any(c => c.State != Ok) ? Degraded
            : Ok;
        // Slowness and a busy stream budget show to viewers but never page the operator.
        var notable = categories.Any(c => c.State != Ok && !c.LoadOnly);
        var ordered = ImpactOrder.Where(impacts.Contains).ToList();
        return new Evaluation(overall, categories, ordered, notable);
    }
}
