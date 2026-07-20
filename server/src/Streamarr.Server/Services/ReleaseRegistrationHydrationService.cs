using System.Text.Json;
using Streamarr.Core.Media;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Services;

internal static class ReleaseRegistrationSerializer
{
    internal const int MaxRegistrationsPerRelease = 1_024;

    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        MaxDepth = 16,
    };

    public static string Serialize(RegisteredRelease registered)
    {
        var cacheOnly = Normalize(registered)
            ?? throw new InvalidDataException("A cached release registration requires a work and release id.");
        return JsonSerializer.Serialize(cacheOnly, Options);
    }

    public static string? Merge(string? existingJson, string? incomingJson)
    {
        var merged = new List<RegisteredRelease>();
        Add(existingJson);
        Add(incomingJson);
        return merged.Count == 0 ? null : JsonSerializer.Serialize(merged, Options);

        void Add(string? json)
        {
            foreach (var registered in DeserializeSafely(json))
            {
                var existingIndex = merged.FindIndex(candidate =>
                    string.Equals(candidate.WorkId, registered.WorkId, StringComparison.Ordinal));
                if (existingIndex >= 0)
                    merged.RemoveAt(existingIndex);
                merged.Add(registered);
                if (merged.Count > MaxRegistrationsPerRelease)
                    merged.RemoveAt(0);
            }
        }
    }

    public static IReadOnlyList<RegisteredRelease> DeserializeMany(string json)
    {
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = Options.MaxDepth });
        var registrations = new List<RegisteredRelease>();
        if (document.RootElement.ValueKind == JsonValueKind.Object)
        {
            Add(document.RootElement);
        }
        else if (document.RootElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var element in document.RootElement.EnumerateArray().Take(MaxRegistrationsPerRelease))
                Add(element);
        }

        return registrations;

        void Add(JsonElement element)
        {
            try
            {
                var normalized = Normalize(element.Deserialize<RegisteredRelease>(Options));
                if (normalized is not null)
                    registrations.Add(normalized);
            }
            catch (Exception exception) when (exception is JsonException or NotSupportedException)
            {
                // One malformed owner must not discard the other owners in the row.
            }
        }
    }

    private static IReadOnlyList<RegisteredRelease> DeserializeSafely(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
            return [];
        try
        {
            return DeserializeMany(json);
        }
        catch (Exception exception) when (exception is JsonException or NotSupportedException)
        {
            return [];
        }
    }

    private static RegisteredRelease? Normalize(RegisteredRelease? registered)
    {
        if (registered is null ||
            string.IsNullOrWhiteSpace(registered.WorkId) ||
            registered.Release is null ||
            string.IsNullOrWhiteSpace(registered.Release.ReleaseId))
        {
            return null;
        }

        return registered with
        {
            Release = registered.Release with
            {
                // Indexer download URLs commonly embed API keys. The NZB itself is already
                // durable, so restart hydration needs only a non-secret cache-only locator.
                NzbUrl = $"cache://{registered.Release.ReleaseId}",
            },
        };
    }
}

/// <summary>Restores release ownership/NZB metadata from the durable NZB cache after restart.</summary>
public sealed class ReleaseRegistrationHydrationService(
    NzbCacheService cache,
    IReleaseStore releaseStore,
    ILogger<ReleaseRegistrationHydrationService> logger) : IHostedService
{
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var entries = await cache.ListAsync(cancellationToken).ConfigureAwait(false);
            var restored = Restore(entries, releaseStore);
            logger.LogInformation("Restored {Count} cached release registration(s)", restored);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        catch (Exception exception)
        {
            // Cache hydration is an optimization; search remains the safe fallback.
            logger.LogWarning(exception, "Could not restore cached release registrations");
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    internal static int Restore(IEnumerable<CachedReleaseEntity> entries, IReleaseStore releaseStore)
    {
        var registrations = new List<RegisteredRelease>();
        foreach (var entry in entries)
        {
            if (string.IsNullOrWhiteSpace(entry.ReleaseRegistrationJson))
                continue;
            try
            {
                registrations.AddRange(
                    ReleaseRegistrationSerializer.DeserializeMany(entry.ReleaseRegistrationJson)
                        .Where(registered => string.Equals(
                            registered.Release.ReleaseId,
                            entry.ReleaseId,
                            StringComparison.Ordinal)));
            }
            catch (Exception exception) when (exception is JsonException or NotSupportedException)
            {
                // Ignore malformed legacy/cache rows; search can repopulate them.
            }
        }

        releaseStore.RegisterRange(registrations);
        return registrations.Count;
    }
}
