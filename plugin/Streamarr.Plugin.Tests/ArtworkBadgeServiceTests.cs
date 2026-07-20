using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Tests;

public class ArtworkBadgeServiceTests
{
    [Theory]
    [InlineData(200, 300)]
    [InlineData(1000, 1500)]
    [InlineData(120, 68)]
    public void Badge_scales_with_source_artwork_and_stays_in_the_top_left(int width, int height)
    {
        using var image = new Image<Rgba32>(width, height, new Rgba32(20, 30, 40));

        ArtworkBadgeService.DrawAdaptiveBadge(image);

        var shortest = Math.Min(width, height);
        var size = Math.Min(Math.Clamp((int)MathF.Round(shortest * 0.18F), 28, 180), shortest);
        var inset = Math.Clamp((int)MathF.Round(size * 0.22F), 5, 36);
        Assert.Equal(new Rgba32(255, 255, 255, 255), image[inset + size / 2, inset + size / 2]);
        Assert.NotEqual(new Rgba32(20, 30, 40, 255), image[inset + size / 4, inset + size / 2]);
        Assert.Equal(new Rgba32(20, 30, 40, 255), image[width - 1, height - 1]);
    }
}
