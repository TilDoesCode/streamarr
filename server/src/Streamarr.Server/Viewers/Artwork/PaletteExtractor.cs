using System.Globalization;
using SkiaSharp;

namespace Streamarr.Server.Viewers.Artwork;

/// <summary>Accent (<c>tint</c>) and deep shade (<c>tint2</c>) as <c>#RRGGBB</c>.</summary>
public sealed record ArtworkPalette(string Tint, string Tint2);

/// <summary>Deterministic two-swatch palette from artwork: k-means over a thumbnail, then contrast-adjusted for the Aurora background.</summary>
public static class PaletteExtractor
{
    /// <summary>Bump when the extraction changes so cached palettes are recomputed.</summary>
    public const int Version = 1;
    public const string Background = "#0A0C12";
    public const double MinTintContrast = 3.0;
    public const double MinTint2WhiteContrast = 4.5;
    private const int SampleWidth = 64;
    private const int Clusters = 8;
    private const int Iterations = 12;

    /// <summary>Decodes an encoded image (JPEG, PNG, WebP); null when it cannot be decoded.</summary>
    public static ArtworkPalette? FromImage(byte[] encoded)
    {
        using var data = SKData.CreateCopy(encoded);
        using var codec = SKCodec.Create(data);
        if (codec is null)
            return null;
        using var decoded = SKBitmap.Decode(codec);
        if (decoded is null || decoded.Width < 1 || decoded.Height < 1)
            return null;
        var width = Math.Min(SampleWidth, decoded.Width);
        var height = Math.Max(1, (int)Math.Round(decoded.Height * (double)width / decoded.Width));
        using var sample = decoded.Resize(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul), new SKSamplingOptions(SKFilterMode.Linear, SKMipmapMode.Linear));
        if (sample is null)
            return null;
        var pixels = new List<(double R, double G, double B)>(width * height);
        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                var c = sample.GetPixel(x, y);
                if (c.Alpha >= 128)
                    pixels.Add((c.Red / 255.0, c.Green / 255.0, c.Blue / 255.0));
            }
        }
        return FromPixels(pixels);
    }

    /// <summary>Palette from sRGB pixels in 0..1; null for an empty input.</summary>
    public static ArtworkPalette? FromPixels(IReadOnlyList<(double R, double G, double B)> pixels)
    {
        if (pixels.Count == 0)
            return null;
        var clusters = KMeans(pixels).Select(c => (c.Color, c.Share, Hsl: ToHsl(c.Color))).ToList();
        var hued = clusters.Where(c => c.Share >= 0.01 && Chroma(c.Color) >= 0.04).ToList();

        double Family(double hue) => hued.Where(o => HueDistance(o.Hsl.H, hue) <= 25).Sum(o => o.Share);
        var maxFamily = hued.Count > 0 ? hued.Max(c => Family(c.Hsl.H)) : 1;
        var accent = hued.Count > 0
            ? hued.MaxBy(c => 0.3 * Math.Min(1, Chroma(c.Color) / 0.6) + 0.3 * (1 - Math.Abs(c.Hsl.L - 0.5) * 2) + 0.4 * Family(c.Hsl.H) / maxFamily)
            : clusters.MaxBy(c => c.Share);
        var (h, s, l) = accent.Hsl;
        s = hued.Count > 0 ? Math.Clamp(s, 0.5, 0.85) : Math.Min(s, 0.12);
        var level = Math.Clamp(l, 0.5, 0.68);
        var tint = FromHsl(h, s, level);
        for (; Contrast(Rounded(tint), Parse(Background)) < MinTintContrast && level < 0.98; level += 0.01)
            tint = FromHsl(h, s, level);

        var deep = hued.Where(c => HueDistance(c.Hsl.H, h) <= 35).OrderByDescending(c => c.Share).Select(c => ((double, double, double)?)c.Hsl).FirstOrDefault()
                   ?? (h, s, l);
        var (h2, s2, _) = deep;
        s2 = hued.Count > 0 ? Math.Clamp(s2, 0.35, 0.7) : Math.Min(s2, 0.12);
        var depth = 0.2;
        var tint2 = FromHsl(h2, s2, depth);
        for (; Contrast((1, 1, 1), Rounded(tint2)) < MinTint2WhiteContrast && depth > 0.02; depth -= 0.01)
            tint2 = FromHsl(h2, s2, depth);

        return new ArtworkPalette(Hex(tint), Hex(tint2));
    }

    /// <summary>WCAG 2 contrast ratio.</summary>
    public static double Contrast((double R, double G, double B) a, (double R, double G, double B) b)
    {
        var (la, lb) = (Luminance(a), Luminance(b));
        return (Math.Max(la, lb) + 0.05) / (Math.Min(la, lb) + 0.05);
    }

    public static (double R, double G, double B) Parse(string hex)
    {
        var value = int.Parse(hex.AsSpan(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        return (((value >> 16) & 0xFF) / 255.0, ((value >> 8) & 0xFF) / 255.0, (value & 0xFF) / 255.0);
    }

    private static List<((double R, double G, double B) Color, double Share)> KMeans(IReadOnlyList<(double R, double G, double B)> pixels)
    {
        var ordered = pixels.OrderBy(Luminance).ThenBy(p => p.R).ThenBy(p => p.G).ThenBy(p => p.B).ToList();
        var k = Math.Min(Clusters, ordered.Count);
        var centers = Enumerable.Range(0, k).Select(i => ordered[(int)((i + 0.5) * ordered.Count / k)]).ToArray();
        var assignment = new int[pixels.Count];
        for (var iteration = 0; iteration < Iterations; iteration++)
        {
            var changed = false;
            for (var i = 0; i < pixels.Count; i++)
            {
                var best = 0;
                var bestDistance = double.MaxValue;
                for (var c = 0; c < k; c++)
                {
                    var d = Distance(pixels[i], centers[c]);
                    if (d < bestDistance)
                        (best, bestDistance) = (c, d);
                }
                changed |= assignment[i] != best || iteration == 0;
                assignment[i] = best;
            }
            var sums = new (double R, double G, double B, int N)[k];
            for (var i = 0; i < pixels.Count; i++)
            {
                ref var sum = ref sums[assignment[i]];
                sum = (sum.R + pixels[i].R, sum.G + pixels[i].G, sum.B + pixels[i].B, sum.N + 1);
            }
            for (var c = 0; c < k; c++)
            {
                if (sums[c].N > 0)
                    centers[c] = (sums[c].R / sums[c].N, sums[c].G / sums[c].N, sums[c].B / sums[c].N);
            }
            if (!changed)
                break;
        }
        var counts = new int[k];
        foreach (var a in assignment)
            counts[a]++;
        return Enumerable.Range(0, k).Where(c => counts[c] > 0)
            .Select(c => (centers[c], counts[c] / (double)pixels.Count)).ToList();
    }

    private static double HueDistance(double a, double b) => Math.Min(Math.Abs(a - b), 360 - Math.Abs(a - b));

    private static double Distance((double R, double G, double B) a, (double R, double G, double B) b)
        => 0.3 * (a.R - b.R) * (a.R - b.R) + 0.59 * (a.G - b.G) * (a.G - b.G) + 0.11 * (a.B - b.B) * (a.B - b.B);

    private static double Chroma((double R, double G, double B) c) => Math.Max(c.R, Math.Max(c.G, c.B)) - Math.Min(c.R, Math.Min(c.G, c.B));

    private static double Luminance((double R, double G, double B) c)
    {
        static double Channel(double v) => v <= 0.04045 ? v / 12.92 : Math.Pow((v + 0.055) / 1.055, 2.4);
        return 0.2126 * Channel(c.R) + 0.7152 * Channel(c.G) + 0.0722 * Channel(c.B);
    }

    private static (double H, double S, double L) ToHsl((double R, double G, double B) c)
    {
        var max = Math.Max(c.R, Math.Max(c.G, c.B));
        var min = Math.Min(c.R, Math.Min(c.G, c.B));
        var l = (max + min) / 2;
        var d = max - min;
        if (d < 1e-9)
            return (0, 0, l);
        var s = d / (1 - Math.Abs(2 * l - 1));
        var h = max == c.R ? (c.G - c.B) / d % 6 : max == c.G ? (c.B - c.R) / d + 2 : (c.R - c.G) / d + 4;
        return ((h * 60 + 360) % 360, Math.Min(1, s), l);
    }

    private static (double R, double G, double B) FromHsl(double h, double s, double l)
    {
        var c = (1 - Math.Abs(2 * l - 1)) * s;
        var x = c * (1 - Math.Abs(h / 60 % 2 - 1));
        var m = l - c / 2;
        var (r, g, b) = h switch
        {
            < 60 => (c, x, 0.0),
            < 120 => (x, c, 0.0),
            < 180 => (0.0, c, x),
            < 240 => (0.0, x, c),
            < 300 => (x, 0.0, c),
            _ => (c, 0.0, x),
        };
        return (r + m, g + m, b + m);
    }

    private static (double R, double G, double B) Rounded((double R, double G, double B) c) => Parse(Hex(c));

    private static string Hex((double R, double G, double B) c)
    {
        static int Byte(double v) => (int)Math.Round(Math.Clamp(v, 0, 1) * 255);
        return string.Create(CultureInfo.InvariantCulture, $"#{Byte(c.R):X2}{Byte(c.G):X2}{Byte(c.B):X2}");
    }
}
