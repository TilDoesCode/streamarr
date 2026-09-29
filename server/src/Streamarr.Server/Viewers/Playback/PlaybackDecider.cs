using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Playback;

/// <summary>User preferences of one playback (validated).</summary>
public sealed record PlaybackPreferences(
    EnginePreference Engine,
    int? MaxHeight,
    int? MaxBitrateKbps,
    string? AudioLanguage,
    string? SubtitleLanguage,
    SubtitleMode SubtitleMode)
{
    public static PlaybackPreferences Default { get; } = new(EnginePreference.Auto, null, null, null, null, SubtitleMode.Forced);

    /// <summary>Set fields of <paramref name="dto"/> replace the ones of <paramref name="current"/>.</summary>
    public static PlaybackPreferences Merge(PlaybackPreferencesDto? dto, PlaybackPreferences current)
    {
        if (dto is null)
            return current;
        var engine = dto.Engine?.Trim().ToLowerInvariant() switch
        {
            null => current.Engine,
            "auto" => EnginePreference.Auto,
            "native" => EnginePreference.Native,
            "vlc" => EnginePreference.Vlc,
            _ => throw Invalid("'preferences.engine' must be auto, native or vlc."),
        };
        var mode = dto.SubtitleMode?.Trim().ToLowerInvariant() switch
        {
            null => current.SubtitleMode,
            "off" => SubtitleMode.Off,
            "forced" => SubtitleMode.Forced,
            "always" => SubtitleMode.Always,
            _ => throw Invalid("'preferences.subtitleMode' must be off, forced or always."),
        };
        if (dto.MaxHeight is < 144 or > 4320)
            throw Invalid("'preferences.maxHeight' must be between 144 and 4320.");
        if (dto.MaxBitrateKbps is < 300 or > 200_000)
            throw Invalid("'preferences.maxBitrateKbps' must be between 300 and 200000.");
        return new PlaybackPreferences(
            engine,
            dto.MaxHeight ?? current.MaxHeight,
            dto.MaxBitrateKbps ?? current.MaxBitrateKbps,
            dto.AudioLanguage is null ? current.AudioLanguage : Language(dto.AudioLanguage, "audioLanguage"),
            dto.SubtitleLanguage is null ? current.SubtitleLanguage : Language(dto.SubtitleLanguage, "subtitleLanguage"),
            mode);
    }

    private static string? Language(string value, string field)
    {
        var trimmed = value.Trim();
        if (trimmed.Length == 0)
            return null;
        var primary = trimmed.Split('-', '_')[0];
        return trimmed.Length <= 16 && WebVttSubtitles.Bcp47(primary) is { } code
            ? code
            : throw Invalid($"'preferences.{field}' must be an ISO 639 language code.");
    }

    private static ViewerProblem Invalid(string message) => ViewerProblem.BadRequest("invalid_playback_request", message);
}

/// <summary>A failure with a stable code, localizable params and what the viewer can do next.</summary>
public sealed class PlaybackFailure(string code, string message, IReadOnlyDictionary<string, string>? parameters, IReadOnlyList<string> suggestedActions)
    : Exception(message)
{
    public string Code { get; } = code;
    public IReadOnlyDictionary<string, string>? Parameters { get; } = parameters;
    public IReadOnlyList<string> SuggestedActions { get; } = suggestedActions;
}

public static class SuggestedActions
{
    public const string Retry = "retry";
    public const string OtherVersion = "otherVersion";
    public const string LowerQuality = "lowerQuality";
    public const string UseVlc = "useVlc";
}

public sealed record TrackSelection(SourceAudioStream? Audio, SourceSubtitleStream? Subtitle, IReadOnlyList<PlanReason> Notes);

/// <summary>Default audio and subtitle choice from explicit indexes, then the viewer's languages and subtitle mode.</summary>
public static class TrackSelector
{
    public static TrackSelection Select(SourceMediaInfo media, int? audioIndex, int? subtitleIndex, PlaybackPreferences preferences)
    {
        var notes = new List<PlanReason>();
        var audio = SelectAudio(media, audioIndex, preferences, notes);
        var subtitle = SelectSubtitle(media, subtitleIndex, preferences, Lang(audio?.Language), notes);
        return new TrackSelection(audio, subtitle, notes);
    }

