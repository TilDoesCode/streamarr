using System.Security.Cryptography;
using System.Text;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.PixelFormats;

namespace Streamarr.Plugin.Library;

/// <summary>
/// Creates a local, cached copy of TMDB artwork with a size-relative Streamarr mark. Local
/// artwork lets Jellyfin serve the exact same branded pixels to every client and image size.
/// </summary>
public sealed class ArtworkBadgeService(
    IHttpClientFactory httpClientFactory,
    IApplicationPaths applicationPaths,
    ILogger<ArtworkBadgeService> logger)
{
    private const int MaxSourceBytes = 20 * 1024 * 1024;
    private const string BadgeVersion = "v3-high-resolution";
    private const int AntialiasSamplesPerAxis = 4;
    private readonly SemaphoreSlim _gate = new(4, 4);

    public async Task<string?> GetPosterAsync(
        string? sourceUrl,
        string workId,
        bool enabled,
        CancellationToken ct)
    {
        if (!enabled || string.IsNullOrWhiteSpace(sourceUrl))
            return sourceUrl;
        if (!IsTrustedTmdbImage(sourceUrl, out var uri))
        {
            logger.LogDebug("Skipping artwork badge for non-TMDB image on {WorkId}", workId);
            return sourceUrl;
        }

        var directory = Path.Combine(applicationPaths.CachePath, "streamarr", "artwork");
        var key = Convert.ToHexStringLower(SHA256.HashData(
            Encoding.UTF8.GetBytes($"{BadgeVersion}\n{sourceUrl}")));
        var outputPath = Path.Combine(directory, $"{key}.jpg");
        if (File.Exists(outputPath))
            return outputPath;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (File.Exists(outputPath))
                return outputPath;

            Directory.CreateDirectory(directory);
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            using var response = await httpClientFactory.CreateClient("StreamarrArtwork")
                .SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct)
                .ConfigureAwait(false);
            if (!response.IsSuccessStatusCode
                || response.Content.Headers.ContentLength is > MaxSourceBytes)
            {
                return sourceUrl;
            }

            await using var source = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            await using var bounded = new MemoryStream();
            await CopyBoundedAsync(source, bounded, ct).ConfigureAwait(false);
            bounded.Position = 0;

            using var image = await Image.LoadAsync<Rgba32>(bounded, ct).ConfigureAwait(false);
            DrawAdaptiveBadge(image);
            var temporaryPath = outputPath + ".tmp";
            await image.SaveAsJpegAsync(
                temporaryPath,
                new JpegEncoder { Quality = 96 },
                ct).ConfigureAwait(false);
            File.Move(temporaryPath, outputPath, overwrite: true);
            return outputPath;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or UnknownImageFormatException)
        {
            logger.LogDebug(ex, "Could not create branded artwork for {WorkId}", workId);
            return sourceUrl;
        }
        finally
        {
            _gate.Release();
        }
    }

    internal static void DrawAdaptiveBadge(Image<Rgba32> image)
    {
        var shortest = Math.Min(image.Width, image.Height);
        var size = Math.Clamp((int)MathF.Round(shortest * 0.18F), 28, 180);
        size = Math.Min(size, shortest);
        var inset = Math.Clamp((int)MathF.Round(size * 0.22F), 5, 36);
        var radius = Math.Max(4, size / 5);
        var left = Math.Min(inset, Math.Max(0, image.Width - size));
        var top = Math.Min(inset, Math.Max(0, image.Height - size));

        image.ProcessPixelRows(accessor =>
        {
            for (var y = 0; y < size; y++)
            {
                var row = accessor.GetRowSpan(top + y);
                for (var x = 0; x < size; x++)
                {
                    // Supersampled coverage keeps the rounded corners and play glyph crisp when
                    // Jellyfin resizes the poster down to search-result thumbnails.
                    var badgeCoverage = Coverage(x, y, size, radius, triangle: false);
                    if (badgeCoverage <= 0)
                        continue;
                    Blend(ref row[left + x], new Rgba32(109, 40, 217, 238), badgeCoverage);

                    var triangleCoverage = Coverage(x, y, size, radius, triangle: true);
                    if (triangleCoverage > 0)
                        Blend(ref row[left + x], new Rgba32(255, 255, 255, 255), triangleCoverage);
                }
            }
        });
    }

    private static float Coverage(int x, int y, int size, int radius, bool triangle)
    {
        var covered = 0;
        for (var sampleY = 0; sampleY < AntialiasSamplesPerAxis; sampleY++)
        {
            for (var sampleX = 0; sampleX < AntialiasSamplesPerAxis; sampleX++)
            {
                var px = x + (sampleX + 0.5F) / AntialiasSamplesPerAxis;
                var py = y + (sampleY + 0.5F) / AntialiasSamplesPerAxis;
                if (!InsideRoundedSquare(px, py, size, radius))
                    continue;
                if (triangle && !InsidePlayTriangle(px / size, py / size))
                    continue;
                covered++;
            }
        }

        return covered / (float)(AntialiasSamplesPerAxis * AntialiasSamplesPerAxis);
    }

    private static bool InsideRoundedSquare(float x, float y, int size, int radius)
    {
        var cx = Math.Clamp(x, radius, size - radius);
        var cy = Math.Clamp(y, radius, size - radius);
        var dx = x - cx;
        var dy = y - cy;
        return dx * dx + dy * dy <= radius * radius;
    }

    private static bool InsidePlayTriangle(float x, float y)
        => x >= 0.36F
           && x <= 0.72F
           && y >= 0.27F
           && y <= 0.73F
           && MathF.Abs(y - 0.5F) <= (0.72F - x) * 0.64F;

    private static void Blend(ref Rgba32 destination, Rgba32 source, float coverage)
    {
        var alpha = source.A / 255F * Math.Clamp(coverage, 0, 1);
        destination = new Rgba32(
            (byte)MathF.Round(source.R * alpha + destination.R * (1 - alpha)),
            (byte)MathF.Round(source.G * alpha + destination.G * (1 - alpha)),
            (byte)MathF.Round(source.B * alpha + destination.B * (1 - alpha)),
            255);
    }

    private static bool IsTrustedTmdbImage(string value, out Uri uri)
    {
        if (Uri.TryCreate(value, UriKind.Absolute, out var parsed)
            && parsed.Scheme == Uri.UriSchemeHttps
            && string.Equals(parsed.Host, "image.tmdb.org", StringComparison.OrdinalIgnoreCase)
            && string.IsNullOrEmpty(parsed.UserInfo))
        {
            uri = parsed;
            return true;
        }

        uri = null!;
        return false;
    }

    private static async Task CopyBoundedAsync(Stream source, Stream destination, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        var total = 0;
        while (true)
        {
            var read = await source.ReadAsync(buffer.AsMemory(0, buffer.Length), ct).ConfigureAwait(false);
            if (read == 0)
                return;
            total += read;
            if (total > MaxSourceBytes)
                throw new IOException("Artwork source exceeded the size limit.");
            await destination.WriteAsync(buffer.AsMemory(0, read), ct).ConfigureAwait(false);
        }
    }
}
