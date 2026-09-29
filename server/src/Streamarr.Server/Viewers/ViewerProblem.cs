using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Streamarr.Server.Contracts;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Viewers;

/// <summary>A domain failure of the viewer module that maps 1:1 onto the shared error envelope.</summary>
public sealed class ViewerProblem(int status, string code, string message, IReadOnlyDictionary<string, string>? parameters = null) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;
    public IReadOnlyDictionary<string, string>? Parameters { get; } = parameters;

    public static ViewerProblem BadRequest(string code, string message) => new(StatusCodes.Status400BadRequest, code, message);
    public static ViewerProblem NotFound(string code, string message) => new(StatusCodes.Status404NotFound, code, message);
    public static ViewerProblem Conflict(string code, string message) => new(StatusCodes.Status409Conflict, code, message);
    public static ViewerProblem Unauthorized(string code, string message) => new(StatusCodes.Status401Unauthorized, code, message);
    public static ViewerProblem Forbidden(string code, string message) => new(StatusCodes.Status403Forbidden, code, message);

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
            Error = new ErrorDetail { Code = problem.Code, Message = problem.Message, Params = problem.Parameters },
        })
        { StatusCode = problem.Status };
        if (problem.Status == StatusCodes.Status429TooManyRequests || problem.Status == StatusCodes.Status503ServiceUnavailable)
            context.HttpContext.Response.Headers.RetryAfter = "1";
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
