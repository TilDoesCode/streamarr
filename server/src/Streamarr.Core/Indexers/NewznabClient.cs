using System.Globalization;
using System.Text;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Streamarr.Core.Providers;

namespace Streamarr.Core.Indexers;

/// <summary>
/// Default <see cref="INewznabClient"/> over <see cref="HttpClient"/>. Builds the
/// Newznab request URL, fetches it, and hands the body to
/// <see cref="NewznabXmlParser"/>. Stateless — one instance serves every indexer.
/// </summary>
public sealed class NewznabClient(HttpClient httpClient, ILogger<NewznabClient>? logger = null) : INewznabClient
{
    private readonly ILogger _logger = logger ?? NullLogger<NewznabClient>.Instance;

    public async Task<NewznabCapabilities> GetCapabilitiesAsync(IndexerConfig indexer, CancellationToken cancellationToken)
    {
        var url = BuildUrl(indexer, "caps", query: null);
        var body = await GetStringAsync(indexer, url, cancellationToken);
        return NewznabXmlParser.ParseCapabilities(body);
    }

    public async Task<NewznabSearchResponse> SearchAsync(IndexerConfig indexer, NewznabQuery query, CancellationToken cancellationToken)
    {
        var url = BuildUrl(indexer, query.Function, query);
        var body = await GetStringAsync(indexer, url, cancellationToken);
        var response = NewznabXmlParser.ParseSearch(body);
        _logger.LogDebug("Indexer {Indexer} returned {Count} item(s) for {Function}",
            indexer.Name, response.Items.Count, query.Function);
        return response;
    }

    private async Task<string> GetStringAsync(IndexerConfig indexer, Uri url, CancellationToken cancellationToken)
    {
        HttpResponseMessage response;
        try
        {
            response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseContentRead, cancellationToken);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // HttpClient surfaces its own timeout as a cancellation that is not ours.
            throw new NewznabRequestException($"Request to indexer '{indexer.Name}' timed out.");
        }
        catch (HttpRequestException e)
        {
            throw new NewznabRequestException($"Request to indexer '{indexer.Name}' failed: {e.Message}", e);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                throw new NewznabRequestException(
                    $"Indexer '{indexer.Name}' returned HTTP {(int)response.StatusCode} {response.ReasonPhrase}.");
            }

            return await response.Content.ReadAsStringAsync(cancellationToken);
        }
    }

    /// <summary>
    /// Renders a Newznab request URL: <c>{baseUrl}/api?apikey=…&amp;t=…&amp;o=xml&amp;extended=1</c>
    /// plus the query's parameters (q, imdbid, tmdbid, season, ep, cat, limit).
    /// </summary>
    internal static Uri BuildUrl(IndexerConfig indexer, string function, NewznabQuery? query)
    {
        var baseUrl = indexer.BaseUrl.TrimEnd('/');
        if (!baseUrl.EndsWith("/api", StringComparison.OrdinalIgnoreCase))
            baseUrl += "/api";

        var sb = new StringBuilder(baseUrl);
        sb.Append("?t=").Append(function);
        sb.Append("&o=xml");

        if (!string.IsNullOrWhiteSpace(indexer.ApiKey))
            sb.Append("&apikey=").Append(Uri.EscapeDataString(indexer.ApiKey));

        if (query is not null)
        {
            sb.Append("&extended=1");

            if (!string.IsNullOrWhiteSpace(query.Term))
                sb.Append("&q=").Append(Uri.EscapeDataString(query.Term.Trim()));

            var imdb = NewznabQuery.NormalizeImdb(query.ImdbId);
            if (imdb.Length > 0)
                sb.Append("&imdbid=").Append(Uri.EscapeDataString(imdb));

            if (query.TmdbId is { } tmdb)
                sb.Append("&tmdbid=").Append(tmdb.ToString(CultureInfo.InvariantCulture));

            if (query.Season is { } season)
                sb.Append("&season=").Append(season.ToString(CultureInfo.InvariantCulture));

            if (query.Episode is { } episode)
                sb.Append("&ep=").Append(episode.ToString(CultureInfo.InvariantCulture));

            var categories = query.Categories.Count > 0 ? query.Categories : indexer.Categories;
            if (categories.Count > 0)
                sb.Append("&cat=").Append(string.Join(',', categories));

            if (query.Limit is { } limit)
                sb.Append("&limit=").Append(limit.ToString(CultureInfo.InvariantCulture));
        }

        return new Uri(sb.ToString(), UriKind.Absolute);
    }
}
