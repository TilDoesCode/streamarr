using System.Text;
using System.Text.RegularExpressions;
using SkiaSharp;

namespace Streamarr.DevWorld;

/// <summary>
/// Generated artwork for fictional titles: catalog URLs <c>devworld:/t/p/{size}/{file}</c> are drawn once into the cache
/// in TMDB's size classes and served under <c>/devworld/art/t/p/{size}/{file}</c>, so they size like TMDB URLs.
/// </summary>
public static partial class DevWorldArtwork
{
    public const string Scheme = "devworld:/";
    public const string RoutePrefix = "/devworld/art/";

    /// <summary>Bump when the drawing changes so stale cache files are redrawn.</summary>
    public const int Version = 1;

    public static readonly IReadOnlyList<string> PosterSizes = ["w185", "w342", "w780"];
    public static readonly IReadOnlyList<string> WideSizes = ["w300", "w780", "w1280"];

    public static string ArtDir(DevWorldOptions options) => Path.Combine(options.CacheDir, "art", $"v{Version}");

    /// <summary>The served URL of a <c>devworld:/</c> catalog URL; other URLs unchanged.</summary>
    public static string? Resolve(string? url, string origin)
        => url is not null && url.StartsWith(Scheme, StringComparison.Ordinal) ? $"{origin}{RoutePrefix}{url[Scheme.Length..]}" : url;

    /// <summary>Draws every <c>devworld:/</c> image of the catalog that is not in the cache yet; returns how many were drawn.</summary>
    public static int Ensure(DevWorldOptions options, DevCatalog catalog)
    {
        var drawn = 0;
        foreach (var (url, art) in Planned(catalog))
        {
            var file = FileName(url);
            var sizes = art.Kind == ArtKind.Poster ? PosterSizes : WideSizes;
            foreach (var size in sizes)
            {
                var path = Path.Combine(ArtDir(options), size, file);
                if (File.Exists(path))
                    continue;
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var width = int.Parse(size[1..], System.Globalization.CultureInfo.InvariantCulture);
                var height = art.Kind == ArtKind.Poster ? width * 3 / 2 : width * 9 / 16;
                var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
                File.WriteAllBytes(tmp, Draw(art, width, height));
                File.Move(tmp, path, overwrite: true);
                drawn++;
            }
        }
        return drawn;
    }

    public static void MapDevWorldArtwork(this WebApplication app, DevWorldOptions options)
    {
        app.MapGet(RoutePrefix + "t/p/{size}/{file}", (string size, string file) =>
            {
                if (!PosterSizes.Concat(WideSizes).Contains(size) || !SafeFile().IsMatch(file))
                    return Results.NotFound();
                var path = Path.Combine(ArtDir(options), size, file);
                return File.Exists(path) ? Results.File(path, "image/jpeg") : Results.NotFound();
            })
            .AllowAnonymous().ExcludeFromDescription();
    }

