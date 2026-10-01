using System.Collections.Concurrent;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence;
using Streamarr.Server.Persistence.Entities;

namespace Streamarr.Server.Viewers.Artwork;

/// <summary>Per-image palette cache: lookups never block, misses are queued and computed by the background worker, results persist in the database.</summary>
public sealed partial class ArtworkPaletteService(
    IDbContextFactory<StreamarrDbContext> dbFactory,
    IHttpClientFactory httpFactory,
    TmdbOptions tmdb,
    TimeProvider time,
    ILogger<ArtworkPaletteService> logger) : BackgroundService
{
    public const string HttpClientName = "artwork-palette";
    public const int MaxImageBytes = 8 * 1024 * 1024;
    public static readonly TimeSpan TransientRetry = TimeSpan.FromMinutes(10);
    public static readonly TimeSpan FailedRetry = TimeSpan.FromDays(7);

    private readonly ConcurrentDictionary<string, ArtworkPaletteEntity> _palettes = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, DateTimeOffset> _retryAfter = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, byte> _queued = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _overflow = new();
    private readonly FailureLog _failures = new(logger);
    private readonly Channel<string> _queue = Channel.CreateBounded<string>(new BoundedChannelOptions(2048) { FullMode = BoundedChannelFullMode.DropWrite });
    private readonly string? _imageHost = Uri.TryCreate(tmdb.ImageBaseUrl, UriKind.Absolute, out var baseUri) ? baseUri.Host : null;

    /// <summary>The title palette: backdrop first, poster when the backdrop has none; null while it is being computed.</summary>
    public ArtworkPalette? For(string? backdropUrl, string? posterUrl)
    {
        foreach (var url in new[] { backdropUrl, posterUrl })
        {
            if (string.IsNullOrWhiteSpace(url))
                continue;
            var (palette, pending) = Lookup(url);
            if (palette is not null || pending)
                return palette;
        }
        return null;
    }

    /// <summary>Completes when every queued image has been processed (tests and warm-up).</summary>
    public async Task WhenIdleAsync(CancellationToken ct)
    {
        while (!_queued.IsEmpty)
            await Task.Delay(50, ct);
    }

    private (ArtworkPalette? Palette, bool Pending) Lookup(string url)
    {
        if (_palettes.TryGetValue(url, out var entry) && entry.Version == PaletteExtractor.Version)
        {
            if (entry.Tint is not null && entry.Tint2 is not null)
                return (new ArtworkPalette(entry.Tint, entry.Tint2), false);
            if (time.GetUtcNow() - entry.ComputedAt < FailedRetry)
                return (null, false);
        }
        if (!Fetchable(url))
            return (null, false);
        if (_retryAfter.TryGetValue(url, out var retry) && retry > time.GetUtcNow())
            return (null, false);
        if (_queued.TryAdd(url, 0) && !_queue.Writer.TryWrite(url))
        {
            _overflow.Enqueue(url);
            DrainOverflow();
        }
        return (null, true);
    }

    /// <summary>Moves images that found the queue full into it as the worker frees room; nothing is dropped.</summary>
    private void DrainOverflow()
    {
        while (_overflow.TryPeek(out var next) && _queue.Writer.TryWrite(next))
            _overflow.TryDequeue(out _);
    }

    internal int Pending => _queued.Count;

    private bool Fetchable(string url)
        => _imageHost is not null
           && Uri.TryCreate(url, UriKind.Absolute, out var uri)
           && uri.Scheme is "https" or "http"
           && string.Equals(uri.Host, _imageHost, StringComparison.OrdinalIgnoreCase);

    /// <summary>TMDB sized URLs are fetched as the small <c>w300</c> rendition; the palette is keyed by the original URL.</summary>
    internal static string SampleUrl(string url) => TmdbSize().Replace(url, "/t/p/w300/", 1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await using (var db = await dbFactory.CreateDbContextAsync(stoppingToken))
            {
                foreach (var row in await db.ArtworkPalettes.AsNoTracking().ToListAsync(stoppingToken))
                    _palettes[row.ImageUrl] = row;
            }
        }
        catch (Exception e) when (e is not OperationCanceledException)
        {
            logger.LogWarning(e, "Loading cached artwork palettes failed");
        }

        await foreach (var url in _queue.Reader.ReadAllAsync(stoppingToken))
        {
            try
            {
                if (!_palettes.TryGetValue(url, out var known) || known.Version != PaletteExtractor.Version
                    || (known.Tint is null && time.GetUtcNow() - known.ComputedAt >= FailedRetry))
                    await ComputeAsync(url, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception e)
            {
                _failures.Log(e, "Palette for {Url} failed", url);
                _retryAfter[url] = time.GetUtcNow() + TransientRetry;
            }
            finally
            {
                _queued.TryRemove(url, out _);
                DrainOverflow();
            }
        }
    }

    private async Task ComputeAsync(string url, CancellationToken ct)
    {
        using var response = await httpFactory.CreateClient(HttpClientName).GetAsync(SampleUrl(url), HttpCompletionOption.ResponseHeadersRead, ct);
        if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.Forbidden or HttpStatusCode.Gone)
        {
            await StoreAsync(url, null, ct);
            return;
        }
        response.EnsureSuccessStatusCode();
        if (response.Content.Headers.ContentLength > MaxImageBytes)
        {
            await StoreAsync(url, null, ct);
            return;
        }
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = await stream.ReadAsync(chunk, ct)) > 0)
        {
            if (buffer.Length + read > MaxImageBytes)
            {
                await StoreAsync(url, null, ct);
                return;
            }
            buffer.Write(chunk, 0, read);
        }
        await StoreAsync(url, PaletteExtractor.FromImage(buffer.ToArray()), ct);
    }

    private async Task StoreAsync(string url, ArtworkPalette? palette, CancellationToken ct)
    {
        var entity = new ArtworkPaletteEntity { ImageUrl = url, Tint = palette?.Tint, Tint2 = palette?.Tint2, ComputedAt = time.GetUtcNow(), Version = PaletteExtractor.Version };
        await using (var db = await dbFactory.CreateDbContextAsync(ct))
        {
            var existing = await db.ArtworkPalettes.FindAsync([url], ct);
            if (existing is null)
                db.ArtworkPalettes.Add(entity);
            else
                db.Entry(existing).CurrentValues.SetValues(entity);
            await db.SaveChangesAsync(ct);
        }
        _palettes[url] = entity;
        _retryAfter.TryRemove(url, out _);
        logger.LogDebug("Palette for {Url}: {Tint} / {Tint2}", url, entity.Tint, entity.Tint2);
    }

    [GeneratedRegex(@"/t/p/[a-z0-9_]+/", RegexOptions.CultureInvariant)]
    private static partial Regex TmdbSize();
}
