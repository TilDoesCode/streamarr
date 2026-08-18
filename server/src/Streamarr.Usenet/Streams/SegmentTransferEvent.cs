namespace Streamarr.Usenet.Streams;

public enum SegmentTransferStage
{
    Queued,
    Downloading,
    Cached,
    Downloaded,
    Partial,
    Failed,
}

public sealed record SegmentTransferEvent
{
    public required string SegmentId { get; init; }
    public required SegmentTransferStage Stage { get; init; }
    public long Bytes { get; init; }
    public double? DurationMs { get; init; }
    public string? ErrorType { get; init; }
    public string? ErrorMessage { get; init; }
}
