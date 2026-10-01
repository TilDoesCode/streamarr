using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Streamarr.Server.Contracts;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Viewers;

/// <summary>A domain failure of the viewer module that maps 1:1 onto the shared error envelope.</summary>
public sealed class ViewerProblem(int status, string code, string message, IReadOnlyDictionary<string, string>? parameters = null) : Exception(message)
{
    /// <summary>Seconds a 429/503 caller should wait (Retry-After and <c>retryAfterSeconds</c>); null = 1.</summary>
    public int? RetryAfterSeconds { get; private init; }

    public int Status { get; } = status;
    public string Code { get; } = code;
    public IReadOnlyDictionary<string, string>? Parameters { get; } = parameters;

    public static ViewerProblem BadRequest(string code, string message) => new(StatusCodes.Status400BadRequest, code, message);
    public static ViewerProblem NotFound(string code, string message) => new(StatusCodes.Status404NotFound, code, message);
    public static ViewerProblem Conflict(string code, string message) => new(StatusCodes.Status409Conflict, code, message);
    public static ViewerProblem Unauthorized(string code, string message) => new(StatusCodes.Status401Unauthorized, code, message);
    public static ViewerProblem Forbidden(string code, string message) => new(StatusCodes.Status403Forbidden, code, message);

    /// <summary><c>429 email_code_cooldown</c>: a code was sent moments ago (or the hourly cap is reached); no new mail was sent.</summary>
    public static ViewerProblem EmailCodeCooldown(TimeSpan wait)
    {
        var seconds = Math.Max(1, (int)Math.Ceiling(wait.TotalSeconds));
        return new(StatusCodes.Status429TooManyRequests, "email_code_cooldown",
            $"A code was sent moments ago; request a new one in {seconds} seconds.",
            new Dictionary<string, string> { ["retryAfterSeconds"] = seconds.ToString(System.Globalization.CultureInfo.InvariantCulture) })
        { RetryAfterSeconds = seconds };
    }

    /// <summary><c>503 catalog_unavailable</c>: TMDB cannot be reached right now and nothing is cached; the client retries.</summary>
    public static ViewerProblem CatalogUnavailable()
        => new(StatusCodes.Status503ServiceUnavailable, "catalog_unavailable", "TMDB is temporarily unavailable; retry shortly.");
}

/// <summary>Turns <see cref="ViewerProblem"/> into the typed error response.</summary>
public sealed class ViewerProblemFilterAttribute : ExceptionFilterAttribute
{
    public override void OnException(ExceptionContext context)
    {
        if (context.Exception is not ViewerProblem problem)
            return;
        context.Result = new ObjectResult(new ErrorResponse
        {
            Error = new ErrorDetail
            {
                Code = problem.Code,
                Message = problem.Message,
                Params = problem.Parameters,
                RetryAfterSeconds = problem.RetryAfterSeconds,
            },
        })
        { StatusCode = problem.Status };
        if (problem.Status == StatusCodes.Status429TooManyRequests || problem.Status == StatusCodes.Status503ServiceUnavailable)
            context.HttpContext.Response.Headers.RetryAfter = (problem.RetryAfterSeconds ?? 1).ToString(System.Globalization.CultureInfo.InvariantCulture);
        context.ExceptionHandled = true;
    }
}

/// <summary>Answers malformed route or query values with the standard envelope (<c>400 invalid_request</c>) instead of ProblemDetails.</summary>
public sealed class ViewerModelStateFilterAttribute : ActionFilterAttribute
{
    public ViewerModelStateFilterAttribute() => Order = -3000;

    public override void OnActionExecuting(ActionExecutingContext context)
    {
        if (context.ModelState.IsValid)
            return;
        var fields = string.Join(", ", context.ModelState.Where(e => e.Value?.Errors.Count > 0).Select(e => e.Key).Take(8));
        context.Result = new ObjectResult(ErrorResponse.Of("invalid_request", $"Malformed value for: {fields}."))
        { StatusCode = StatusCodes.Status400BadRequest };
    }
}

/// <summary>Lets an action run while the signed-in viewer still has to replace an admin-assigned password.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class AllowPendingPasswordChangeAttribute : Attribute;

/// <summary>Blocks viewer endpoints until an admin-assigned password has been changed.</summary>
public sealed class ViewerPasswordChangeFilterAttribute : ActionFilterAttribute
{
    public override void OnActionExecuting(ActionExecutingContext context)
    {
        if (context.HttpContext.User.HasClaim(ViewerAuth.PasswordChangeClaim, "true") &&
            !context.ActionDescriptor.EndpointMetadata.OfType<AllowPendingPasswordChangeAttribute>().Any())
        {
            context.Result = new ObjectResult(ErrorResponse.Of(
                "password_change_required",
                "This account must change its password before it can continue."))
            { StatusCode = StatusCodes.Status403Forbidden };
        }
    }
}

public static class ViewerClaims
{
    public static string ViewerId(this ClaimsPrincipal user)
        => user.FindFirstValue(ClaimTypes.NameIdentifier) ?? throw ViewerProblem.Unauthorized("unauthorized", "No viewer session.");

    public static string SessionId(this ClaimsPrincipal user)
        => user.FindFirstValue(ViewerAuth.SessionIdClaim) ?? throw ViewerProblem.Unauthorized("unauthorized", "No viewer session.");
}