    private static SourceAudioStream? SelectAudio(SourceMediaInfo media, int? index, PlaybackPreferences preferences, List<PlanReason> notes)
    {
        if (index is { } requested)
        {
            var found = media.Audio.FirstOrDefault(a => a.Index == requested)
                        ?? throw new PlaybackFailure("unknown_audio_stream", $"Audio stream {requested} does not exist in this version.",
                            Params(("index", requested)), [SuggestedActions.Retry]);
            notes.Add(PlanReason.Of("audio_track_requested", $"Audio stream {requested} was requested.", ("index", requested), ("language", Lang(found.Language))));
            return found;
        }
        if (media.Audio.Count == 0)
            return null;
        if (preferences.AudioLanguage is { } language)
        {
            var matching = media.Audio.Where(a => Lang(a.Language) == language).ToList();
            if (matching.Count > 0)
            {
                var chosen = matching.FirstOrDefault(a => a.IsDefault) ?? matching[0];
                notes.Add(PlanReason.Of("audio_language", $"Audio stream {chosen.Index} matches the preferred language '{language}'.",
                    ("index", chosen.Index), ("language", language)));
                return chosen;
            }
            notes.Add(PlanReason.Of("audio_language_unavailable", $"No audio track in '{language}'; the default track plays.", ("language", language)));
        }
        return media.Audio.FirstOrDefault(a => a.IsDefault) ?? media.Audio[0];
    }

    private static SourceSubtitleStream? SelectSubtitle(
        SourceMediaInfo media, int? index, PlaybackPreferences preferences, string? audioLanguage, List<PlanReason> notes)
    {
        if (index is { } requested)
        {
            if (requested < 0)
                return null;
            var found = media.Subtitles.FirstOrDefault(s => s.Index == requested)
                        ?? throw new PlaybackFailure("unknown_subtitle_stream", $"Subtitle stream {requested} does not exist in this version.",
                            Params(("index", requested)), [SuggestedActions.Retry]);
            notes.Add(PlanReason.Of("subtitle_track_requested", $"Subtitle stream {requested} was requested.", ("index", requested), ("language", Lang(found.Language))));
            return found;
        }
        switch (preferences.SubtitleMode)
        {
            case SubtitleMode.Forced:
            {
                var language = audioLanguage ?? preferences.AudioLanguage;
                var forced = media.Subtitles.Where(s => s.IsForced).ToList();
                var chosen = forced.FirstOrDefault(s => language is not null && Lang(s.Language) == language)
                             ?? forced.FirstOrDefault(s => Lang(s.Language) is null);
                if (chosen is not null)
                {
                    notes.Add(PlanReason.Of("subtitle_forced", $"Forced subtitle stream {chosen.Index} matches the audio language.",
                        ("index", chosen.Index), ("language", Lang(chosen.Language))));
                }
                return chosen;
            }
            case SubtitleMode.Always:
            {
                var language = preferences.SubtitleLanguage;
                if (language is null)
                {
                    var fallback = media.Subtitles.FirstOrDefault(s => s.IsDefault) ?? media.Subtitles.FirstOrDefault(s => !s.IsForced);
                    if (fallback is not null)
                        notes.Add(PlanReason.Of("subtitle_default", $"Subtitle stream {fallback.Index} is the file's default.", ("index", fallback.Index)));
                    return fallback;
                }
                var matching = media.Subtitles.Where(s => Lang(s.Language) == language).ToList();
                var chosen = matching.FirstOrDefault(s => !s.IsForced && s.IsDefault) ?? matching.FirstOrDefault(s => !s.IsForced) ?? matching.FirstOrDefault();
                notes.Add(chosen is null
                    ? PlanReason.Of("subtitle_language_unavailable", $"No subtitle in '{language}'.", ("language", language))
                    : PlanReason.Of("subtitle_language", $"Subtitle stream {chosen.Index} matches the preferred language '{language}'.",
                        ("index", chosen.Index), ("language", language)));
                return chosen;
            }
            default:
                return null;
        }
    }

