using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Streamarr.Server.Services.Diagnostics;

/// <summary>Marks an action that reads a raw <c>application/octet-stream</c> body itself.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class OctetStreamBodyAttribute : Attribute;

/// <summary>Documents the raw request body of <see cref="OctetStreamBodyAttribute"/> actions.</summary>
public sealed class OctetStreamBodyOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        if (!context.ApiDescription.ActionDescriptor.EndpointMetadata.OfType<OctetStreamBodyAttribute>().Any())
            return;
        operation.RequestBody = new OpenApiRequestBody
        {
            Required = false,
            Content = new Dictionary<string, OpenApiMediaType>
            {
                ["application/octet-stream"] = new() { Schema = new OpenApiSchema { Type = "string", Format = "binary" } },
            },
        };
    }
}
