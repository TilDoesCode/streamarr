using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Playback;

/// <summary>The direct candidate that plays a file as it is on a device (<c>native</c> or <c>vlc</c>), or why none does.</summary>
public sealed record OfflineVerdict(PlaybackCandidate? Candidate, PlaybackDecision Decision, IReadOnlyList<PlanReason> Reasons)
{
    public bool Playable => Candidate is not null;

    /// <summary><c>native</c> or <c>vlc</c>; null when not playable.</summary>
    public string? Engine => Candidate is null ? null : Candidate.Engine.Name == EngineCaps.Vlc ? EngineCaps.Vlc : EngineCaps.Native;

    /// <summary>The play class for ordering: direct (native), vlc or unplayable.</summary>
    public string Class => Candidate is null ? "unplayable" : Engine == EngineCaps.Vlc ? "vlc" : "direct";

    /// <summary>The skipped direct candidates of a failed check, as the decision lists them.</summary>
    public IReadOnlyList<SkippedCandidate> SkippedDirect
        => Decision.Skipped.Where(s => s.Method == DeliveryMode.Direct).ToList();
}

/// <summary>
/// Offline playability (device downloads): the playback decider of a start, restricted to direct play — native direct first, VLC direct
/// second (first with <see cref="EnginePreference.Vlc"/>) — with no connection cap, no quality preference and no subtitle selected,
/// because nothing is streamed and the player picks its tracks itself.
/// </summary>
public static class OfflinePlayback
{
    private static readonly IReadOnlySet<string> NoExclusions = new HashSet<string>();

    public static OfflineVerdict Evaluate(SourceMediaInfo media, DeviceCaps device, EnginePreference engine, ServerHls server, string? audioLanguage = null)
    {
        var offline = device with { MaxBitrateKbps = null };
        var preferences = PlaybackPreferences.Default with { Engine = engine, SubtitleMode = SubtitleMode.Off, AudioLanguage = audioLanguage };
        var decision = PlaybackDecider.Decide(media, offline, preferences, allowTranscoding: false, server, null, -1, NoExclusions);
        var direct = decision.Viable.Where(c => c.Method == DeliveryMode.Direct).ToList();
        var native = direct.FirstOrDefault(c => c.Engine.Name != EngineCaps.Vlc);
        var vlc = direct.FirstOrDefault(c => c.Engine.Name == EngineCaps.Vlc);
        var chosen = engine == EnginePreference.Vlc ? vlc ?? native : native ?? vlc;
        if (chosen is not null)
        {
            var notes = new List<PlanReason>();
            if (chosen.Engine.Name == EngineCaps.Vlc && device.Native is not null && native is null)
                notes.Add(PlanReason.Of("vlc_fallback", "The native player cannot play this version as it is; VLC plays the original file."));
            notes.AddRange(chosen.Notes.Where(n => n.Code != "vlc_fallback" && n.Code != "better_engine"));
            notes.AddRange(chosen.Plan.Reasons.Where(r => r.Code != "transcode_requested"));
            return new OfflineVerdict(chosen, decision, notes.DistinctBy(r => r.Code).ToList());
        }

        var reasons = decision.Skipped.Where(s => s.Method == DeliveryMode.Direct).SelectMany(s => s.Reasons).ToList();
        if (device.Vlc is null)
            reasons.Add(PlanReason.Of("vlc_unavailable", "VLC is not available on this device."));
        if (reasons.Count == 0)
            reasons.Add(PlanReason.Of("not_direct_playable", "No player of this device plays the file as it is."));
        return new OfflineVerdict(null, decision, reasons.DistinctBy(r => r.Code).ToList());
    }
}