    /// <summary>JSON answers name generated artwork by the origin the caller used (10.0.2.2 on the Android emulator, localhost elsewhere).</summary>
    public static void UseDevWorldArtworkOrigin(this WebApplication app, DevWorldOptions options)
    {
        var local = Encoding.UTF8.GetBytes(options.LocalUrl + RoutePrefix);
        app.Use(async (context, next) =>
        {
            var origin = $"{context.Request.Scheme}://{context.Request.Host}";
            if (!context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase)
                || string.Equals(origin, options.LocalUrl, StringComparison.OrdinalIgnoreCase))
            {
                await next();
                return;
            }

            var original = context.Response.Body;
            var buffer = new JsonBuffer(original, () => context.Response.ContentType);
            context.Response.Body = buffer;
            try
            {
                await next();
                if (buffer.Buffered is { } json)
                {
                    var bytes = Replace(json.ToArray(), local, Encoding.UTF8.GetBytes(origin + RoutePrefix));
                    context.Response.ContentLength = bytes.Length;
                    await original.WriteAsync(bytes);
                }
            }
            finally
            {
                context.Response.Body = original;
            }
        });
    }

    private static byte[] Replace(byte[] source, byte[] find, byte[] with)
    {
        var output = new MemoryStream(source.Length);
        var start = 0;
        int index;
        while ((index = source.AsSpan(start).IndexOf(find)) >= 0)
        {
            output.Write(source, start, index);
            output.Write(with);
            start += index + find.Length;
        }
        output.Write(source, start, source.Length - start);
        return output.ToArray();
    }

    /// <summary>Buffers JSON bodies (to rewrite them at the end); anything else streams straight through.</summary>
    private sealed class JsonBuffer(Stream inner, Func<string?> contentType) : Stream
    {
        private bool? _json;
        public MemoryStream? Buffered { get; private set; }

        private Stream Target()
        {
            _json ??= contentType()?.Contains("json", StringComparison.OrdinalIgnoreCase) == true;
            return _json == true ? Buffered ??= new MemoryStream() : inner;
        }

        public override void Write(byte[] buffer, int offset, int count) => Target().Write(buffer, offset, count);
        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken ct) => Target().WriteAsync(buffer, offset, count, ct);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken ct = default) => Target().WriteAsync(buffer, ct);
        public override void Flush() { if (_json != true) inner.Flush(); }
        public override Task FlushAsync(CancellationToken ct) => _json == true ? Task.CompletedTask : inner.FlushAsync(ct);
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
    }

    private enum ArtKind { Poster, Backdrop, Still }

    private sealed record Art(ArtKind Kind, int Seed, string? Title);

    private static string FileName(string url) => url[(url.LastIndexOf('/') + 1)..];

    private static IEnumerable<(string Url, Art Art)> Planned(DevCatalog catalog)
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        IEnumerable<(string? Url, Art Art)> All()
        {
            foreach (var title in catalog.Movies.Cast<TitleEntry>().Concat(catalog.Series))
            {
                yield return (title.PosterUrl, new Art(ArtKind.Poster, 0, title.Title));
                yield return (title.PosterUrlDe, new Art(ArtKind.Poster, 0, title.TitleDe ?? title.Title));
                yield return (title.BackdropUrl, new Art(ArtKind.Backdrop, 0, null));
                yield return (title.BackdropUrlDe, new Art(ArtKind.Backdrop, 0, null));
            }
            foreach (var season in catalog.Series.SelectMany(s => s.Seasons))
            {
                yield return (season.PosterUrl, new Art(ArtKind.Poster, season.SeasonNumber, null));
                foreach (var episode in season.Episodes)
                    yield return (episode.StillUrl, new Art(ArtKind.Still, season.SeasonNumber * 100 + episode.EpisodeNumber, null));
            }
        }
        foreach (var (url, art) in All())
        {
            if (url is null || !url.StartsWith(Scheme, StringComparison.Ordinal) || !seen.Add(FileName(url)))
                continue;
            if (!SafeFile().IsMatch(FileName(url)))
                throw new InvalidDataException($"Generated artwork needs a plain file name: {url}");
            yield return (url, art);
        }
    }

    private sealed record Mood(SKColor SkyTop, SKColor SkyMid, SKColor Horizon, SKColor SeaTop, SKColor SeaBottom, bool Stars, SKColor Beam);

    private static readonly Mood[] Moods =
    [
        new(new(0x0B, 0x13, 0x2B), new(0x1C, 0x35, 0x5E), new(0xE8, 0x8D, 0x5A), new(0x1A, 0x2E, 0x4A), new(0x06, 0x0C, 0x18), true, new(0xFF, 0xE9, 0xA8)),
        new(new(0x2B, 0x4C, 0x7E), new(0x7F, 0xA7, 0xC9), new(0xF6, 0xD6, 0xA8), new(0x3A, 0x5F, 0x80), new(0x13, 0x26, 0x3B), false, new(0xFF, 0xF6, 0xD8)),
        new(new(0x1E, 0x10, 0x30), new(0x6B, 0x2D, 0x5C), new(0xF2, 0x9E, 0x4C), new(0x2E, 0x1F, 0x3D), new(0x0C, 0x08, 0x16), true, new(0xFF, 0xD9, 0x8A)),
        new(new(0x10, 0x16, 0x1C), new(0x3A, 0x47, 0x52), new(0x8C, 0x9A, 0xA3), new(0x24, 0x30, 0x38), new(0x0A, 0x0F, 0x13), false, new(0xF2, 0xF5, 0xE6)),
        new(new(0x04, 0x07, 0x14), new(0x0E, 0x1B, 0x3A), new(0x2F, 0x4E, 0x7A), new(0x0C, 0x16, 0x2C), new(0x02, 0x05, 0x0C), true, new(0xFF, 0xEE, 0xB8)),
    ];

    private static byte[] Draw(Art art, int width, int height)
    {
        using var bitmap = new SKBitmap(width, height);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Scale(height / 1000f);
            var virtualWidth = 1000f * width / height;
            Scene(canvas, art, virtualWidth);
            if (art.Title is not null)
                Title(canvas, art.Title, virtualWidth);
        }
        using var image = SKImage.FromBitmap(bitmap);
        using var data = image.Encode(SKEncodedImageFormat.Jpeg, 80);
        return data.ToArray();
    }

    /// <summary>A lighthouse on a rock at sea, 1000 units high; the mood and layout follow the seed.</summary>
    private static void Scene(SKCanvas canvas, Art art, float vw)
    {
        var mood = Moods[art.Seed % Moods.Length];
        var random = new Random(9001 + art.Seed);
        var horizon = art.Kind == ArtKind.Poster ? 640f : 620f;
        var towerX = vw * art.Kind switch
        {
            ArtKind.Poster => 0.56f,
            ArtKind.Backdrop => 0.7f,
            _ => 0.25f + art.Seed % 7 * 0.08f,
        };

        using var fill = new SKPaint { IsAntialias = true };
        fill.Shader = SKShader.CreateLinearGradient(new SKPoint(0, 0), new SKPoint(0, horizon),
            [mood.SkyTop, mood.SkyMid, mood.Horizon], [0f, 0.62f, 1f], SKShaderTileMode.Clamp);
        canvas.DrawRect(0, 0, vw, horizon, fill);

        if (mood.Stars)
        {
            fill.Shader = null;
            for (var i = 0; i < 140; i++)
            {
                var y = (float)random.NextDouble() * horizon * 0.7f;
                fill.Color = SKColors.White.WithAlpha((byte)random.Next(60, 220));
                canvas.DrawCircle((float)random.NextDouble() * vw, y, 1.3f, fill);
            }
            fill.Color = new SKColor(0xF4, 0xF1, 0xE4);
            canvas.DrawCircle(towerX > vw / 2 ? vw * 0.2f : vw * 0.8f, 150, 34, fill);
        }

        fill.Shader = SKShader.CreateLinearGradient(new SKPoint(0, horizon), new SKPoint(0, 1000),
            [mood.SeaTop, mood.SeaBottom], (float[]?)null, SKShaderTileMode.Clamp);
        canvas.DrawRect(0, horizon, vw, 1000 - horizon, fill);
        fill.Shader = null;
        for (var i = 0; i < 60; i++)
        {
            var y = horizon + 6 + (float)Math.Pow(random.NextDouble(), 1.6) * (1000 - horizon);
            fill.Color = mood.Horizon.WithAlpha((byte)random.Next(25, 90));
            var length = 20 + (float)random.NextDouble() * 120;
            canvas.DrawRect((float)random.NextDouble() * vw, y, length, 2.2f, fill);
        }

        var lampY = horizon - 330;
        var beamAngle = (art.Seed * 37 % 140 - 70) / 180f * MathF.PI;
        foreach (var side in new[] { -1f, 1f })
        {
            var tip = new SKPoint(towerX + side * 1400 * MathF.Cos(beamAngle), lampY - 260 * MathF.Sin(beamAngle) * side);
            using var beam = new SKPath();
            beam.MoveTo(towerX, lampY);
            beam.LineTo(tip.X, tip.Y - 90);
            beam.LineTo(tip.X, tip.Y + 90);
            beam.Close();
            fill.Shader = SKShader.CreateLinearGradient(new SKPoint(towerX, lampY), tip,
                [mood.Beam.WithAlpha(150), mood.Beam.WithAlpha(0)], (float[]?)null, SKShaderTileMode.Clamp);
            canvas.DrawPath(beam, fill);
        }
        fill.Shader = null;

        using (var rock = new SKPath())
        {
            rock.MoveTo(towerX - 230, horizon + 40);
            rock.CubicTo(towerX - 150, horizon - 60, towerX - 60, horizon - 50, towerX, horizon - 45);
            rock.CubicTo(towerX + 90, horizon - 40, towerX + 170, horizon - 20, towerX + 260, horizon + 45);
            rock.Close();
            fill.Color = new SKColor(0x0D, 0x10, 0x14);
            canvas.DrawPath(rock, fill);
        }

        var baseY = horizon - 45;
        const float bottomHalf = 42, topHalf = 26;
        for (var band = 0; band < 5; band++)
        {
            var y0 = baseY - band * 52;
            var y1 = y0 - 52;
            var w0 = bottomHalf - (bottomHalf - topHalf) * band / 5f;
            var w1 = bottomHalf - (bottomHalf - topHalf) * (band + 1) / 5f;
            using var stripe = new SKPath();
            stripe.MoveTo(towerX - w0, y0);
            stripe.LineTo(towerX + w0, y0);
            stripe.LineTo(towerX + w1, y1);
            stripe.LineTo(towerX - w1, y1);
            stripe.Close();
            fill.Color = band % 2 == 0 ? new SKColor(0xE9, 0xE4, 0xDA) : new SKColor(0xB2, 0x2B, 0x2B);
            canvas.DrawPath(stripe, fill);
        }
        fill.Color = SKColors.Black.WithAlpha(70);
        canvas.DrawRect(towerX + 4, baseY - 260, 24, 260, fill);

        fill.Color = new SKColor(0x1B, 0x1E, 0x24);
        canvas.DrawRect(towerX - 38, baseY - 266, 76, 10, fill);
        fill.Shader = SKShader.CreateRadialGradient(new SKPoint(towerX, lampY), 120,
            [mood.Beam, mood.Beam.WithAlpha(90), mood.Beam.WithAlpha(0)], [0f, 0.25f, 1f], SKShaderTileMode.Clamp);
        canvas.DrawCircle(towerX, lampY, 120, fill);
        fill.Shader = null;
        fill.Color = mood.Beam;
        canvas.DrawRect(towerX - 20, lampY - 22, 40, 44, fill);
        using (var roof = new SKPath())
        {
            roof.MoveTo(towerX - 30, lampY - 22);
            roof.LineTo(towerX, lampY - 58);
            roof.LineTo(towerX + 30, lampY - 22);
            roof.Close();
            fill.Color = new SKColor(0x1B, 0x1E, 0x24);
            canvas.DrawPath(roof, fill);
        }
    }

    private static void Title(SKCanvas canvas, string title, float vw)
    {
        using var typeface = SKTypeface.FromFamilyName("Georgia", SKFontStyle.Bold) ?? SKTypeface.Default;
        using var font = new SKFont(typeface, 74);
        using var paint = new SKPaint { IsAntialias = true, Color = new SKColor(0xF7, 0xF2, 0xE6) };
        using var shadow = new SKPaint { IsAntialias = true, Color = SKColors.Black.WithAlpha(150) };
        var words = title.Split(' ');
        var widest = words.Max(w => font.MeasureText(w.ToUpperInvariant()));
        if (widest > vw * 0.88f)
            font.Size *= vw * 0.88f / widest;
        var lines = new List<string>();
        foreach (var word in words)
        {
            if (lines.Count > 0 && font.MeasureText((lines[^1] + " " + word).ToUpperInvariant()) < vw * 0.88f)
                lines[^1] += " " + word;
            else
                lines.Add(word);
        }
        var y = 790f;
        foreach (var line in lines)
        {
            canvas.DrawText(line.ToUpperInvariant(), vw / 2 + 2, y + 3, SKTextAlign.Center, font, shadow);
            canvas.DrawText(line.ToUpperInvariant(), vw / 2, y, SKTextAlign.Center, font, paint);
            y += font.Size * 1.14f;
        }
    }

    [GeneratedRegex(@"^[a-z0-9][a-z0-9-]*\.jpg$", RegexOptions.CultureInvariant)]
    private static partial Regex SafeFile();
}
