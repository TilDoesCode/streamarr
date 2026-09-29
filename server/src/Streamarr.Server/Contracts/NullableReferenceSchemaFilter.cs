using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.OpenApi.Models;
using Swashbuckle.AspNetCore.SwaggerGen;

namespace Streamarr.Server.Contracts;

/// <summary>Marks object-typed properties the server can send as <c>null</c> as nullable, which a bare <c>$ref</c> cannot express in OpenAPI 3.0.</summary>
public sealed class NullableReferenceSchemaFilter : ISchemaFilter
{
    private readonly NullabilityInfoContext _nullability = new();

    public void Apply(OpenApiSchema schema, SchemaFilterContext context)
    {
        if (schema.Properties is not { Count: > 0 } || context.Type is not { IsClass: true } type)
            return;
        foreach (var property in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var name = property.GetCustomAttribute<JsonPropertyNameAttribute>()?.Name ?? JsonNamingPolicy.CamelCase.ConvertName(property.Name);
            if (!schema.Properties.TryGetValue(name, out var propertySchema) || propertySchema.Reference is null || !IsNullable(property))
                continue;
            schema.Properties[name] = new OpenApiSchema { AllOf = [propertySchema], Nullable = true };
        }
    }

    private bool IsNullable(PropertyInfo property)
    {
        lock (_nullability)
            return Nullable.GetUnderlyingType(property.PropertyType) is not null || _nullability.Create(property).ReadState == NullabilityState.Nullable;
    }
}
