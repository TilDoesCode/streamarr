using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.OpenApi.Models;
using Streamarr.Server.Contracts;
using Streamarr.Server.Modules;
using Streamarr.Server.Viewers.Auth;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Streamarr.Server.Viewers;

/// <summary>Documents the error responses the module gate and the viewer filters add to an endpoint, so the contract lists every status it can answer.</summary>
public sealed class ViewerGateResponsesOperationFilter : IOperationFilter
{
    public void Apply(OpenApiOperation operation, OperationFilterContext context)
    {
        var action = context.ApiDescription.ActionDescriptor;
        var metadata = action.EndpointMetadata;
        var filters = action.FilterDescriptors.Select(f => f.Filter).ToList();

        if (metadata.OfType<RequiresModuleAttribute>().Any())
            Add(operation, context, StatusCodes.Status404NotFound);
        if (metadata.OfType<IAuthorizeData>().Any(a => a.Policy == ViewerAuth.Policy) && !metadata.OfType<IAllowAnonymous>().Any())
            Add(operation, context, StatusCodes.Status401Unauthorized);
        if (filters.OfType<ViewerPasswordChangeFilterAttribute>().Any() && !metadata.OfType<AllowPendingPasswordChangeAttribute>().Any())
            Add(operation, context, StatusCodes.Status403Forbidden);
        if (filters.OfType<ViewerModelStateFilterAttribute>().Any() && context.ApiDescription.ParameterDescriptions.Count > 0)
            Add(operation, context, StatusCodes.Status400BadRequest);
    }

    private static void Add(OpenApiOperation operation, OperationFilterContext context, int status)
    {
        var key = status.ToString(System.Globalization.CultureInfo.InvariantCulture);
        if (operation.Responses.ContainsKey(key))
            return;
        var schema = context.SchemaGenerator.GenerateSchema(typeof(ErrorResponse), context.SchemaRepository);
        operation.Responses[key] = new OpenApiResponse
        {
            Description = ReasonPhrases.GetReasonPhrase(status),
            Content = new[] { "text/plain", "application/json", "text/json" }
                .ToDictionary(type => type, _ => new OpenApiMediaType { Schema = schema }),
        };
    }
}
