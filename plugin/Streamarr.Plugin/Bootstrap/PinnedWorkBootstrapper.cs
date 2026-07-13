using Microsoft.Extensions.Logging;
using Streamarr.Plugin.Api;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Bootstrap;

/// <summary>
/// The M5 thin-slice bootstrap (BRIEF §8.3 / Milestone 5): runs the configured pinned
/// query against <c>/api/v1/search</c> and materializes exactly one ephemeral item so the
/// playback path can be exercised end to end before the search interception (M6) exists.
/// It is a translation shim — the server does the searching/ranking.
/// </summary>
public sealed class PinnedWorkBootstrapper(
    StreamarrApiClient api,
    EphemeralLibraryService library,
    ILogger<PinnedWorkBootstrapper> logger)
{
    public sealed record Result(bool Success, string Message, Guid? ItemId, string? WorkId);

    public async Task<Result> RunAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query))
            return new Result(false, "No pinned query configured.", null, null);

        SearchResponse? search;
        try
        {
            search = await api.SearchAsync(query, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Pinned-work search failed for {Query}", query);
            return new Result(false, $"Search failed: {ex.Message}", null, null);
        }

        var work = search?.Results.FirstOrDefault(w =>
            string.Equals(w.MediaType, "movie", StringComparison.OrdinalIgnoreCase) && w.Releases.Count > 0);
        if (work is null)
            return new Result(false, $"No movie work with releases found for \"{query}\".", null, null);

        var itemId = await library.MaterializeAsync(work, ct).ConfigureAwait(false);
        var message = $"Materialized \"{work.Title}\" ({work.Releases.Count} release(s)) as item {itemId}.";
        logger.LogInformation("{Message}", message);
        return new Result(true, message, itemId, work.WorkId);
    }
}
