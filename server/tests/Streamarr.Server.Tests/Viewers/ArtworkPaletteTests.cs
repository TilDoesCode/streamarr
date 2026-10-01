using System.Net;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Persistence;
using Streamarr.Server.Viewers.Artwork;

namespace Streamarr.Server.Tests.Viewers;

public sealed class PaletteExtractorTests
{
    private static readonly (double, double, double) Background = PaletteExtractor.Parse(PaletteExtractor.Background);
    private static readonly (double, double, double) White = (1, 1, 1);

    [Fact]
    public void VividForest_GivesAGreenAccent_AndADeepShade()
    {
        var pixels = Fill((0.05, 0.12, 0.08), 600).Concat(Fill((0.25, 0.8, 0.45), 250)).Concat(Fill((0.9, 0.9, 0.85), 50)).ToList();

        var palette = PaletteExtractor.FromPixels(pixels)!;

        var (r, g, b) = PaletteExtractor.Parse(palette.Tint);
        Assert.True(g > r && g > b, palette.Tint);
        var (r2, g2, b2) = PaletteExtractor.Parse(palette.Tint2);
        Assert.True(g2 > r2 && g2 > b2, palette.Tint2);
        AssertRules(palette);
    }

    [Theory]
    [InlineData(0.02, 0.02, 0.15)]
    [InlineData(0.95, 0.9, 0.2)]
    [InlineData(0.5, 0.5, 0.5)]
    [InlineData(0, 0, 0)]
    [InlineData(1, 1, 1)]
    [InlineData(0.3, 0.05, 0.4)]
    public void ContrastRules_HoldForDarkLightAndGreyArtwork(double r, double g, double b)
        => AssertRules(PaletteExtractor.FromPixels(Fill((r, g, b), 100).ToList())!);

    [Fact]
    public void RandomArtwork_AlwaysMeetsTheContrastRules_AndIsDeterministic()
    {
        var random = new Random(7);
        for (var i = 0; i < 200; i++)
        {
            var pixels = Enumerable.Range(0, 400).Select(_ => (random.NextDouble(), random.NextDouble() * random.NextDouble(), random.NextDouble())).ToList();
            var palette = PaletteExtractor.FromPixels(pixels)!;
            AssertRules(palette);
            Assert.Equal(palette, PaletteExtractor.FromPixels(pixels));
        }
    }

    [Fact]
    public void EncodedImages_AreDecoded_AndGarbageIsNot()
    {
        var png = Png(new SKColor(220, 140, 40), new SKColor(40, 25, 10));

        var palette = PaletteExtractor.FromImage(png)!;

        var (r, g, b) = PaletteExtractor.Parse(palette.Tint);
        Assert.True(r > g && g > b, palette.Tint);
        AssertRules(palette);
        Assert.Null(PaletteExtractor.FromImage([1, 2, 3, 4]));
        Assert.Null(PaletteExtractor.FromPixels([]));
    }

    [Fact]
    public void WhiteSky_GivesANearWhiteHighlight()
    {
        var pixels = Fill((0.96, 0.97, 1.0), 300).Concat(Fill((0.2, 0.45, 0.15), 700)).ToList();

        var highlight = PaletteExtractor.Parse(PaletteExtractor.FromPixels(pixels)!.Highlight!);

        Assert.True(PaletteExtractor.Luminance(highlight) > 0.9, $"{highlight}");
    }

    [Fact]
    public void DarkScene_KeepsADarkHighlight_DespiteAFewWhitePixels()
    {
        var pixels = Fill((0.08, 0.06, 0.1), 940).Concat(Fill((0.2, 0.15, 0.12), 50)).Concat(Fill((1, 1, 1), 10)).ToList();

        var palette = PaletteExtractor.FromPixels(pixels)!;

        Assert.Equal("#33261F", palette.Highlight);
        Assert.True(PaletteExtractor.Luminance(PaletteExtractor.Parse(palette.Highlight!)) < 0.05);
    }

    [Fact]
    public void Highlight_IsTheNinetyFifthLuminancePercentile()
    {
        var pixels = Enumerable.Range(0, 100).Select(i => (i / 99.0, i / 99.0, i / 99.0)).Reverse().ToList();

        var (r, _, _) = PaletteExtractor.Highlight(pixels);

        Assert.Equal(94 / 99.0, r, 6);
    }

    [Fact]
    public void EncodedImages_MeasureTheHighlight()
    {
        var bright = PaletteExtractor.FromImage(Png(new SKColor(245, 248, 255), new SKColor(30, 80, 30)))!;
        var dark = PaletteExtractor.FromImage(Png(new SKColor(40, 30, 50), new SKColor(10, 10, 14)))!;

        Assert.Equal("#F5F8FF", bright.Highlight);
        Assert.Equal("#281E32", dark.Highlight);
    }

