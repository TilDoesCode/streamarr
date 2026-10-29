using Streamarr.Server.Transcoding;

namespace Streamarr.Server.Viewers.Playback;

/// <summary>User preferences of one playback (validated).</summary>
public sealed record PlaybackPreferences(
    EnginePreference Engine,
    int? MaxHeight,
    int? MaxBitrateKbps,
    string? AudioLanguage,
    string? SubtitleLanguage,
    SubtitleMode SubtitleMode,
    bool ForceEngine = false)
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
        // A new engine choice without forceEngine is a preference again; auto has nothing to force.
        var force = (dto.ForceEngine ?? (dto.Engine is null && current.ForceEngine)) && engine != EnginePreference.Auto;
        return new PlaybackPreferences(
            engine,
            dto.MaxHeight ?? current.MaxHeight,
            dto.MaxBitrateKbps ?? current.MaxBitrateKbps,
            dto.AudioLanguage is null ? current.AudioLanguage : Language(dto.AudioLanguage, "audioLanguage"),
            dto.SubtitleLanguage is null ? current.SubtitleLanguage : Language(dto.SubtitleLanguage, "subtitleLanguage"),
            mode,
            force);
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

    /// <summary>HLS audio renditions to offer: the selected track, then the preferred language, the source default and other languages (one track per language), at most <see cref="TranscodePlanner.MaxAudioRenditions"/>.</summary>
    public static IReadOnlyList<int> OfferedAudio(SourceMediaInfo media, SourceAudioStream? selected, PlaybackPreferences preferences)
    {
        if (selected is null || media.Audio.Count < 2)
            return [];
        var ordered = media.Audio
            .OrderBy(a => a.Index == selected.Index ? 0 : preferences.AudioLanguage is { } l && Lang(a.Language) == l ? 1 : a.IsDefault ? 2 : 3)
            .ThenBy(a => a.Index);
        var languages = new HashSet<string>(StringComparer.Ordinal);
        var offered = new List<int>();
        foreach (var audio in ordered)
        {
            if (offered.Count == TranscodePlanner.MaxAudioRenditions)
                break;
            if (audio.Index != selected.Index && !languages.Add(Lang(audio.Language) ?? $"#{audio.Index}"))
                continue;
            if (audio.Index == selected.Index)
                languages.Add(Lang(audio.Language) ?? $"#{audio.Index}");
            offered.Add(audio.Index);
        }
        return offered.Count < 2 ? [] : offered;
    }

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

    /// <summary>The range the screen shows: the plan's, or SDR when the engine tone-maps the HDR itself.</summary>
    public HdrFormat DisplayedHdr => Notes.Any(n => n.Code == "hdr_tone_mapped") ? HdrFormat.None : Plan.DisplayedHdr;
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
        IReadOnlySet<string> excluded,
        bool audioFallback = false)
    {
        var tracks = TrackSelector.Select(media, audioIndex, subtitleIndex, preferences);
        var notes = new List<PlanReason>(tracks.Notes);
        if (audioFallback && tracks.Audio is { } converted)
            notes.Add(PlanReason.Of("audio_fallback", $"The audio ({converted.Codec}) is converted to AAC stereo because the device could not output it.", ("codec", converted.Codec)));
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

        var forced = preferences.ForceEngine && preference != EnginePreference.Auto;
        var steps = forced ? Steps(device, preference, tracks.Subtitle) : AllSteps(device, preference, tracks.Subtitle);
        var viable = new List<PlaybackCandidate>();
        var skipped = new List<SkippedCandidate>();
        foreach (var listed in steps)
        {
            var step = listed with { Engine = listed.Engine.For(media.Video, listed.Method) };
            var reasons = Blockers(step, media, device, allowTranscoding, server, tracks, excluded);
            if (reasons.Count > 0)
            {
                skipped.Add(new SkippedCandidate(step.Method, step.Engine.Name, reasons));
                continue;
            }
            var client = step.Engine.ClientFor(media.Video) with { AudioFallback = audioFallback };
            var limits = new TranscodeLimits(
                step.Method == DeliveryMode.Transcode ? Min(preferences.MaxHeight, OutputMaxHeight(step.Engine, server.Settings)) : preferences.MaxHeight,
                maxBitrate,
                tracks.Audio?.Index,
                step.WithSubtitle ? tracks.Subtitle?.Index : null,
                step.BurnIn,
                step.Method == DeliveryMode.Direct || audioFallback ? null : TrackSelector.OfferedAudio(media, tracks.Audio, preferences));
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
            if (step.Method == DeliveryMode.Transcode && media.Video is { } source && SizeLimit(source, preferences, step.Engine, server.Settings) is { } limited)
                candidateNotes.Add(limited);
            if (step.Method == DeliveryMode.Transcode && preference == EnginePreference.Vlc && step.Engine.Name != EngineCaps.Vlc)
                candidateNotes.Add(PlanReason.Of("transcode_native_engine", "VLC plays original files; the server transcode plays in the device's own player."));
            if (media.Video is { Hdr: not HdrFormat.None } hdrVideo && step.Engine.ToneMapsHdr
                && step.Engine.VideoFor(hdrVideo.Codec) is { } hdrCaps && !hdrCaps.HdrFormats.Contains(hdrVideo.Hdr.ToApi(), StringComparer.Ordinal)
                && step.Engine.HdrFormatsFor(hdrCaps).Contains(hdrVideo.Hdr.ToApi(), StringComparer.Ordinal) && step.Method != DeliveryMode.Transcode)
            {
                candidateNotes.Add(PlanReason.Of("hdr_tone_mapped", $"The {step.Engine.Name} engine tone-maps the {hdrVideo.Hdr.ToApi()} video to the display itself.",
                    ("hdr", hdrVideo.Hdr.ToApi()), ("engine", step.Engine.Name)));
            }
            if (!step.WithSubtitle && tracks.Subtitle is { } dropped)
            {
                candidateNotes.Add(PlanReason.Of("subtitle_not_deliverable",
                    $"Subtitle stream {dropped.Index} ({dropped.Codec}) cannot be shown with {step.Method.ToApi()} on the {step.Engine.Name} engine; it plays without it.",
                    ("index", dropped.Index), ("codec", dropped.Codec), ("mode", step.Method.ToApi())));
            }
            viable.Add(new PlaybackCandidate(step.Method, step.Engine, client, limits, plan, candidateNotes));
        }

        if (!forced)
            viable = Rank(viable, media, tracks, preference);
        var failure = viable.Count > 0 ? null : Failure(skipped, device, forced ? preference : EnginePreference.Auto, excluded);
        return new PlaybackDecision(viable.DistinctBy(c => c.Key).ToList(), skipped, tracks, notes, failure);
    }

    /// <summary>
    /// Every way the device plays without a server transcode (native direct and remux, VLC direct), with and without an image subtitle the
    /// native engine cannot render, then the transcodes in PLAN §2 order; <see cref="Rank"/> orders them by delivered quality.
    /// </summary>
    private static List<Step> AllSteps(DeviceCaps device, EnginePreference preference, SourceSubtitleStream? subtitle)
    {
        var native = device.Native;
        var vlc = device.Vlc;
        var steps = new List<Step>();
        void Playable(bool withSubtitle)
        {
            if (native is not null)
            {
                steps.Add(new Step(DeliveryMode.Direct, native, withSubtitle, false));
                steps.Add(new Step(DeliveryMode.Remux, native, withSubtitle, false));
            }
            if (vlc is not null)
                steps.Add(new Step(DeliveryMode.Direct, vlc, withSubtitle, false));
        }
        void Transcodes(bool withSubtitle)
        {
            if (preference == EnginePreference.Vlc && native is not null && vlc is not null)
            {
                steps.Add(new Step(DeliveryMode.Transcode, native, withSubtitle, false));
                steps.Add(new Step(DeliveryMode.Transcode, vlc, withSubtitle, false));
                return;
            }
            steps.Add(new Step(DeliveryMode.Transcode, native ?? vlc!, withSubtitle, false));
        }

        var image = subtitle is { TextBased: false } ? subtitle : null;
        if (image is null || (native ?? vlc)!.RendersSubtitle(image.Codec))
        {
            Playable(withSubtitle: true);
            Transcodes(withSubtitle: true);
            return steps;
        }
        if (vlc is not null && vlc.RendersSubtitle(image.Codec))
            steps.Add(new Step(DeliveryMode.Direct, vlc, true, false));
        steps.Add(new Step(DeliveryMode.Transcode, native ?? vlc!, true, true));
        Playable(withSubtitle: false);
        Transcodes(withSubtitle: false);
        return steps;
    }

    /// <summary>
    /// Best delivered quality first: picture (resolution, then HDR kept > base layer > SDR), audio (as is > surround kept > downmix),
    /// the selected subtitle shown; the engine preference only orders equal candidates (auto and native: native direct, native remux,
    /// VLC direct; vlc: VLC first). A transcode only follows them, except the burn-in of a selected image subtitle no engine shows.
    /// </summary>
    internal static List<PlaybackCandidate> Rank(List<PlaybackCandidate> viable, SourceMediaInfo media, TrackSelection tracks, EnginePreference preference)
    {
        var played = viable.Where(c => c.Method != DeliveryMode.Transcode)
            .OrderByDescending(c => Quality(c, media, tracks))
            .ThenBy(c => TieOrder(c, preference))
            .ToList();
        var transcodes = viable.Where(c => c.Method == DeliveryMode.Transcode).ToList();
        var burnIn = tracks.Subtitle is { TextBased: false } && !played.Any(c => ShowsSubtitle(c, tracks))
            ? transcodes.Where(c => c.Limits.BurnInSubtitle).ToList()
            : [];
        var ranked = burnIn.Concat(played).Concat(transcodes.Except(burnIn)).ToList();
        if (ranked.Count > 0 && preference != EnginePreference.Auto && ranked[0].Method != DeliveryMode.Transcode
            && (ranked[0].Engine.Name == EngineCaps.Vlc) != (preference == EnginePreference.Vlc))
        {
            var preferred = preference == EnginePreference.Vlc ? EngineCaps.Vlc : EngineCaps.Native;
            ranked[0] = ranked[0] with
            {
                Notes = [.. ranked[0].Notes, PlanReason.Of("better_engine",
                    $"The {ranked[0].Engine.Name} engine plays this version better than the preferred {preferred} engine.",
                    ("engine", ranked[0].Engine.Name == EngineCaps.Vlc ? EngineCaps.Vlc : EngineCaps.Native), ("preferred", preferred))],
            };
        }
        return ranked;
    }

    /// <summary>Picture, audio and subtitle scores of a candidate, compared in this order.</summary>
    internal static (int Resolution, int Hdr, int Audio, int Subtitle) Quality(PlaybackCandidate candidate, SourceMediaInfo media, TrackSelection tracks)
    {
        var source = media.Video;
        var resolution = source is null || candidate.Plan.Video.Height >= source.Height ? 1 : 0;
        var shown = candidate.DisplayedHdr;
        var hdr = shown == (source?.Hdr ?? HdrFormat.None) ? 2 : shown != HdrFormat.None ? 1 : 0;
        var audio = tracks.Audio is { } selected ? AudioScore(candidate, selected) : 3;
        return (resolution, hdr, audio, ShowsSubtitle(candidate, tracks) ? 1 : 0);
    }

    /// <summary>3: the track plays as it is, 2: its surround is kept (converted, or 7.1 → 5.1), 1: it is downmixed.</summary>
    private static int AudioScore(PlaybackCandidate candidate, SourceAudioStream selected)
    {
        var target = candidate.Plan.Audio;
        var asIs = target is null || target.Copy;
        var codec = asIs ? selected.Codec : target!.Codec;
        var channels = candidate.Engine.DeliveredChannels(codec, asIs ? selected.Channels : target!.Channels);
        if (asIs && channels >= selected.Channels)
            return 3;
        return channels >= Math.Min(selected.Channels, 6) ? 2 : 1;
    }

    private static bool ShowsSubtitle(PlaybackCandidate candidate, TrackSelection tracks)
        => tracks.Subtitle is null || !candidate.Notes.Concat(candidate.Plan.Reasons).Any(r => r.Code == "subtitle_not_deliverable");

    private static int TieOrder(PlaybackCandidate candidate, EnginePreference preference)
    {
        var vlc = candidate.Engine.Name == EngineCaps.Vlc;
        var engine = preference == EnginePreference.Vlc ? vlc ? 0 : 1 : vlc ? 1 : 0;
        return engine * 2 + (candidate.Method == DeliveryMode.Direct ? 0 : 1);
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
                if (native is not null)
                    steps.Add(new Step(DeliveryMode.Transcode, native, withSubtitle, false));
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

    private static PlaybackFailure Failure(IReadOnlyList<SkippedCandidate> skipped, DeviceCaps device, EnginePreference preference, IReadOnlySet<string> excluded)
    {
        var codes = skipped.SelectMany(s => s.Reasons).Select(r => r.Code).ToHashSet(StringComparer.Ordinal);
        var suggestions = new List<string> { SuggestedActions.OtherVersion };
        if (device.Vlc is not null && preference == EnginePreference.Native && !excluded.Contains(Key(DeliveryMode.Direct, EngineCaps.Vlc)))
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

    /// <summary>
    /// Which limit scaled the transcode down (the viewer's maxHeight, the device's decoder or the server's setting) and whether the
    /// height or the width of its 16:9 frame did it (4096×2160 fits 2160p only at 3840 wide); null when the source fits.
    /// </summary>
    private static PlanReason? SizeLimit(SourceVideoStream source, PlaybackPreferences preferences, EngineCaps engine, TranscodingSettings settings)
    {
        var (by, max) = new (string By, int? Max)[]
            {
                ("viewer", preferences.MaxHeight), ("device", OutputMaxHeight(engine, settings)), ("server", settings.MaxHeight),
            }
            .Where(l => l.Max is not null)
            .Select(l => (l.By, Max: l.Max!.Value))
            .MinBy(l => l.Max);
        var maxWidth = TranscodePlanner.BoxWidth(max);
        if (source.Height <= max && source.Width <= maxWidth)
            return null;
        if ((double)max / source.Height <= (double)maxWidth / source.Width)
        {
            return PlanReason.Of("transcode_height_limited", $"The transcode is scaled from {source.Height}p to {max}p by the {by} limit.",
                ("height", source.Height), ("max", max), ("by", by));
        }
        return PlanReason.Of("transcode_width_limited",
            $"The transcode is scaled from {source.Width} to {maxWidth} pixels wide to fit the {by} limit of {max}p ({maxWidth}×{max}).",
            ("width", source.Width), ("max", maxWidth), ("height", max), ("by", by));
    }

    private static int? OutputMaxHeight(EngineCaps engine, TranscodingSettings settings)
    {
        var codec = settings.AllowHevcOutput && engine.VideoFor("hevc") is not null ? "hevc" : "h264";
        return engine.VideoFor(codec)?.MaxHeight;
    }

    private static int? Min(int? a, int? b) => a is null ? b : b is null ? a : Math.Min(a.Value, b.Value);
}
