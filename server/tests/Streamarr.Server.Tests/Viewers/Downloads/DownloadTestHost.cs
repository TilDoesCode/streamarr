using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Streamarr.Core.Indexers;
using Streamarr.Core.Tmdb;
using Streamarr.Server.Services;
using Streamarr.Server.Tests.Integration;
using Streamarr.Server.Viewers.Downloads;
using Streamarr.Server.Viewers.Playback;

namespace Streamarr.Server.Tests.Viewers.Downloads;

/// <summary>Download bytes from memory: deterministic content per (release, work), with injectable slowness and a reset after N bytes.</summary>
public sealed class FakeDownloadFileSource : IDownloadFileSource
{
    public ConcurrentQueue<DownloadFileTarget> Opens { get; } = new();
    public ConcurrentQueue<(string ReleaseId, string WorkId)> Released { get; } = new();

    /// <summary>Ends the next stream with an IOException after this many bytes (one shot).</summary>
    public long? ResetAfterBytes { get; set; }

    /// <summary>Waits before every read (a slow Usenet source).</summary>
    public TimeSpan ReadDelay { get; set; }

    /// <summary>Holds <see cref="OpenAsync"/> until set (an in-flight transfer for limit tests).</summary>
    public TaskCompletionSource? OpenGate { get; set; }

    public DownloadSourceException? Failure { get; set; }

    public static byte[] Content(string releaseId, string workId, long size)
    {
        var bytes = new byte[size];
        var seed = BitConverter.ToInt32(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(releaseId + workId)), 0);
        new Random(seed).NextBytes(bytes);
        return bytes;
    }

    public async Task<IDownloadFileLease> OpenAsync(DownloadFileTarget target, CancellationToken ct)
    {
        Opens.Enqueue(target);
        if (OpenGate is { } gate)
            await gate.Task.WaitAsync(ct);
        if (Failure is { } failure)
            throw failure;
        var reset = ResetAfterBytes;
        ResetAfterBytes = null;
        return new Lease(Content(target.ReleaseId, target.WorkId, target.SizeBytes), reset, ReadDelay);
    }

    public void Release(string releaseId, string workId, string viewerId) => Released.Enqueue((releaseId, workId));

    private sealed class Lease(byte[] content, long? resetAfter, TimeSpan delay) : IDownloadFileLease
    {
        public Stream Open(long offset) => new Source(content, offset, resetAfter, delay);

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class Source(byte[] content, long offset, long? resetAfter, TimeSpan delay) : Stream
    {
        private long _position = offset;
        private long _sent;

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => content.Length;
        public override long Position { get => _position; set => throw new NotSupportedException(); }

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (delay > TimeSpan.Zero)
                await Task.Delay(delay, cancellationToken);
            if (resetAfter is { } limit && _sent >= limit)
                throw new IOException("connection reset by the source");
            var count = (int)Math.Min(buffer.Length, content.Length - _position);
            if (resetAfter is { } cap)
                count = (int)Math.Min(count, cap - _sent);
            content.AsMemory((int)_position, count).CopyTo(buffer);
            _position += count;
            _sent += count;
            return count;
        }

        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

public sealed class FakeLiveSignal : ILiveStreamSignal
{
    public int LiveStreams { get; set; }

    public bool Active => LiveStreams > 0;
}

/// <summary>The viewer host with fake resolve, probe, download bytes and live-stream signal.</summary>
public sealed class ViewerDownloadFactory : WebApplicationFactory<Program>
{
    public const string ApiKey = "machine-key-for-download-tests-0123456789";
    private readonly string _dir = Directory.CreateTempSubdirectory("streamarr-downloads-").FullName;
    private readonly SemaphoreSlim _adminGate = new(1, 1);
    private string? _adminToken;

    public ManualClock Clock { get; } = new(DateTimeOffset.UtcNow);
    public CatalogTmdbFake Tmdb { get; } = new();
    public CatalogNewznabFake Newznab { get; } = new();
    public FakePlaybackResolver Resolver { get; } = new();
    public FakePlaybackMedia Media { get; } = new();
    public FakeDownloadFileSource Files { get; } = new();
    public FakeLiveSignal Live { get; } = new();

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Production");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["Streamarr:ApiKey"] = ApiKey,
            ["Streamarr:Admin:Password"] = TestAuth.AdminPassword,
            ["Streamarr:SpecWarmup:Enabled"] = "false",
            ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(_dir, "streamarr.db")}",
            ["Streamarr:DataProtectionKeysPath"] = Path.Combine(_dir, "keys"),
            ["Streamarr:LoginAttemptsPerMinute"] = "1000",
            ["Streamarr:ViewerAuthAttemptsPerMinute"] = "1000",
            ["Streamarr:Search:PerIndexerRateLimitMilliseconds"] = "0",
            ["Streamarr:Indexers:0:Name"] = "download-indexer",
            ["Streamarr:Indexers:0:BaseUrl"] = "https://indexer.download.example",
            ["Streamarr:Indexers:0:ApiKey"] = "download-indexer-key",
            ["Streamarr:Indexers:0:Categories:0"] = "2000",
            ["Streamarr:Indexers:0:Categories:1"] = "5000",
        }));
        builder.ConfigureTestServices(services =>
        {
            services.RemoveAll<TimeProvider>();
            services.AddSingleton<TimeProvider>(Clock);
            services.RemoveAll<ITmdbClient>();
            services.AddSingleton<ITmdbClient>(Tmdb);
            services.RemoveAll<INewznabClient>();
            services.AddSingleton<INewznabClient>(Newznab);
            services.RemoveAll<IPlaybackResolver>();
            services.AddSingleton<IPlaybackResolver>(Resolver);
            services.RemoveAll<IPlaybackMedia>();
            services.AddSingleton<IPlaybackMedia>(Media);
            services.RemoveAll<IDownloadFileSource>();
            services.AddSingleton<IDownloadFileSource>(Files);
            services.RemoveAll<ILiveStreamSignal>();
            services.AddSingleton<ILiveStreamSignal>(Live);
            services.AddSingleton(new DownloadTimings(TimeSpan.FromMilliseconds(20), TimeSpan.FromSeconds(2)));
        });
    }

    public ReleaseRegistrar Releases => new(Services.GetRequiredService<Core.Media.IReleaseStore>());

    public ResolvedFileStore ResolvedFiles => Services.GetRequiredService<ResolvedFileStore>();

    public async Task<HttpClient> AdminAsync()
    {
        await _adminGate.WaitAsync();
        try
        {
            _adminToken ??= await TestAuth.LoginAsAdminAsync(CreateClient());
        }
        finally
        {
            _adminGate.Release();
        }
        return Bearer(_adminToken);
    }

    public HttpClient Bearer(string token)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
        return client;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing && Directory.Exists(_dir))
            Directory.Delete(_dir, recursive: true);
    }
}