    internal static byte[] Png(SKColor top, SKColor bottom)
    {
        using var bitmap = new SKBitmap(160, 90);
        using (var canvas = new SKCanvas(bitmap))
        {
            canvas.Clear(bottom);
            using var paint = new SKPaint { Color = top };
            canvas.DrawRect(0, 0, 160, 40, paint);
        }
        using var image = SKImage.FromBitmap(bitmap);
        return image.Encode(SKEncodedImageFormat.Png, 100).ToArray();
    }

    private static void AssertRules(ArtworkPalette palette)
    {
        Assert.Matches("^#[0-9A-F]{6}$", palette.Tint);
        Assert.Matches("^#[0-9A-F]{6}$", palette.Tint2);
        Assert.Matches("^#[0-9A-F]{6}$", palette.Highlight!);
        Assert.True(PaletteExtractor.Contrast(PaletteExtractor.Parse(palette.Tint), Background) >= 3.0, $"tint {palette.Tint}");
        Assert.True(PaletteExtractor.Contrast(White, PaletteExtractor.Parse(palette.Tint2)) >= 4.5, $"tint2 {palette.Tint2}");
    }

    private static IEnumerable<(double R, double G, double B)> Fill((double R, double G, double B) color, int count) => Enumerable.Repeat(color, count);
}

public sealed class ArtworkPaletteServiceTests : IAsyncLifetime
{
    private const string Backdrop = "https://image.tmdb.org/t/p/w1280/backdrop.jpg";
    private const string Poster = "https://image.tmdb.org/t/p/w780/poster.jpg";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-palette-").FullName;
    private readonly ImageHandler _images = new();
    private TestDbFactory _db = null!;

    public async Task InitializeAsync()
    {
        _db = new TestDbFactory(new DbContextOptionsBuilder<StreamarrDbContext>().UseSqlite($"Data Source={Path.Combine(_dir, "palette.db")}").Options);
        await using var db = await _db.CreateDbContextAsync();
        await db.Database.EnsureCreatedAsync();
    }

