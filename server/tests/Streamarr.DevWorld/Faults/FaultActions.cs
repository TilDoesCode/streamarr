using System.Diagnostics;
using Microsoft.EntityFrameworkCore;
using Streamarr.Server.Persistence;
using Streamarr.Server.Services;
using Streamarr.Server.Transcoding;
using Streamarr.Tests.Shared;

namespace Streamarr.DevWorld.Faults;

/// <summary>Faults that act on state instead of a request: ffmpeg (H5), the session store (H6), playback teardown (H7), mock Usenet (H8).</summary>
public sealed class FaultActions
{
    private readonly FaultRegistry _registry;
    private readonly IServiceProvider _services;
    private readonly MockNntpServer _nntp;
    private readonly PublicationStore _store;
    private readonly ILogger _log;

    public FaultActions(FaultRegistry registry, IServiceProvider services, MockNntpServer nntp, PublicationStore store, FaultPaths paths, ILoggerFactory loggers)
    {
        _registry = registry;
        _services = services;
        _nntp = nntp;
        _store = store;
        Paths = paths;
        _log = loggers.CreateLogger(FaultRegistry.LoggerName);
        registry.Removed += Undo;
    }

    public FaultPaths Paths { get; }

    /// <summary>Runs what a fault does at arm time; returns a short description for the arm answer and log.</summary>
    public async Task<string?> OnArmedAsync(Fault fault, CancellationToken ct)
    {
        var now = _registry.Time.GetUtcNow();
        switch (fault.Name)
        {
            case "token_expire":
            {
                var n = await ExpireAsync(fault.Scope.Value!, fault.Str("session") == "all", ct);
                return Done(fault, $"expired the access token of {n} session(s)");
            }
            case "session_revoke":
            {
                var reason = fault.Str("reason") ?? "revoked_by_viewer";
                await using var db = await Db(ct);
                var ids = await Sessions(db, fault.Scope.Value!, fault.Str("session") == "all").ToListAsync(ct);
                var stored = FaultCatalog.StoredReason(reason);
                await db.ViewerSessions.Where(s => ids.Contains(s.Id)).ExecuteUpdateAsync(s => s
                    .SetProperty(x => x.RevokedAt, now).SetProperty(x => x.RevokedReason, stored).SetProperty(x => x.AccessExpiresAt, now), ct);
                return Done(fault, $"revoked {ids.Count} session(s) with reason {reason} (stored {stored})");
            }
            case "password_change":
            {
                await using var db = await Db(ct);
                var name = fault.Scope.Value!.ToLower();
                var n = await db.Viewers.Where(v => v.Username.ToLower() == name)
                    .ExecuteUpdateAsync(s => s.SetProperty(x => x.MustChangePassword, true), ct);
                return Done(fault, $"flagged {n} account(s) must-change-password");
            }
            case "usenet_hole" or "usenet_stall":
                return Done(fault, ArmUsenet(fault));
            case "transcode_kill" when fault.After is null:
            {
                var n = Kill(fault, _registry.Playbacks.ById(fault.Scope.Value));
                Done(fault, null);
                return $"killed {n} ffmpeg process(es)";
            }
            case "transcode_slow":
                foreach (var record in _registry.Playbacks.List().Where(p => fault.Scope.Kind == "global"
                             || (fault.Scope.Kind == "playbackId" && p.PlaybackId == fault.Scope.Value)
                             || (fault.Scope.Kind == "workId" && p.WorkId == fault.Scope.Value)
                             || (fault.Scope.Kind == "viewer" && string.Equals(p.Viewer, fault.Scope.Value, StringComparison.OrdinalIgnoreCase))))
                {
                    foreach (var token in record.Tokens)
                        WriteSlow(fault, token);
                }
                return "the next ffmpeg run of the scope starts with -readrate";
            case "playback_gone":
                return await CloseAsync(_registry.Playbacks.ById(fault.Scope.Value));
            default:
                return null;
        }
    }

