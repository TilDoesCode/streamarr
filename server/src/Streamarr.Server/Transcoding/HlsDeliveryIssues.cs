using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Streamarr.Server.Contracts;

namespace Streamarr.Server.Transcoding;

public enum HlsDeliveryKind
{
    Segment,
    AudioRendition,
    SubtitleRendition,
}

/// <summary>A request of an HLS session that the server answered with an error (or broke off).</summary>
public sealed record HlsDeliveryIssue(HlsDeliveryKind Kind, string? RenditionId, int? SubtitleStreamIndex, string Code, int Status, DateTimeOffset At);

/// <summary>Receives delivery issues per HLS session id (e.g. the viewer playback that owns the session).</summary>
public interface IHlsDeliveryIssueSink
{
    void Report(string sessionId, HlsDeliveryIssue issue);
}

/// <summary>The one hook for failed answers on <c>/api/v1/transcode/{session}/…</c>; anything that answers there reports here.</summary>
public sealed class HlsDeliveryIssues(IEnumerable<IHlsDeliveryIssueSink> sinks, TimeProvider time)
{
    private const string Prefix = "/api/v1/transcode/";
    private readonly IHlsDeliveryIssueSink[] _sinks = sinks.ToArray();

    /// <summary>For tests: every reported issue with its session id.</summary>
    internal event Action<string, HlsDeliveryIssue>? Observed;

    /// <summary>Reports an error answer for a transcode path; other paths and non-error statuses are ignored.</summary>
    public void Report(PathString path, int status, string code)
    {
        if (status < 400 || Classify(path.Value) is not { } target)
            return;
        var issue = new HlsDeliveryIssue(target.Kind, target.RenditionId, target.SubtitleStreamIndex, Bounded(code), status, time.GetUtcNow());
        Observed?.Invoke(target.SessionId, issue);
        foreach (var sink in _sinks)
            sink.Report(target.SessionId, issue);
    }

    internal sealed record Target(string SessionId, HlsDeliveryKind Kind, string? RenditionId, int? SubtitleStreamIndex);

    /// <summary>Session id and kind of a transcode path: <c>audio/{id}/…</c>, <c>subtitles/{index}/…</c>, else the main stream.</summary>
    internal static Target? Classify(string? path)
    {
        if (path is null || !path.StartsWith(Prefix, StringComparison.OrdinalIgnoreCase))
            return null;
        var parts = path[Prefix.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 2 || parts[0].Length > 128)
            return null;
        return parts switch
        {
            [var id, "audio", var rendition, _] when rendition.Length <= 64 => new Target(id, HlsDeliveryKind.AudioRendition, rendition, null),
            [var id, "subtitles", var stream, _] when int.TryParse(stream, out var index) && index >= 0 => new Target(id, HlsDeliveryKind.SubtitleRendition, null, index),
            [var id, _] => new Target(id, HlsDeliveryKind.Segment, null, null),
            _ => null,
        };
    }

    private static string Bounded(string code) => string.IsNullOrEmpty(code) ? "unknown" : code.Length <= 64 ? code : code[..64];
}

/// <summary>Reports every error result of the transcode stream controller to <see cref="HlsDeliveryIssues"/>.</summary>
public sealed class HlsDeliveryIssueFilter(HlsDeliveryIssues issues) : IResultFilter
{
    public void OnResultExecuting(ResultExecutingContext context)
    {
        if (context.Result is ObjectResult { StatusCode: >= 400 and var status, Value: ErrorResponse error })
            issues.Report(context.HttpContext.Request.Path, status, error.Error.Code);
    }

    public void OnResultExecuted(ResultExecutedContext context)
    {
    }
}
