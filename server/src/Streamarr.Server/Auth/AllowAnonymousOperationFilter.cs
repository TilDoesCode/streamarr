using Microsoft.AspNetCore.Authorization;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Streamarr.Server.Auth;

/// <summary>Documents bearer auth only on operations that are not explicitly anonymous.</summary>
public sealed class AllowAnonymousOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        if (context.ApiDescription.ActionDescriptor.EndpointMetadata.OfType<IAllowAnonymous>().Any())
            return;

        var scheme = new OpenApiSecurityScheme
        {
            Reference = new OpenApiReference
            {
                Type = ReferenceType.SecurityScheme,
                Id = "bearer",
            },
        };
        operation.Security =
        [
            new OpenApiSecurityRequirement { [scheme] = Array.Empty<string>() },
        ];
    }
}