    /// <summary>H4 hook: a resolve produced a stream token; slow faults of that scope apply to its ffmpeg runs.</summary>
    public void OnResolved(string streamToken, string workId, string viewer)
    {
        var request = new ClassifiedRequest(RequestKind.Resolve);
        var scope = new RequestScope(null, workId, viewer);
        foreach (var fault in _registry.Live("transcode_slow").Where(f => _registry.ScopeMatches(f, request, scope)))
            WriteSlow(fault, streamToken);
    }

    /// <summary>Signals the ffmpeg processes whose arguments name one of the playback's tokens.</summary>
    public int Kill(Fault fault, PlaybackRecord? record)
    {
        if (record is null)
            return 0;
        var tokens = record.Tokens.ToList();
        var signal = fault.Str("signal") ?? "KILL";
        var killed = 0;
        foreach (var file in Directory.EnumerateFiles(Paths.PidDir))
        {
            if (!int.TryParse(Path.GetFileName(file), out var pid))
                continue;
            var alive = IsAlive(pid);
            if (alive && tokens.Any(File.ReadAllText(file).Contains))
            {
                using var kill = Process.Start(new ProcessStartInfo("kill", ["-s", signal, pid.ToString()]) { UseShellExecute = false });
                kill?.WaitForExit(5000);
                killed++;
                alive = false;
            }
            if (!alive)
                File.Delete(file);
        }
        _log.LogInformation("DevWorld fault {Id} transcode_kill sent SIG{Signal} to {Count} ffmpeg process(es) of playback {Playback}",
            fault.Id, signal, killed, record.PlaybackId);
        return killed;
    }