/// <summary>Device profiles and request helpers shared by the download tests.</summary>
public static class Dl
{
    public const string Password = "correct horse battery";

    /// <summary>Media3 on Android TV: MKV and MP4, H.264/HEVC, AAC/AC-3/E-AC-3, no VLC.</summary>
    public static readonly object AndroidTv = Device("androidtv", vlc: false,
        Native(["mp4", "mkv", "webm"], [Video("h264"), Video("hevc", 10, "hdr10", "hlg")], ["aac", "ac3", "eac3", "opus"], ["srt", "ass", "webvtt"], 6));

    /// <summary>AVPlayer on an iPhone: MP4 only, with VLC for everything else.</summary>
    public static readonly object IPhone = Device("ios", vlc: true,
        Native(["mp4"], [Video("h264"), Video("hevc", 10, "hdr10", "hlg")], ["aac", "ac3", "eac3"], ["webvtt", "mov_text"], 2));

    /// <summary>The iPhone without VLC.</summary>
    public static readonly object IPhoneNoVlc = Device("ios", vlc: false,
        Native(["mp4"], [Video("h264"), Video("hevc", 10, "hdr10", "hlg")], ["aac", "ac3", "eac3"], ["webvtt", "mov_text"], 2));

    public static object Device(string platform, bool vlc, params object[] engines) => new { platform, vlcAvailable = vlc, engines };

    public static object Native(string[] containers, object[] video, string[] audio, string[] subtitles, int channels)
        => new { engine = "native", hls = true, maxAudioChannels = channels, containers, videoCodecs = video, audioCodecs = audio.Select(a => new { codec = a }).ToArray(), subtitleFormats = subtitles };

    public static object Video(string codec, int? maxBitDepth = null, params string[] hdrFormats) => new { codec, maxBitDepth, hdrFormats };

    public static async Task<(HttpClient Client, string Username, string Id)> ViewerAsync(
        ViewerDownloadFactory factory, HttpClient admin, string name, object? permissions = null, string device = "Pixel 9")
    {
        var username = $"{name}-{Guid.NewGuid():N}"[..24];
        var created = await ViewerApi.CreateAsync(admin, new { username, password = Password, permissions });
        return (await DeviceAsync(factory, username, device), username, created.GetProperty("viewer").GetProperty("id").GetString()!);
    }

    public static async Task<HttpClient> DeviceAsync(ViewerDownloadFactory factory, string username, string device)
    {
        using var anon = factory.CreateClient();
        var login = await ViewerApi.LoginAsync(anon, username, Password, device);
        Assert.True(login.IsSuccessStatusCode, await login.Content.ReadAsStringAsync());
        var body = await login.Content.ReadFromJsonAsync<JsonElement>();
        return factory.Bearer(body.GetProperty("session").GetProperty("accessToken").GetString()!);
    }

    public static async Task<JsonElement> PostAsync(HttpClient client, string path, object body, int expected = 200)
    {
        var response = await client.PostAsJsonAsync(path, body);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True((int)response.StatusCode == expected, $"POST {path}: expected {expected}, got {(int)response.StatusCode}: {text}");
        return text.Length == 0 ? default : JsonDocument.Parse(text).RootElement;
    }

    public static async Task<JsonElement> GetAsync(HttpClient client, string path, int expected = 200)
    {
        var response = await client.GetAsync(path);
        var text = await response.Content.ReadAsStringAsync();
        Assert.True((int)response.StatusCode == expected, $"GET {path}: expected {expected}, got {(int)response.StatusCode}: {text}");
        return JsonDocument.Parse(text).RootElement;
    }

    public static async Task<JsonElement> WaitAsync(HttpClient client, string downloadId)
    {
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (true)
        {
            var body = await GetAsync(client, $"/api/v1/viewer/downloads/{downloadId}?waitMs=500");
            if (body.GetProperty("state").GetString() is "ready" or "failed")
                return body;
            Assert.True(DateTime.UtcNow < deadline, $"timed out; last {body}");
        }
    }

    public static string Code(JsonElement body) => body.GetProperty("error").GetProperty("code").GetString()!;
}
