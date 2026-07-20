using Streamarr.Core.Profiles;

namespace Streamarr.Server.Contracts;

public sealed record ProfileImportPreviewRequest
{
    public required string Source { get; init; }
    public required string BaseUrl { get; init; }
    public required string ApiKey { get; init; }
}

public sealed record ProfileImportCandidate
{
    public int ExternalId { get; init; }
    public required string Name { get; init; }
    public required string SuggestedAppliesTo { get; init; }
    public int QualityCount { get; init; }
    public int ScoredFormatCount { get; init; }
    public int SupportedConditionCount { get; init; }
    public int UnsupportedConditionCount { get; init; }
    public required QualityProfile Profile { get; init; }
}

public sealed record ProfileImportPreviewResponse
{
    public required string Source { get; init; }
    public required string InstanceName { get; init; }
    public string? Version { get; init; }
    public required IReadOnlyList<ProfileImportCandidate> Profiles { get; init; }
}

public sealed record ProfileImportSelection
{
    public int ExternalId { get; init; }
    public required string AppliesTo { get; init; }
}

public sealed record ProfileImportRequest
{
    public required string Source { get; init; }
    public required string BaseUrl { get; init; }
    public required string ApiKey { get; init; }
    public required IReadOnlyList<ProfileImportSelection> Profiles { get; init; }
}