    internal static string? Lang(string? language) => WebVttSubtitles.Bcp47(language);

    internal static IReadOnlyDictionary<string, string> Params(params (string Key, object? Value)[] values)
        => values.Where(v => v.Value is not null)
            .ToDictionary(v => v.Key, v => Convert.ToString(v.Value, System.Globalization.CultureInfo.InvariantCulture)!, StringComparer.Ordinal);
}

/// <summary>Whether the server can run ffmpeg for a remux or transcode, and the settings the planner uses.</summary>
public sealed record ServerHls(bool Available, string? UnavailableCode, TranscodingSettings Settings, FfmpegCapabilities Capabilities);

/// <summary>A method the device can use for this source, with the plan that explains it.</summary>
public sealed record PlaybackCandidate(
    DeliveryMode Method,
    EngineCaps Engine,
    ClientProfile Client,
    TranscodeLimits Limits,
    TranscodePlan Plan,
    IReadOnlyList<PlanReason> Notes)
{
    public string Key => PlaybackDecider.Key(Method, Engine.Name);
}

public sealed record SkippedCandidate(DeliveryMode Method, string Engine, IReadOnlyList<PlanReason> Reasons);

public sealed record PlaybackDecision(
    IReadOnlyList<PlaybackCandidate> Viable,
    IReadOnlyList<SkippedCandidate> Skipped,
    TrackSelection Tracks,
    IReadOnlyList<PlanReason> Notes,
    PlaybackFailure? Failure);

/// <summary>PLAN §2 ranking (native direct, native remux, VLC direct, transcode); image subtitles prefer VLC, then burn-in, then none.</summary>
public static class PlaybackDecider
{
    public static string Key(DeliveryMode method, string engine) => $"{method.ToApi()}:{engine}";

    private sealed record Step(DeliveryMode Method, EngineCaps Engine, bool WithSubtitle, bool BurnIn);

