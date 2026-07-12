namespace Streamarr.Core.Ranking;

/// <summary>
/// Machine-readable rejection reason codes (BRIEF.md §7.2). Stable across the API —
/// <c>/debug/search</c> and the Management UI key off these, so do not renumber or
/// rename without a versioning story.
/// </summary>
public enum RejectionCode
{
    /// <summary>Sample clip — name marker or size implausibly small for the runtime.</summary>
    Sample,

    /// <summary>Fake / mislabelled — bytes-per-minute below the sane band for the quality.</summary>
    SizeTooSmall,

    /// <summary>Fake / mislabelled — bytes-per-minute above the sane band for the quality.</summary>
    SizeTooLarge,

    /// <summary>Password-protected archive with no known password.</summary>
    PasswordProtected,

    /// <summary>NZB payload is not media (executables, no video/archive files present).</summary>
    NonMediaPayload,

    /// <summary>Incomplete upload — missing files vs expected, or too few segments.</summary>
    IncompleteUpload,

    /// <summary>Dead on Usenet — articles missing per the health check.</summary>
    DeadOnUsenet,
}

/// <summary>
/// A single rejection: a stable machine-readable <see cref="Code"/> plus a
/// human-readable <see cref="Message"/> (BRIEF.md §7.2). Both are surfaced by
/// <c>/debug/search</c> and the Management UI.
/// </summary>
public sealed record RejectionReason(RejectionCode Code, string Message)
{
    /// <summary>Stable kebab-case slug of the code for API/JSON consumers.</summary>
    public string CodeSlug => Code switch
    {
        RejectionCode.Sample => "sample",
        RejectionCode.SizeTooSmall => "size-too-small",
        RejectionCode.SizeTooLarge => "size-too-large",
        RejectionCode.PasswordProtected => "password-protected",
        RejectionCode.NonMediaPayload => "non-media-payload",
        RejectionCode.IncompleteUpload => "incomplete-upload",
        RejectionCode.DeadOnUsenet => "dead-on-usenet",
        _ => Code.ToString().ToLowerInvariant(),
    };

    public override string ToString() => $"{CodeSlug}: {Message}";
}
