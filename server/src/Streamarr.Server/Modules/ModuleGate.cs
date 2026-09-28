using Streamarr.Server.Contracts;

namespace Streamarr.Server.Modules;

/// <summary>An optional server module whose endpoints disappear while it is switched off.</summary>
public interface IStreamarrModule
{
    string Id { get; }
    ValueTask<bool> IsEnabledAsync(CancellationToken ct);
}

/// <summary>Marks a controller or action as belonging to an optional module.</summary>
[AttributeUsage(AttributeTargets.Class | AttributeTargets.Method, Inherited = true)]
public sealed class RequiresModuleAttribute(string module) : Attribute
{
    public string Module { get; } = module;
}

/// <summary>Answers 404 <c>module_disabled</c> for endpoints of a disabled module before authentication runs.</summary>
public sealed class ModuleGateMiddleware(RequestDelegate next, IEnumerable<IStreamarrModule> modules)
{
    private readonly Dictionary<string, IStreamarrModule> _modules = modules.ToDictionary(m => m.Id, StringComparer.Ordinal);

    public async Task InvokeAsync(HttpContext context)
    {
        var required = context.GetEndpoint()?.Metadata.GetOrderedMetadata<RequiresModuleAttribute>();
        if (required is { Count: > 0 })
        {
            foreach (var attribute in required)
            {
                if (_modules.TryGetValue(attribute.Module, out var module) &&
                    await module.IsEnabledAsync(context.RequestAborted))
                {
                    continue;
                }

                context.Response.StatusCode = StatusCodes.Status404NotFound;
                context.Response.ContentType = "application/json";
                await context.Response.WriteAsJsonAsync(
                    ErrorResponse.Of("module_disabled", $"The '{attribute.Module}' module is disabled on this server."),
                    context.RequestAborted);
                return;
            }
        }

        await next(context);
    }
}
