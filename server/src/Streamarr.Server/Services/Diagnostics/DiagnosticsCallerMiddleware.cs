using Microsoft.AspNetCore.Authentication;
using Streamarr.Server.Auth;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>Authenticates diagnostics requests before the rate limiter so its windows are per signed-in user, not per IP.</summary>
public sealed class DiagnosticsCallerMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        var scheme = path.StartsWithSegments("/api/v1/viewer/diagnostics", StringComparison.OrdinalIgnoreCase) ? ViewerAuth.Scheme
            : path.StartsWithSegments("/api/v1/diagnostics", StringComparison.OrdinalIgnoreCase) ? AuthRoles.Scheme
            : null;
        if (scheme is not null)
        {
            var result = await context.AuthenticateAsync(scheme);
            if (result.Succeeded)
                context.User = result.Principal;
        }
        await next(context);
    }
}
