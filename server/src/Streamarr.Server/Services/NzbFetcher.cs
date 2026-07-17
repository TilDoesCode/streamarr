using System.Globalization;
using System.Net;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Core.Indexers;
using Streamarr.Core.Providers;
using Streamarr.Server.Options;
using Streamarr.Usenet.Nzb;

namespace Streamarr.Server.Services;

/// <summary>
/// Fetches untrusted NZB data through a bounded, origin-bound transport. Production
/// accepts only HTTP(S) URLs on the indexer's configured origin (or one of its
/// explicitly allowed download hosts); local files require the explicit
/// development/test escape hatch.
/// </summary>
public class NzbFetcher(
    HttpClient httpClient,
    IOptions<StreamarrOptions> options,
    IIndexerConfigStore indexers,
    ILogger<NzbFetcher>? logger = null,
    NzbCacheService? cache = null)
{
    private readonly ILogger _logger = logger ?? NullLogger<NzbFetcher>.Instance;
    private const int MaxRedirects = 3;
    internal const int MaxNzbUrlLength = 2048;

    public Task<NzbDocument> FetchAsync(string nzbUrl, CancellationToken cancellationToken)
        => FetchAsync(nzbUrl, indexerName: null, cancellationToken);

    public async Task<NzbDocument> FetchAsync(
        string nzbUrl,
        string? indexerName,
        CancellationToken cancellationToken)
    {
        var bytes = await FetchBytesAsync(nzbUrl, indexerName, cancellationToken);
        return await ParseAsync(bytes, cancellationToken);
    }

    public async Task<CachedNzb> FetchAsync(
        NzbCacheDescriptor descriptor,
        string nzbUrl,
        string? indexerName,
        CancellationToken cancellationToken)
    {
        if (cache is null)
            return new CachedNzb(await FetchAsync(nzbUrl, indexerName, cancellationToken), false);

        return await cache.GetOrCreateAsync(
            descriptor,
            ct => FetchBytesAsync(nzbUrl, indexerName, ct),
            cancellationToken);
    }

    private async Task<byte[]> FetchBytesAsync(
        string nzbUrl,
        string? indexerName,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(nzbUrl))
            throw new InvalidDataException("The release has no valid NZB location.");
        if (nzbUrl.Length > MaxNzbUrlLength)
            throw new InvalidDataException($"The NZB location exceeds the {MaxNzbUrlLength} character limit.");

        await using var source = await OpenAsync(nzbUrl, indexerName, cancellationToken);
        return await ReadBoundedAsync(source, options.Value.MaxNzbBytes, cancellationToken);
    }

    private async Task<Stream> OpenAsync(string nzbUrl, string? indexerName, CancellationToken ct)
    {
        if (!Uri.TryCreate(nzbUrl, UriKind.Absolute, out var uri) || uri.IsFile)
        {
            if (!options.Value.AllowLocalNzbFiles)
                throw new InvalidDataException("Local NZB paths are disabled.");

            var path = uri?.IsFile == true ? uri.LocalPath : nzbUrl;
            return File.Open(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        }

        if (uri.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(uri.UserInfo))
            throw new InvalidDataException("NZB locations must use HTTP or HTTPS without embedded credentials.");

        var configured = indexers.GetAll().FirstOrDefault(i =>
            string.Equals(i.Id, indexerName, StringComparison.OrdinalIgnoreCase) ||
            string.Equals(i.Name, indexerName, StringComparison.OrdinalIgnoreCase));
        if (configured is null || !Uri.TryCreate(configured.BaseUrl, UriKind.Absolute, out var baseUri))
            throw new InvalidDataException("The NZB location is not bound to a configured indexer.");

        var allowedHosts = BuildAllowedHostSet(configured.AllowedDownloadHosts);
        EnsureAllowedOrigin(uri, baseUri, allowedHosts, configured);
        var current = uri;

        for (var redirects = 0; ; redirects++)
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, current);
            var response = await httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);

            if (IsRedirect(response.StatusCode))
            {
                using (response)
                {
                    if (redirects >= MaxRedirects || response.Headers.Location is null)
                        throw new HttpRequestException("The NZB download returned too many redirects.");

                    current = response.Headers.Location.IsAbsoluteUri
                        ? response.Headers.Location
                        : new Uri(current, response.Headers.Location);
                    EnsureAllowedOrigin(current, baseUri, allowedHosts, configured);
                }
                continue;
            }

            if (!response.IsSuccessStatusCode)
            {
                using (response)
                    throw new HttpRequestException($"The NZB download returned HTTP {(int)response.StatusCode}.");
            }

            if (response.Content.Headers.ContentLength is { } length && length > options.Value.MaxNzbBytes)
            {
                response.Dispose();
                throw new InvalidDataException($"The NZB exceeds the {options.Value.MaxNzbBytes} byte limit.");
            }

            // The response owns its content stream, so return a wrapper that disposes both.
            var stream = await response.Content.ReadAsStreamAsync(ct);
            return new ResponseStream(stream, response);
        }
    }

    private static async Task<byte[]> ReadBoundedAsync(Stream source, int maxBytes, CancellationToken ct)
    {
        var result = new MemoryStream(Math.Min(maxBytes, 1024 * 1024));
        var buffer = new byte[64 * 1024];
        try
        {
            while (true)
            {
                var read = await source.ReadAsync(buffer, ct);
                if (read == 0)
                    break;
                if (result.Length + read > maxBytes)
                    throw new InvalidDataException($"The NZB exceeds the {maxBytes} byte limit.");
                await result.WriteAsync(buffer.AsMemory(0, read), ct);
            }

            return result.ToArray();
        }
        catch
        {
            await result.DisposeAsync();
            throw;
        }
    }

    private async Task<NzbDocument> ParseAsync(byte[] bytes, CancellationToken ct)
    {
        await using var stream = new MemoryStream(bytes, writable: false);
        return await NzbDocument.LoadAsync(
            stream,
            ct,
            new NzbDocumentLimits
            {
                MaxFiles = options.Value.MaxNzbFiles,
                MaxSegments = options.Value.MaxNzbSegments,
                MaxSegmentsPerFile = options.Value.MaxNzbSegments,
            });
    }

    /// <summary>
    /// Accept the candidate only when it is HTTP(S) without embedded credentials AND either
    /// matches the indexer's configured origin exactly (scheme + host + port) or its host is
    /// one of the indexer's explicitly allowed download hosts (BRIEF §6.3). Rejections are
    /// logged with origins only — never the full URL, which may carry the indexer's API key.
    /// </summary>
    private void EnsureAllowedOrigin(Uri candidate, Uri configured, ISet<string> allowedHosts, IndexerConfig indexer)
    {
        if (candidate.Scheme is not ("http" or "https") || !string.IsNullOrEmpty(candidate.UserInfo))
            throw new InvalidDataException("NZB locations must use HTTP or HTTPS without embedded credentials.");

        var sameOrigin =
            string.Equals(candidate.Scheme, configured.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(candidate.IdnHost, configured.IdnHost, StringComparison.OrdinalIgnoreCase) &&
            candidate.Port == configured.Port;

        if (sameOrigin || allowedHosts.Contains(candidate.IdnHost))
            return;

        var configuredOrigin = configured.GetLeftPart(UriPartial.Authority);
        _logger.LogWarning(
            "Rejected NZB download for indexer {Indexer} ({IndexerId}): host {CandidateOrigin} is neither the "
            + "configured origin {ConfiguredOrigin} nor an allowed download host ({AllowedHosts}).",
            indexer.Name,
            indexer.Id,
            candidate.GetLeftPart(UriPartial.Authority),
            configuredOrigin,
            allowedHosts.Count == 0 ? "none configured" : string.Join(", ", allowedHosts));

        throw new NzbOriginNotAllowedException(candidate.IdnHost, configuredOrigin, indexer.Id, indexer.Name);
    }

    /// <summary>Normalize the indexer's allowed download hosts to ASCII/IDN, lower-cased for comparison.</summary>
    private static ISet<string> BuildAllowedHostSet(IReadOnlyList<string> hosts)
    {
        var set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var idn = new IdnMapping();
        foreach (var host in hosts)
        {
            if (string.IsNullOrWhiteSpace(host))
                continue;
            var trimmed = host.Trim();
            try
            {
                set.Add(idn.GetAscii(trimmed).ToLowerInvariant());
            }
            catch (ArgumentException)
            {
                // Not IDN-encodable (e.g. an IP literal) — compare it verbatim.
                set.Add(trimmed.ToLowerInvariant());
            }
        }

        return set;
    }

    private static bool IsRedirect(HttpStatusCode status) => status is
        HttpStatusCode.Moved or
        HttpStatusCode.Redirect or
        HttpStatusCode.RedirectMethod or
        HttpStatusCode.TemporaryRedirect or
        HttpStatusCode.PermanentRedirect;

    private sealed class ResponseStream(Stream inner, HttpResponseMessage response) : Stream
    {
        public override bool CanRead => inner.CanRead;
        public override bool CanSeek => inner.CanSeek;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
            => inner.ReadAsync(buffer, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void Flush() => inner.Flush();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
                response.Dispose();
            }
            base.Dispose(disposing);
        }

        public override async ValueTask DisposeAsync()
        {
            await inner.DisposeAsync();
            response.Dispose();
            GC.SuppressFinalize(this);
        }
    }
}
