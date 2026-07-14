using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;
using Streamarr.Server.Security;

namespace Streamarr.Server.Config;

/// <summary>
/// SQLite-backed indexer config store (BRIEF §6.3). Serves the hot search path via the
/// synchronous <see cref="IIndexerConfigStore"/> contract from an in-memory snapshot
/// (with decrypted API keys) that is reloaded whenever the config API mutates a row.
/// A singleton; DB access goes through <see cref="IDbContextFactory{TContext}"/>.
/// </summary>
public sealed class IndexerConfigService : IIndexerConfigStore
{
    private readonly IDbContextFactory<StreamarrDbContext> _dbFactory;
    private readonly ISecretProtector _protector;
    private volatile IReadOnlyList<IndexerConfig> _cache = [];

    public IndexerConfigService(IDbContextFactory<StreamarrDbContext> dbFactory, ISecretProtector protector)
    {
        _dbFactory = dbFactory;
        _protector = protector;
        Reload();
    }

    // ---- IIndexerConfigStore (hot search path, decrypted, cached) --------------------

    public IReadOnlyList<IndexerConfig> GetAll() => _cache;

    public IReadOnlyList<IndexerConfig> GetEnabled() => _cache.Where(i => i.Enabled).ToArray();

    /// <summary>Rebuild the in-memory snapshot from the database.</summary>
    public void Reload()
    {
        using var db = _dbFactory.CreateDbContext();
        var rows = db.Indexers.AsNoTracking().ToList();
        _cache = rows
            .Select(ToConfig)
            .OrderBy(i => i.Priority)
            .ThenBy(i => i.Name, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    // ---- CRUD (config API) -----------------------------------------------------------

    public async Task<IReadOnlyList<IndexerEntity>> ListAsync(CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.Indexers.AsNoTracking().OrderBy(i => i.Priority).ThenBy(i => i.Name).ToListAsync(ct);
    }

    public async Task<IndexerEntity?> GetAsync(string id, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        return await db.Indexers.AsNoTracking().FirstOrDefaultAsync(i => i.Id == id, ct);
    }

    public async Task<IndexerEntity> CreateAsync(IndexerWrite write, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = new IndexerEntity
        {
            Id = Guid.NewGuid().ToString("n"),
            Name = write.Name,
            BaseUrl = write.BaseUrl,
            Categories = JoinCategories(write.Categories),
            AllowedDownloadHosts = JoinHosts(write.AllowedDownloadHosts),
            Enabled = write.Enabled ?? true,
            Priority = write.Priority ?? 0,
            // On create an omitted secret simply means "no key yet".
            ApiKeyEncrypted = SecretMasking.IsOmitted(write.ApiKey) ? null : _protector.Protect(write.ApiKey),
        };
        db.Indexers.Add(entity);
        await db.SaveChangesAsync(ct);
        Reload();
        return entity;
    }

    /// <summary>Returns the updated entity, or null when no indexer has that id.</summary>
    public async Task<IndexerEntity?> UpdateAsync(string id, IndexerWrite write, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Indexers.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (entity is null)
            return null;

        entity.Name = write.Name;
        entity.BaseUrl = write.BaseUrl;
        entity.Categories = JoinCategories(write.Categories);
        entity.AllowedDownloadHosts = JoinHosts(write.AllowedDownloadHosts);
        entity.Enabled = write.Enabled ?? entity.Enabled;
        entity.Priority = write.Priority ?? entity.Priority;

        // Omit-to-keep: only replace the stored secret when a fresh value is supplied.
        if (!SecretMasking.IsOmitted(write.ApiKey))
            entity.ApiKeyEncrypted = _protector.Protect(write.ApiKey);

        await db.SaveChangesAsync(ct);
        Reload();
        return entity;
    }

    public async Task<bool> DeleteAsync(string id, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        var entity = await db.Indexers.FirstOrDefaultAsync(i => i.Id == id, ct);
        if (entity is null)
            return false;

        db.Indexers.Remove(entity);
        await db.SaveChangesAsync(ct);
        Reload();
        return true;
    }

    public async Task<bool> ReorderAsync(IReadOnlyList<string> ids, CancellationToken ct)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(ct);
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var rows = await db.Indexers.ToListAsync(ct);
        if (ids.Count != rows.Count || ids.Distinct(StringComparer.Ordinal).Count() != ids.Count ||
            !rows.Select(x => x.Id).ToHashSet(StringComparer.Ordinal).SetEquals(ids))
        {
            return false;
        }

        var byId = rows.ToDictionary(x => x.Id, StringComparer.Ordinal);
        for (var priority = 0; priority < ids.Count; priority++)
            byId[ids[priority]].Priority = priority;

        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
        Reload();
        return true;
    }

    /// <summary>Decrypted config for one indexer (used by the /test endpoint).</summary>
    public IndexerConfig ToConfig(IndexerEntity e) => new()
    {
        Id = e.Id,
        Name = e.Name,
        BaseUrl = e.BaseUrl,
        ApiKey = _protector.Unprotect(e.ApiKeyEncrypted),
        Categories = ParseCategories(e.Categories),
        AllowedDownloadHosts = ParseHosts(e.AllowedDownloadHosts),
        Enabled = e.Enabled,
        Priority = e.Priority,
    };

    internal static string JoinCategories(IReadOnlyList<int>? categories)
        => categories is null ? string.Empty : string.Join(',', categories);

    /// <summary>
    /// Normalize the operator-supplied download hosts to a comma-separated column value:
    /// trim, lower-case, drop blanks, and de-duplicate while preserving order.
    /// </summary>
    internal static string JoinHosts(IReadOnlyList<string>? hosts)
        => hosts is null ? string.Empty : string.Join(',', NormalizeHosts(hosts));

    internal static IReadOnlyList<string> ParseHosts(string csv)
        => string.IsNullOrWhiteSpace(csv)
            ? []
            : NormalizeHosts(csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

    private static IReadOnlyList<string> NormalizeHosts(IEnumerable<string> hosts)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<string>();
        foreach (var raw in hosts)
        {
            var host = raw?.Trim().ToLowerInvariant();
            if (!string.IsNullOrEmpty(host) && seen.Add(host))
                result.Add(host);
        }

        return result;
    }

    internal static IReadOnlyList<int> ParseCategories(string csv)
        => string.IsNullOrWhiteSpace(csv)
            ? []
            : csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
                .Where(n => n is not null)
                .Select(n => n!.Value)
                .ToArray();
}

/// <summary>Write model for indexer create/update. Secret <see cref="ApiKey"/> is write-only.</summary>
public sealed record IndexerWrite
{
    public string? Id { get; init; }
    public required string Name { get; init; }
    public required string BaseUrl { get; init; }
    public string? ApiKey { get; init; }
    public IReadOnlyList<int>? Categories { get; init; }

    /// <summary>Extra hostnames NZB downloads may use besides the BaseUrl host.</summary>
    public IReadOnlyList<string>? AllowedDownloadHosts { get; init; }

    public bool? Enabled { get; init; }
    public int? Priority { get; init; }
}
