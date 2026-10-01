using System.Collections.Concurrent;

namespace Streamarr.Server.Viewers;

/// <summary>Background-work failures: the first one per cause (exception type + HTTP status) at Warning, repeats at Debug.</summary>
public sealed class FailureLog(ILogger logger)
{
    private readonly ConcurrentDictionary<string, byte> _seen = new(StringComparer.Ordinal);

    public static string Cause(Exception e)
        => e is HttpRequestException { StatusCode: { } status } ? $"{e.GetType().Name}:{(int)status}"
            : e is ViewerProblem problem ? $"{nameof(ViewerProblem)}:{problem.Code}"
            : e.GetType().Name;

    /// <summary>True when this was the first failure of its cause (logged at Warning).</summary>
    public bool Log(Exception e, string message, params object?[] args)
    {
        var first = _seen.TryAdd(Cause(e), 0);
#pragma warning disable CA2254
        logger.Log(first ? LogLevel.Warning : LogLevel.Debug, e, message + (first ? " (first failure of this kind; repeats are logged at Debug)" : string.Empty), args);
#pragma warning restore CA2254
        return first;
    }
}
