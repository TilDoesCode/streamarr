using System.Security.Claims;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;
using Streamarr.Server.Contracts;
using Streamarr.Server.Viewers.Auth;

namespace Streamarr.Server.Viewers;

/// <summary>A domain failure of the viewer module that maps 1:1 onto the shared error envelope.</summary>
public sealed class ViewerProblem(int status, string code, string message) : Exception(message)
{
    public int Status { get; } = status;
    public string Code { get; } = code;

    public static ViewerProblem BadRequest(string code, string message) => new(StatusCodes.Status400BadRequest, code, message);
    public static ViewerProblem NotFound(string code, string message) => new(StatusCodes.Status404NotFound, code, message);
    public static ViewerProblem Conflict(string code, string message) => new(StatusCodes.Status409Conflict, code, message);
    public static ViewerProblem Unauthorized(string code, string message) => new(StatusCodes.Status401Unauthorized, code, message);
    public static ViewerProblem Forbidden(string code, string message) => new(StatusCodes.Status403Forbidden, code, message);
}

/// <summary>Turns <see cref="ViewerProblem"/> into the typed error response.</summary>
public sealed class ViewerProblemFilterAttribute : ExceptionFilterAttribute
{
    public override void OnException(ExceptionContext context)
    {
        if (context.Exception is not ViewerProblem problem)
            return;
        context.Result = new ObjectResult(ErrorResponse.Of(problem.Code, problem.Message)) { StatusCode = problem.Status };
        context.ExceptionHandled = true;
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
