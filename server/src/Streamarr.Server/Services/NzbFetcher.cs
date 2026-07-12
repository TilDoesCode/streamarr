using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Services;

/// <summary>
/// Fetches and parses an NZB from its server-side location: an indexer HTTP(S)
/// URL in production, or a local path / file:// URI (integration tests and manual
/// use until M2 search populates the release store).
/// </summary>
public class NzbFetcher(HttpClient httpClient)
{
    public async Task<NzbDocument> FetchAsync(string nzbUrl, CancellationToken cancellationToken)
    {
        await using var stream = await OpenAsync(nzbUrl, cancellationToken);
        return await NzbDocument.LoadAsync(stream);
    }

    private async Task<Stream> OpenAsync(string nzbUrl, CancellationToken cancellationToken)
    {
        if (Uri.TryCreate(nzbUrl, UriKind.Absolute, out var uri))
        {
            if (uri.IsFile)
                return File.OpenRead(uri.LocalPath);
            if (uri.Scheme is "http" or "https")
                return await httpClient.GetStreamAsync(uri, cancellationToken);
        }

        return File.OpenRead(nzbUrl);
    }
}