    public static PlaybackDecision Decide(
        SourceMediaInfo media,
        DeviceCaps device,
        PlaybackPreferences preferences,
        bool allowTranscoding,
        ServerHls server,
        int? audioIndex,
        int? subtitleIndex,
        IReadOnlySet<string> excluded)
    {
        var tracks = TrackSelector.Select(media, audioIndex, subtitleIndex, preferences);
        var notes = new List<PlanReason>(tracks.Notes);
        var maxBitrate = Min(preferences.MaxBitrateKbps, device.MaxBitrateKbps);
        if (device.MaxBitrateKbps is { } cap && (preferences.MaxBitrateKbps is null || cap < preferences.MaxBitrateKbps))
            notes.Add(PlanReason.Of("bandwidth_limit", $"The device's connection allows {cap} kbps.", ("max", cap)));

        var preference = preferences.Engine;
        if (preference == EnginePreference.Vlc && device.Vlc is null)
        {
            notes.Add(PlanReason.Of("vlc_unavailable", "VLC was requested but is not available on this device."));
            preference = EnginePreference.Auto;
        }
        if (preference == EnginePreference.Native && device.Native is null)
        {
            notes.Add(PlanReason.Of("native_unavailable", "The device has no native engine; VLC plays."));
            preference = EnginePreference.Auto;
        }

        var steps = Steps(device, preference, tracks.Subtitle);
        var viable = new List<PlaybackCandidate>();
        var skipped = new List<SkippedCandidate>();
        foreach (var step in steps)
        {
            var reasons = Blockers(step, media, device, allowTranscoding, server, tracks, excluded);
            if (reasons.Count > 0)
            {
                skipped.Add(new SkippedCandidate(step.Method, step.Engine.Name, reasons));
                continue;
            }
            var client = step.Engine.ClientFor(media.Video);
            var limits = new TranscodeLimits(
                step.Method == DeliveryMode.Transcode ? Min(preferences.MaxHeight, OutputMaxHeight(step.Engine, server.Settings)) : preferences.MaxHeight,
                maxBitrate,
                tracks.Audio?.Index,
                step.WithSubtitle ? tracks.Subtitle?.Index : null,
                step.BurnIn);
            TranscodePlan plan;
            try
            {
                plan = step.Method switch
                {
                    DeliveryMode.Direct => TranscodePlanner.Decide(media, client, limits, server.Settings, server.Capabilities, ModePreference.Auto, allowDirect: true),
                    DeliveryMode.Remux => TranscodePlanner.Decide(media, client, limits, server.Settings, server.Capabilities, ModePreference.Remux, allowDirect: false),
                    _ => TranscodePlanner.Decide(media, client, limits, server.Settings, server.Capabilities, ModePreference.Transcode, allowDirect: false),
                };
            }
            catch (TranscodePlanningException e)
            {
                skipped.Add(new SkippedCandidate(step.Method, step.Engine.Name, [PlanReason.Of(e.Code, e.Message)]));
                continue;
            }
            if (plan.Mode != step.Method)
            {
                var why = step.Method == DeliveryMode.Direct ? plan.DirectPlayReasons : plan.RemuxBlockers;
                skipped.Add(new SkippedCandidate(step.Method, step.Engine.Name, why.Count > 0 ? why : [PlanReason.Of("not_possible", $"{step.Method.ToApi()} is not possible.")]));
                continue;
            }
            var candidateNotes = new List<PlanReason>();
            if (step.Engine.Name == EngineCaps.Vlc && preference == EnginePreference.Auto && device.Native is not null)
            {
                candidateNotes.Add(tracks.Subtitle is { TextBased: false } image && step.WithSubtitle
                    ? PlanReason.Of("image_subtitle_vlc", $"VLC plays the original file so the image subtitle ({image.Codec}) shows.", ("codec", image.Codec))
                    : PlanReason.Of("vlc_fallback", "The native player cannot play this version as it is; VLC plays the original file."));
            }
            if (!step.WithSubtitle && tracks.Subtitle is { } dropped)
            {
                candidateNotes.Add(PlanReason.Of("subtitle_not_deliverable",
                    $"Subtitle stream {dropped.Index} ({dropped.Codec}) cannot be shown with {step.Method.ToApi()} on the {step.Engine.Name} engine; it plays without it.",
                    ("index", dropped.Index), ("codec", dropped.Codec), ("mode", step.Method.ToApi())));
            }
            viable.Add(new PlaybackCandidate(step.Method, step.Engine, client, limits, plan, candidateNotes));
        }

        var failure = viable.Count > 0 ? null : Failure(skipped, device, preference);
        return new PlaybackDecision(viable.DistinctBy(c => c.Key).ToList(), skipped, tracks, notes, failure);
    }

    private static List<Step> Steps(DeviceCaps device, EnginePreference preference, SourceSubtitleStream? subtitle)
    {
        var native = device.Native;
        var vlc = device.Vlc;
        var steps = new List<Step>();
        void Normal(bool withSubtitle)
        {
            if (preference == EnginePreference.Vlc)
            {
                steps.Add(new Step(DeliveryMode.Direct, vlc!, withSubtitle, false));
                steps.Add(new Step(DeliveryMode.Transcode, vlc!, withSubtitle, false));
                return;
            }
            if (native is not null)
            {
                steps.Add(new Step(DeliveryMode.Direct, native, withSubtitle, false));
                steps.Add(new Step(DeliveryMode.Remux, native, withSubtitle, false));
            }
            if (preference == EnginePreference.Auto && vlc is not null)
                steps.Add(new Step(DeliveryMode.Direct, vlc, withSubtitle, false));
            steps.Add(new Step(DeliveryMode.Transcode, native ?? vlc!, withSubtitle, false));
        }

        var image = subtitle is { TextBased: false } ? subtitle : null;
        var imageEngine = preference == EnginePreference.Vlc ? vlc : native ?? vlc;
        if (image is null || imageEngine!.RendersSubtitle(image.Codec))
        {
            Normal(withSubtitle: true);
            return steps;
        }

        if (preference == EnginePreference.Auto && vlc is not null)
            steps.Add(new Step(DeliveryMode.Direct, vlc, true, false));
        steps.Add(new Step(DeliveryMode.Transcode, imageEngine, true, true));
        Normal(withSubtitle: false);
        return steps;
    }

