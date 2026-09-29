using OtpNet;
using Streamarr.Server.Viewers.Email;

namespace Streamarr.DevWorld;

public sealed class DevWorldState
{
    private volatile string? _manifestJson;

    public bool Ready => _manifestJson is not null;
    public string? ManifestJson => _manifestJson;
    public Dictionary<string, string> TotpSecrets { get; } = new(StringComparer.OrdinalIgnoreCase);

    public void MarkReady(string manifestJson) => _manifestJson = manifestJson;
}

/// <summary>Harness-only HTTP additions: permissive CORS for viewer/media paths and dev helper endpoints.</summary>
public static class DevWorldHttp
{
    private static readonly string[] CorsPrefixes =
        ["/api/v1/viewer", "/api/v1/stream", "/api/v1/transcode", "/api/v1/health", "/devworld", "/devworld.json", "/openapi"];

    /// <summary>Must run before the Core pipeline so preflights never reach authentication.</summary>
    public static void UseDevWorldCors(this WebApplication app)
    {
        app.Use(async (context, next) =>
        {
            var path = context.Request.Path;
            if (context.Request.Headers.Origin.Count > 0
                && CorsPrefixes.Any(prefix => path.StartsWithSegments(prefix, StringComparison.OrdinalIgnoreCase)))
            {
                var headers = context.Response.Headers;
                headers.AccessControlAllowOrigin = "*";
                headers.AccessControlExposeHeaders = "Content-Length, Content-Range, Accept-Ranges, Content-Type, Retry-After, ETag";
                if (HttpMethods.IsOptions(context.Request.Method) && context.Request.Headers.AccessControlRequestMethod.Count > 0)
                {
                    headers.AccessControlAllowMethods = "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS";
                    headers.AccessControlAllowHeaders = context.Request.Headers.AccessControlRequestHeaders.Count > 0
                        ? context.Request.Headers.AccessControlRequestHeaders.ToString()
                        : "Authorization, Content-Type, Range";
                    headers.AccessControlMaxAge = "600";
                    context.Response.StatusCode = StatusCodes.Status204NoContent;
                    return;
                }
            }

            await next();
        });
    }

    public static void MapDevWorld(this WebApplication app, DevWorldState state)
    {
        app.MapGet("/devworld/ready", () => state.Ready
                ? Results.Ok(new { ready = true })
                : Results.Json(new { ready = false }, statusCode: StatusCodes.Status503ServiceUnavailable))
            .AllowAnonymous().ExcludeFromDescription();

        app.MapGet("/devworld.json", () => state.ManifestJson is { } json
                ? Results.Text(json, "application/json")
                : Results.Json(new { ready = false }, statusCode: StatusCodes.Status503ServiceUnavailable))
            .AllowAnonymous().ExcludeFromDescription();

        app.MapGet("/devworld/totp/{username}", (string username) =>
            {
                if (!state.TotpSecrets.TryGetValue(username, out var secret))
                    return Results.NotFound(new { error = "no_totp_viewer" });
                var totp = new Totp(Base32Encoding.ToBytes(secret));
                var now = DateTime.UtcNow;
                return Results.Ok(new
                {
                    username,
                    secret,
                    code = totp.ComputeTotp(now),
                    nextCode = totp.ComputeTotp(now.AddSeconds(30)),
                    secondsRemaining = totp.RemainingSeconds(now),
                    note = "The server rejects a code whose 30 s step was already used; wait for nextCode after a successful sign-in.",
                });
            })
            .AllowAnonymous().ExcludeFromDescription();

        app.MapGet("/devworld/outbox", (ViewerMailOutbox outbox) => Results.Ok(outbox.List().Select(m => new
            {
                m.Id,
                m.CreatedAt,
                m.Message.To,
                m.Message.Subject,
                m.Message.Kind,
                m.Message.Text,
            })))
            .AllowAnonymous().ExcludeFromDescription();
    }
}