    private static bool IsAlive(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return !process.HasExited;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private void WriteSlow(Fault fault, string token)
    {
        var rate = (fault.Num("readrate") ?? 0.5).ToString(System.Globalization.CultureInfo.InvariantCulture);
        File.WriteAllText(Path.Combine(Paths.SlowDir, token), fault.Mode == "always" ? $"{rate} always\n" : $"{rate} once\n");
        _registry.RecordHit(fault, "SLOW", "/api/v1/stream/" + token, $"next ffmpeg run gets -readrate {rate}");
        if (fault.State.TryAdd("slowTokens", new List<string> { token }) is false)
            ((List<string>)fault.State["slowTokens"]).Add(token);
    }

    private string? Done(Fault fault, string? description)
    {
        _registry.Consume(fault);
        if (description is not null)
            _registry.RecordHit(fault, "ARM", fault.Scope.ToString(), description);
        return description;
    }

    private async Task<int> ExpireAsync(string viewer, bool all, CancellationToken ct)
    {
        var now = _registry.Time.GetUtcNow();
        await using var db = await Db(ct);
        var ids = await Sessions(db, viewer, all).ToListAsync(ct);
        return await db.ViewerSessions.Where(s => ids.Contains(s.Id)).ExecuteUpdateAsync(s => s.SetProperty(x => x.AccessExpiresAt, now), ct);
    }

    /// <summary>The viewer's newest live session (by last use), or all of them.</summary>
    private static IQueryable<string> Sessions(StreamarrDbContext db, string viewer, bool all)
    {
        var name = viewer.ToLower();
        var query = from s in db.ViewerSessions
                    join v in db.Viewers on s.ViewerId equals v.Id
                    where v.Username.ToLower() == name && s.RevokedAt == null
                    orderby s.LastSeenAt descending
                    select s.Id;
        return all ? query : query.Take(1);
    }

    private async Task<string> CloseAsync(PlaybackRecord? record)
    {
        if (record is null)
            return "unknown playback: only its API calls answer 404 playback_not_found";
        var transcodes = _services.GetRequiredService<TranscodeSessionManager>();
        var streams = _services.GetRequiredService<SessionManager>();
        int hls = 0, direct = 0;
        foreach (var token in record.Tokens)
        {
            if (transcodes.TryGet(token, out var session))
            {
                await transcodes.CloseAsync(session, "Dev World fault playback_gone");
                hls++;
            }
            if (streams.CloseSession(token))
                direct++;
        }
        return $"closed {hls} HLS session(s) and {direct} stream capability(ies)";
    }

    private string ArmUsenet(Fault fault)
    {
        var record = fault.Scope.Kind == "playbackId" ? _registry.Playbacks.ById(fault.Scope.Value) : null;
        var releases = _store.Releases.Where(r => record?.ReleaseId is { } id
            ? r.ReleaseId == id
            : r.Plan.WorkId == (record?.WorkId ?? fault.Scope.Value)).ToList();
        var from = fault.Num("fromPercent") ?? 0;
        var to = fault.Num("toPercent") ?? 100;
        var keys = new List<string>();
        foreach (var file in releases.Select(r => r.Files.MaxBy(f => f.FileSize)).OfType<Publication>())
        {
            var first = Math.Max(1, (int)Math.Ceiling(file.TotalParts * from / 100));
            var last = Math.Min(file.TotalParts, Math.Max(first, (int)Math.Floor(file.TotalParts * to / 100)));
            for (var part = first; part <= last; part++)
                keys.Add(file.MessageId(part));
        }
        fault.State["keys"] = keys;
        fault.State["releases"] = releases.Select(r => r.ReleaseId).ToList();
        if (fault.Name == "usenet_hole")
        {
            foreach (var key in keys)
                _nntp.BodyScripts[key] = _ => MockBodyBehavior.Missing;
            return $"{keys.Count} article(s) of {releases.Count} release(s) missing ({from}-{to} %)";
        }

        var gate = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        fault.State["gate"] = gate;
        foreach (var key in keys)
            _nntp.BodyGates[key] = gate;
        if (fault.Num("ms") is { } ms)
            _ = Task.Delay(TimeSpan.FromMilliseconds(ms)).ContinueWith(_ => gate.TrySetResult(), TaskScheduler.Default);
        return $"{keys.Count} article body(ies) of {releases.Count} release(s) held{(fault.Num("ms") is { } m ? $" for {m} ms" : " until cleared")}";
    }

    private void Undo(Fault fault)
    {
        switch (fault.Name)
        {
            case "password_change":
                _ = Task.Run(async () =>
                {
                    await using var db = await Db(CancellationToken.None);
                    var name = fault.Scope.Value!.ToLower();
                    await db.Viewers.Where(v => v.Username.ToLower() == name).ExecuteUpdateAsync(s => s.SetProperty(x => x.MustChangePassword, false));
                });
                break;
            case "usenet_hole" when fault.State.TryGetValue("keys", out var keys):
                foreach (var key in (List<string>)keys)
                    _nntp.BodyScripts.TryRemove(key, out _);
                if (fault.State.TryGetValue("releases", out var broken) && _services.GetService<ResettableHealthCache>() is { } health)
                {
                    foreach (var release in (List<string>)broken)
                        health.Reset(release);
                }
                break;
            case "usenet_stall" when fault.State.TryGetValue("keys", out var keys):
                ((TaskCompletionSource)fault.State["gate"]).TrySetResult();
                foreach (var key in (List<string>)keys)
                    _nntp.BodyGates.TryRemove(key, out _);
                break;
            case "transcode_slow" when fault.State.TryGetValue("slowTokens", out var tokens):
                foreach (var token in (List<string>)tokens)
                    File.Delete(Path.Combine(Paths.SlowDir, token));
                break;
        }
    }

    private Task<StreamarrDbContext> Db(CancellationToken ct)
        => _services.GetRequiredService<IDbContextFactory<StreamarrDbContext>>().CreateDbContextAsync(ct);
}

/// <summary>Where the ffmpeg wrapper (H5) records pids and reads slow-down requests.</summary>
public sealed record FaultPaths(string Root)
{
    public string PidDir => Path.Combine(Root, "ffmpeg-pids");
    public string SlowDir => Path.Combine(Root, "ffmpeg-faults");
}
