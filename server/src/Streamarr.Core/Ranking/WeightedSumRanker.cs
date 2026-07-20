using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// Produces the integer score + per-rule breakdown for a release (BRIEF.md §7.3).
/// The interface is deliberately narrow so a Radarr-style custom-format ranker can be
/// dropped in later without touching the API — it need only emit a
/// <see cref="ReleaseScore"/>.
/// </summary>
public interface IReleaseRanker
{
    ReleaseScore Score(ReleaseSignals signals, QualityProfile profile);
}

/// <summary>
/// The v1 ranker: a transparent weighted sum over resolution, source, codec, language,
/// audio tier, size band, PROPER/REPACK, recency, grabs and group allow/deny lists.
/// Every term appears as its own <see cref="ScoreLine"/> so the breakdown fully
/// explains the total.
/// </summary>
public sealed class WeightedSumRanker : IReleaseRanker
{
    public ReleaseScore Score(ReleaseSignals signals, QualityProfile profile)
    {
        ArgumentNullException.ThrowIfNull(signals);
        ArgumentNullException.ThrowIfNull(profile);

        var lines = new List<ScoreLine>();

        Add(lines, "resolution", PreferenceScore(profile.PreferredResolutions, signals.Resolution, profile.ResolutionWeight));
        Add(lines, "source", PreferenceScore(profile.PreferredSources, signals.Source, profile.SourceWeight));
        Add(lines, "codec", PreferenceScore(profile.PreferredCodecs, signals.VideoCodec, profile.CodecWeight));
        Add(lines, "language", LanguageScore(profile, signals));
        Add(lines, "audio", TierScore(QualityDefinitions.AudioTier(signals.AudioCodec), QualityDefinitions.MaxAudioTier, profile.AudioWeight));
        Add(lines, "size", SizeScore(profile, signals));
        Add(lines, "proper-repack", (signals.Proper || signals.Repack) ? profile.ProperRepackBonus : 0);
        Add(lines, "recency", RecencyScore(profile, signals));
        Add(lines, "grabs", GrabsScore(profile, signals));
        Add(lines, "group-allow", GroupAllowScore(profile, signals));
        Add(lines, "group-deny", GroupDenyScore(profile, signals));
        foreach (var format in CustomFormatMatcher.MatchingFormats(signals, profile))
        {
            Add(lines, $"custom-format:{format.Name}", format.Score);
        }

        var total = lines.Sum(l => l.Points);
        return new ReleaseScore(total, lines);
    }

    private static void Add(List<ScoreLine> lines, string rule, int points)
    {
        if (points != 0)
        {
            lines.Add(new ScoreLine(rule, points));
        }
    }

    /// <summary>
    /// Points for a value's position in a best-first preference list: full weight for
    /// the top choice, decaying linearly to a small positive share for the last.
    /// Values not in the list score 0.
    /// </summary>
    private static int PreferenceScore(IReadOnlyList<string> preferences, string? value, int weight)
    {
        if (value is null || preferences.Count == 0)
        {
            return 0;
        }

        var index = IndexOf(preferences, value);
        if (index < 0)
        {
            return 0;
        }

        // rank 0 → weight; last rank → weight/count. Keeps every listed option above 0.
        return (int)Math.Round((double)weight * (preferences.Count - index) / preferences.Count);
    }

    private static int LanguageScore(QualityProfile profile, ReleaseSignals signals)
    {
        if (profile.PreferredLanguages.Count == 0 || signals.Languages.Count == 0)
        {
            return 0;
        }

        // Score by the best-ranked preferred language the release actually carries.
        var best = -1;
        foreach (var lang in signals.Languages)
        {
            var index = IndexOf(profile.PreferredLanguages, lang);
            if (index >= 0 && (best < 0 || index < best))
            {
                best = index;
            }
        }

        if (best < 0)
        {
            return 0;
        }

        var count = profile.PreferredLanguages.Count;
        return (int)Math.Round((double)profile.LanguageWeight * (count - best) / count);
    }

    private static int TierScore(int tier, int maxTier, int weight)
    {
        if (tier <= 0 || maxTier <= 0)
        {
            return 0;
        }

        return (int)Math.Round((double)weight * tier / maxTier);
    }

    /// <summary>
    /// Rewards higher bitrate within the sane band (fuller-quality encodes score
    /// higher), scaled to <see cref="QualityProfile.SizeWeight"/>. Needs runtime.
    /// </summary>
    private static int SizeScore(QualityProfile profile, ReleaseSignals signals)
    {
        if (signals.RuntimeMinutes is not { } runtime || runtime <= 0 || signals.SizeBytes <= 0 || profile.SizeWeight == 0)
        {
            return 0;
        }

        var band = profile.BandFor(signals.Resolution);
        if (band.MaxBytesPerMinute <= band.MinBytesPerMinute)
        {
            return 0;
        }

        var bytesPerMinute = (double)signals.SizeBytes / runtime;
        var fraction = (bytesPerMinute - band.MinBytesPerMinute) / (band.MaxBytesPerMinute - band.MinBytesPerMinute);
        fraction = Math.Clamp(fraction, 0, 1);
        return (int)Math.Round(profile.SizeWeight * fraction);
    }

    private static int RecencyScore(QualityProfile profile, ReleaseSignals signals)
    {
        if (profile.RecencyBonus == 0)
        {
            return 0;
        }

        // Linear decay from full bonus at age 0 to 0 at one year old.
        const double horizonDays = 365.0;
        var fraction = Math.Clamp(1 - signals.AgeDays / horizonDays, 0, 1);
        return (int)Math.Round(profile.RecencyBonus * fraction);
    }

    private static int GrabsScore(QualityProfile profile, ReleaseSignals signals)
    {
        if (profile.GrabsBonus == 0 || signals.Grabs <= 0)
        {
            return 0;
        }

        // Log scale: ~1000 grabs earns the full bonus, diminishing returns below.
        var fraction = Math.Clamp(Math.Log10(signals.Grabs + 1) / 3.0, 0, 1);
        return (int)Math.Round(profile.GrabsBonus * fraction);
    }

    private static int GroupAllowScore(QualityProfile profile, ReleaseSignals signals)
        => signals.ReleaseGroup is { } group && IndexOf(profile.GroupAllowList, group) >= 0
            ? profile.GroupAllowBonus
            : 0;

    private static int GroupDenyScore(QualityProfile profile, ReleaseSignals signals)
        => signals.ReleaseGroup is { } group && IndexOf(profile.GroupDenyList, group) >= 0
            ? -profile.GroupDenyPenalty
            : 0;

    private static int IndexOf(IReadOnlyList<string> list, string value)
    {
        for (var i = 0; i < list.Count; i++)
        {
            if (string.Equals(list[i], value, StringComparison.OrdinalIgnoreCase))
            {
                return i;
            }
        }

        return -1;
    }
}