    private static List<PlanReason> Blockers(
        Step step, SourceMediaInfo media, DeviceCaps device, bool allowTranscoding, ServerHls server, TrackSelection tracks, IReadOnlySet<string> excluded)
    {
        var reasons = new List<PlanReason>();
        if (excluded.Contains(Key(step.Method, step.Engine.Name)))
        {
            reasons.Add(PlanReason.Of("step_down", $"{step.Method.ToApi()} on {step.Engine.Name} failed on the device earlier.",
                ("method", step.Method.ToApi()), ("engine", step.Engine.Name)));
            return reasons;
        }
        if (step.Method != DeliveryMode.Direct)
        {
            if (!step.Engine.Hls)
                reasons.Add(PlanReason.Of("hls_unsupported", $"The {step.Engine.Name} engine does not play HLS.", ("engine", step.Engine.Name)));
            if (!server.Available)
            {
                reasons.Add(PlanReason.Of(server.UnavailableCode ?? "transcoding_unavailable", "The server cannot remux or transcode right now.",
                    ("code", server.UnavailableCode)));
            }
        }
        if (step.Method == DeliveryMode.Transcode && !allowTranscoding)
            reasons.Add(PlanReason.Of("transcoding_not_allowed", "Full transcodes are not allowed for this profile."));
        if (step.Method != DeliveryMode.Transcode && media.Video is { } video && step.Engine.VideoFor(video.Codec) is { } caps
            && (video.Width > (caps.MaxWidth ?? int.MaxValue) || video.Height > (caps.MaxHeight ?? int.MaxValue)))
        {
            reasons.Add(PlanReason.Of("video_size_unsupported",
                $"{video.Width}×{video.Height} {video.Codec} exceeds what the {step.Engine.Name} engine decodes.",
                ("codec", video.Codec), ("width", video.Width), ("height", video.Height), ("maxWidth", caps.MaxWidth), ("maxHeight", caps.MaxHeight)));
        }
        if (step.Method == DeliveryMode.Direct && tracks.Audio is { } audio && step.Engine.AudioFor(audio.Codec) is { Passthrough: false, MaxChannels: { } max }
            && audio.Channels > max)
        {
            reasons.Add(PlanReason.Of("audio_channels_unsupported", $"{audio.Channels}-channel {audio.Codec} exceeds the engine's {max} channels.",
                ("codec", audio.Codec), ("channels", audio.Channels), ("max", max)));
        }
        return reasons;
    }

    private static PlaybackFailure Failure(IReadOnlyList<SkippedCandidate> skipped, DeviceCaps device, EnginePreference preference)
    {
        var codes = skipped.SelectMany(s => s.Reasons).Select(r => r.Code).ToHashSet(StringComparer.Ordinal);
        var suggestions = new List<string> { SuggestedActions.OtherVersion };
        if (device.Vlc is not null && preference == EnginePreference.Native)
            suggestions.Add(SuggestedActions.UseVlc);
        if (codes.Contains("step_down"))
            return new PlaybackFailure("no_more_methods", "Every playback method left for this device has failed on it.", null, suggestions);
        if (codes.Contains("transcoding_not_allowed"))
        {
            return new PlaybackFailure("transcoding_not_allowed",
                "This version needs a full transcode on this device, and transcoding is not allowed for this profile.", null, suggestions);
        }
        if (codes.Contains("transcoding_disabled") || codes.Contains("ffmpeg_unavailable"))
        {
            var code = codes.Contains("transcoding_disabled") ? "transcoding_disabled" : "ffmpeg_unavailable";
            return new PlaybackFailure("transcoding_unavailable",
                "This version needs a server remux or transcode on this device, and the server cannot run one.",
                TrackSelector.Params(("reason", code)), suggestions);
        }
        return new PlaybackFailure("no_playable_method", "No playback method of this device can play this version.", null, suggestions);
    }

    private static int? OutputMaxHeight(EngineCaps engine, TranscodingSettings settings)
    {
        var codec = settings.AllowHevcOutput && engine.VideoFor("hevc") is not null ? "hevc" : "h264";
        return engine.VideoFor(codec)?.MaxHeight;
    }

    private static int? Min(int? a, int? b) => a is null ? b : b is null ? a : Math.Min(a.Value, b.Value);
}
