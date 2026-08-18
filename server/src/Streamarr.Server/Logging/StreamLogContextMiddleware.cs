using Streamarr.Server.Services;

namespace Streamarr.Server.Logging;

/// <summary>
/// Adds stable stream metadata to every event emitted while a capability-scoped API
/// request is executing. The raw capability is never added to a logging scope.
/// </summary>
internal sealed class StreamLogContextMiddleware(
    RequestDelegate next,
    ILogger<StreamLogContextMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context, SessionManager sessions)
    {
        if (!TryGetRouteToken(context, out var token)
            || !sessions.TryGetSession(token, out var session))
        {
            await next(context);
            return;
        }

        var properties = new Dictionary<string, object>(StringComparer.Ordinal)
        {
            [LogPropertyNames.ReleaseId] = session.Session.ReleaseId,
            [LogPropertyNames.WorkId] = session.Session.WorkId,
            [LogPropertyNames.StreamTokenFingerprint] = LogSanitizer.FingerprintToken(token),
        };
        if (!string.IsNullOrWhiteSpace(session.StreamAttemptId))
            properties[LogPropertyNames.StreamAttemptId] = session.StreamAttemptId!;

        foreach (var property in properties)
            context.Items[property.Key] = property.Value;

        using (logger.BeginScope(properties))
        {
            try
            {
                await next(context);
            }
            catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
            {
                logger.LogDebug(
                    "Stream-related {RequestMethod} request was cancelled by the client",
                    context.Request.Method);
                throw;
            }
            catch (Exception exception)
            {
                logger.LogError(
                    exception,
                    "Stream-related {RequestMethod} {RequestPath} failed ({FailureType})",
                    context.Request.Method,
                    StreamarrServerBootstrap.RedactRequestPath(context.Request.Path),
                    exception.GetType().Name);
                throw;
            }
        }
    }

    private static bool TryGetRouteToken(HttpContext context, out string token)
    {
        token = string.Empty;
        if (context.Request.RouteValues.TryGetValue("token", out var value)
            && value is not null)
        {
            token = Convert.ToString(value) ?? string.Empty;
        }

        if (string.IsNullOrWhiteSpace(token))
            return false;

        var path = context.Request.Path;
        return path.StartsWithSegments("/api/v1/stream", StringComparison.OrdinalIgnoreCase)
               || path.StartsWithSegments("/api/v1/sessions", StringComparison.OrdinalIgnoreCase)
               || path.StartsWithSegments("/api/v1/ephemeral-files", StringComparison.OrdinalIgnoreCase)
               || path.StartsWithSegments("/api/v1/streams", StringComparison.OrdinalIgnoreCase);
    }
}
