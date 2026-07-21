using System.Net;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Jpeg;
using SixLabors.ImageSharp.PixelFormats;
using Streamarr.Plugin.Library;

namespace Streamarr.Plugin.Tests;

public class ArtworkBadgeDownloadTests : IDisposable
{
    private readonly string _cacheRoot =
        Path.Combine(Path.GetTempPath(), "streamarr-artwork-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task Retries_transient_download_failure_then_brands_the_recovered_image()
    {
        var jpeg = SampleJpeg();
        var attempts = 0;
        var service = Service(_ =>
        {
            attempts++;
            return attempts < 3
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(jpeg) };
        });

        var result = await service.GetPosterAsync(
            "https://image.tmdb.org/t/p/w780/poster.jpg",
            "work-1",
            enabled: true,
            CancellationToken.None);

        Assert.Equal(3, attempts); // two transient failures, then success
        Assert.NotNull(result);
        Assert.EndsWith(".jpg", result, StringComparison.Ordinal);
        Assert.True(File.Exists(result));
    }

    [Fact]
    public async Task Falls_back_to_source_url_after_exhausting_retries()
    {
        var attempts = 0;
        var service = Service(_ =>
        {
            attempts++;
            return new HttpResponseMessage(HttpStatusCode.BadGateway);
        });

        const string source = "https://image.tmdb.org/t/p/w780/poster.jpg";
        var result = await service.GetPosterAsync(source, "work-2", enabled: true, CancellationToken.None);

        Assert.Equal(source, result); // fail-open to the remote URL
        Assert.Equal(3, attempts); // MaxDownloadAttempts, no more
    }

    [Fact]
    public async Task Does_not_retry_an_authoritative_not_found()
    {
        var attempts = 0;
        var service = Service(_ =>
        {
            attempts++;
            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        const string source = "https://image.tmdb.org/t/p/w780/poster.jpg";
        var result = await service.GetPosterAsync(source, "work-3", enabled: true, CancellationToken.None);

        Assert.Equal(source, result);
        Assert.Equal(1, attempts); // 404 is authoritative, never retried
    }

    private ArtworkBadgeService Service(Func<HttpRequestMessage, HttpResponseMessage> callback)
    {
        var factory = new StubHttpClientFactory(new CallbackHandler(callback));
        var paths = new StubApplicationPaths(_cacheRoot);
        return new ArtworkBadgeService(factory, paths, NullLogger<ArtworkBadgeService>.Instance);
    }

    private static byte[] SampleJpeg()
    {
        using var image = new Image<Rgba32>(120, 180, new Rgba32(30, 40, 50));
        using var buffer = new MemoryStream();
        image.SaveAsJpeg(buffer, new JpegEncoder { Quality = 90 });
        return buffer.ToArray();
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_cacheRoot))
                Directory.Delete(_cacheRoot, recursive: true);
        }
        catch (IOException)
        {
            // Best-effort cleanup.
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }

    private sealed class CallbackHandler(Func<HttpRequestMessage, HttpResponseMessage> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
            => Task.FromResult(callback(request));
    }

    private sealed class StubApplicationPaths(string cachePath) : IApplicationPaths
    {
        public string CachePath { get; } = cachePath;

        public string ProgramDataPath => CachePath;
        public string WebPath => CachePath;
        public string ProgramSystemPath => CachePath;
        public string DataPath => CachePath;
        public string VirtualDataPath => CachePath;
        public string ImageCachePath => CachePath;
        public string PluginsPath => CachePath;
        public string PluginConfigurationsPath => CachePath;
        public string LogDirectoryPath => CachePath;
        public string ConfigurationDirectoryPath => CachePath;
        public string SystemConfigurationFilePath => CachePath;
        public string TempDirectory => CachePath;
        public string TrickplayPath => CachePath;
        public string BackupPath => CachePath;

        public void MakeSanityCheckOrThrow()
        {
        }

        public void CreateAndCheckMarker(string directory, string markerName, bool recursive = false)
        {
        }
    }
}
