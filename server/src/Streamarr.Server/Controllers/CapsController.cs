using Microsoft.AspNetCore.Mvc;
using Streamarr.Core.Indexers;
using Streamarr.Server.Config;

namespace Streamarr.Server.Controllers;

public sealed record CapsCategory
{
    public required int Id { get; init; }
    public required string Name { get; init; }
}

public sealed record CapsProvider
{
    public required string Name { get; init; }
    public int Priority { get; init; }
    public bool Enabled { get; init; }
    public bool BackupOnly { get; init; }
}

public sealed record CapsResponse
{
    public IReadOnlyList<string> MediaTypes { get; init; } = ["movie", "tv"];
    public IReadOnlyList<CapsCategory> Categories { get; init; } = [];
    public IReadOnlyList<CapsProvider> Providers { get; init; } = [];
}

/// <summary>
/// GET /api/v1/caps (BRIEF §6.2): the categories the configured indexers search and the
/// providers streaming can draw from — a front-end's view of what this server supports.
/// </summary>
[ApiController]
[Route("api/v1/caps")]
public class CapsController(IIndexerConfigStore indexers, ProviderConfigService providers) : ControllerBase
{
    private static readonly IReadOnlyDictionary<int, string> KnownCategories = new Dictionary<int, string>
    {
        [2000] = "Movies",
        [2010] = "Movies/Foreign",
        [2040] = "Movies/HD",
        [2045] = "Movies/UHD",
        [2050] = "Movies/BluRay",
        [5000] = "TV",
        [5030] = "TV/SD",
        [5040] = "TV/HD",
        [5045] = "TV/UHD",
        [5070] = "TV/Anime",
    };

    [HttpGet]
    [ProducesResponseType(typeof(CapsResponse), StatusCodes.Status200OK)]
    public async Task<ActionResult<CapsResponse>> Get(CancellationToken ct)
    {
        var categoryIds = indexers.GetAll()
            .SelectMany(i => i.Categories)
            .Distinct()
            .OrderBy(id => id)
            .ToArray();

        var categories = categoryIds
            .Select(id => new CapsCategory { Id = id, Name = KnownCategories.GetValueOrDefault(id, $"Category {id}") })
            .ToArray();

        var providerList = (await providers.ListAsync(ct))
            .Select(p => new CapsProvider
            {
                Name = p.Name,
                Priority = p.Priority,
                Enabled = p.Enabled,
                BackupOnly = p.IsBackupOnly,
            })
            .ToArray();

        return Ok(new CapsResponse { Categories = categories, Providers = providerList });
    }
}