    public Task DisposeAsync()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        Directory.Delete(_dir, recursive: true);
        return Task.CompletedTask;
    }

    [Fact]
    public async Task Misses_ReturnNull_ThenTheWorkerComputesAndPersists_TheSmallRendition()
    {
        _images.Images["/t/p/w300/backdrop.jpg"] = PaletteExtractorTests.Png(new SKColor(60, 200, 120), new SKColor(10, 40, 25));
        var palette = await RunAsync(async service =>
        {
            Assert.Null(service.For(Backdrop, Poster));
            await service.WhenIdleAsync(Timeout());
            return service.For(Backdrop, Poster);
        });

        Assert.NotNull(palette);
        Assert.Equal(["/t/p/w300/backdrop.jpg"], _images.Requests);
        var reloaded = await RunAsync(async service =>
        {
            for (var i = 0; i < 100 && service.For(Backdrop, null) is null; i++)
                await Task.Delay(20);
            return service.For(Backdrop, null);
        });
        Assert.Equal(palette, reloaded);
        Assert.Single(_images.Requests);
    }

    [Fact]
    public async Task RowsOfAnOlderExtractorVersion_AreRecomputed()
    {
        await using (var db = await _db.CreateDbContextAsync())
        {
            db.ArtworkPalettes.Add(new() { ImageUrl = Backdrop, Tint = "#123456", Tint2 = "#010203", ComputedAt = DateTimeOffset.UtcNow, Version = PaletteExtractor.Version - 1 });
            await db.SaveChangesAsync();
        }
        _images.Images["/t/p/w300/backdrop.jpg"] = PaletteExtractorTests.Png(new SKColor(60, 200, 120), new SKColor(10, 40, 25));

        var palette = await RunAsync(async service =>
        {
            for (var i = 0; i < 200 && (service.For(Backdrop, null) is null or { Tint: "#123456" }); i++)
                await Task.Delay(20);
            return service.For(Backdrop, null);
        });

        Assert.NotEqual("#123456", palette!.Tint);
        Assert.NotNull(palette.Highlight);
        Assert.Single(_images.Requests);
    }

    [Fact]
    public async Task RowsOfAnOlderExtractorVersion_KeepServingTheirColours_UntilRecomputed()
    {
        await using (var db = await _db.CreateDbContextAsync())
        {
            db.ArtworkPalettes.Add(new() { ImageUrl = Backdrop, Tint = "#123456", Tint2 = "#010203", ComputedAt = DateTimeOffset.UtcNow, Version = PaletteExtractor.Version - 1 });
            await db.SaveChangesAsync();
        }
        _images.Fail = true;

        var palette = await RunAsync(async service =>
        {
            for (var i = 0; i < 200 && service.For(Backdrop, null) is null; i++)
                await Task.Delay(20);
            await service.WhenIdleAsync(Timeout());
            return service.For(Backdrop, null);
        });

        Assert.Equal(new ArtworkPalette("#123456", "#010203", null), palette);
    }

    [Fact]
    public async Task AFullQueue_OverflowsWithoutLosingOrDuplicatingImages()
    {
        _images.Fail = true;
        var urls = Enumerable.Range(0, 3000).Select(i => $"https://image.tmdb.org/t/p/w1280/{i}.jpg").ToList();
        await RunAsync(async service =>
        {
            Parallel.ForEach(urls, new ParallelOptions { MaxDegreeOfParallelism = 8 }, url => service.For(url, null));
            await service.WhenIdleAsync(Timeout());
            return 0;
        });

        Assert.Equal(urls.Count, _images.Requests.Count);
        Assert.Equal(urls.Count, _images.Requests.Distinct().Count());
    }

    [Fact]
    public async Task OverflowedImages_AreNeverOvertakenByLaterOnes()
    {
        _images.Fail = true;
        var urls = Enumerable.Range(0, 3000).Select(i => $"https://image.tmdb.org/t/p/w1280/{i}.jpg").ToList();
        await RunAsync(async service =>
        {
            foreach (var url in urls)
                service.For(url, null);
            await service.WhenIdleAsync(Timeout());
            return 0;
        });

        Assert.Equal(urls.Select(u => u.Replace("w1280", "w300", StringComparison.Ordinal).Replace("https://image.tmdb.org", "", StringComparison.Ordinal)), _images.Requests);
    }

    [Fact]
    public async Task AMissingBackdrop_FallsBackToThePoster()
    {
        _images.Images["/t/p/w300/poster.jpg"] = PaletteExtractorTests.Png(new SKColor(200, 60, 60), new SKColor(40, 10, 10));
        var palette = await RunAsync(async service =>
        {
            service.For(Backdrop, Poster);
            await service.WhenIdleAsync(Timeout());
            Assert.Null(service.For(Backdrop, Poster));
            await service.WhenIdleAsync(Timeout());
            return service.For(Backdrop, Poster);
        });

        var (r, g, b) = PaletteExtractor.Parse(palette!.Tint);
        Assert.True(r > g && r > b, palette.Tint);
        Assert.Equal(["/t/p/w300/backdrop.jpg", "/t/p/w300/poster.jpg"], _images.Requests);
    }

    [Fact]
    public async Task ForeignHosts_AreNeverFetched()
    {
        await RunAsync(async service =>
        {
            Assert.Null(service.For("https://evil.example/t/p/w1280/x.jpg", "http://127.0.0.1/poster.jpg"));
            await service.WhenIdleAsync(Timeout());
            return 0;
        });
        Assert.Empty(_images.Requests);
    }

    [Fact]
    public async Task TransientFailures_AreRetriedLater_NotPersisted()
    {
        _images.Fail = true;
        await RunAsync(async service =>
        {
            service.For(Backdrop, null);
            await service.WhenIdleAsync(Timeout());
            Assert.Null(service.For(Backdrop, null));
            await service.WhenIdleAsync(Timeout());
            return 0;
        });
        Assert.Single(_images.Requests);
        await using var db = await _db.CreateDbContextAsync();
        Assert.Empty(await db.ArtworkPalettes.ToListAsync());
    }

    [Theory]
    [InlineData("https://image.tmdb.org/t/p/original/a.jpg", "https://image.tmdb.org/t/p/w300/a.jpg")]
    [InlineData("https://image.tmdb.org/t/p/w1280/a.jpg", "https://image.tmdb.org/t/p/w300/a.jpg")]
    [InlineData("https://image.tmdb.org/other/a.jpg", "https://image.tmdb.org/other/a.jpg")]
    public void TmdbUrls_AreSampledAtW300(string url, string expected) => Assert.Equal(expected, ArtworkPaletteService.SampleUrl(url));

    private async Task<T> RunAsync<T>(Func<ArtworkPaletteService, Task<T>> body)
    {
        var service = new ArtworkPaletteService(_db, new HandlerFactory(_images), new TmdbOptions(), TimeProvider.System, NullLogger<ArtworkPaletteService>.Instance);
        await service.StartAsync(CancellationToken.None);
        try
        {
            return await body(service);
        }
        finally
        {
            await service.StopAsync(CancellationToken.None);
        }
    }

    private static CancellationToken Timeout() => new CancellationTokenSource(TimeSpan.FromSeconds(10)).Token;

    private sealed class ImageHandler : HttpMessageHandler
    {
        public Dictionary<string, byte[]> Images { get; } = new(StringComparer.Ordinal);
        public List<string> Requests { get; } = [];
        public bool Fail { get; set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            lock (Requests)
                Requests.Add(request.RequestUri!.AbsolutePath);
            if (Fail)
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.ServiceUnavailable));
            return Task.FromResult(Images.TryGetValue(request.RequestUri!.AbsolutePath, out var bytes)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }

    private sealed class HandlerFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class TestDbFactory(DbContextOptions<StreamarrDbContext> options) : IDbContextFactory<StreamarrDbContext>
    {
        public StreamarrDbContext CreateDbContext() => new(options);
        public Task<StreamarrDbContext> CreateDbContextAsync(CancellationToken cancellationToken = default) => Task.FromResult(CreateDbContext());
    }
}
