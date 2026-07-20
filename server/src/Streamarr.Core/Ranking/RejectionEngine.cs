using Streamarr.Core.Profiles;

namespace Streamarr.Core.Ranking;

/// <summary>
/// Runs the pre-ranking rejection rules (BRIEF.md §7.2) over a release, returning
/// every reason that fires. An empty result means the release is accepted for
/// ranking. Rules that need post-resolve signals (password / non-media / incomplete /
/// dead) simply return nothing until those signals are present.
/// </summary>
public interface IRejectionEngine
{
    IReadOnlyList<RejectionReason> Evaluate(ReleaseSignals signals, QualityProfile profile);
}

/// <inheritdoc cref="IRejectionEngine"/>
public sealed class RejectionEngine : IRejectionEngine
{
    private readonly IReadOnlyList<IRejectionRule> _rules;

    public RejectionEngine(IEnumerable<IRejectionRule> rules)
    {
        _rules = rules.ToArray();
    }

    /// <summary>Engine wired with the default rule set (BRIEF.md §7.2).</summary>
    public RejectionEngine()
        : this(DefaultRules)
    {
    }

    /// <summary>The default, ordered rejection rule set.</summary>
    public static IReadOnlyList<IRejectionRule> DefaultRules { get; } =
    [
        new SampleRejectionRule(),
        new SizeSanityRejectionRule(),
        new CustomFormatScoreRejectionRule(),
        new PasswordProtectedRejectionRule(),
        new NonMediaPayloadRejectionRule(),
        new IncompleteUploadRejectionRule(),
        new DeadOnUsenetRejectionRule(),
    ];

    public IReadOnlyList<RejectionReason> Evaluate(ReleaseSignals signals, QualityProfile profile)
    {
        ArgumentNullException.ThrowIfNull(signals);
        ArgumentNullException.ThrowIfNull(profile);

        var reasons = new List<RejectionReason>();
        foreach (var rule in _rules)
        {
            if (rule.Evaluate(signals, profile) is { } reason)
            {
                reasons.Add(reason);
            }
        }

        return reasons;
    }
}
