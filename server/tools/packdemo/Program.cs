// Season pack live demo: boots the REAL Streamarr Core Server against an in-process
// mock NNTP server (real TCP wire protocol) carrying a 3-episode season pack inside
// ONE monolithic multi-volume RAR set, plus a per-episode-RAR-set variant. Episodes
// are visually distinct (solid red/green/blue) and have distinct durations, so any
// streamed frame identifies which episode was actually served.

using System.Diagnostics;
using Microsoft.AspNetCore.Builder;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Streamarr.Core.Media;
using Streamarr.Server;
using Streamarr.Tests.Shared;

const string ApiKey = "packdemo-api-key-aaaaaaaaaaaaaaaaaaaa";
const int Port = 8098;
const int RarChunkSize = 150_000;

var workDir = Directory.CreateTempSubdirectory("streamarr-packdemo-").FullName;
Console.WriteLine($"[demo] workspace: {workDir}");

// --- 1) three real, visually distinct episodes --------------------------------------
var episodes = new byte[3][];
var colors = new[] { ("0xCC2222", "red"), ("0x22AA55", "green"), ("0x2255CC", "blue") };
var durations = new[] { 8, 12, 16 };
var frequencies = new[] { 440, 660, 880 };
for (var i = 0; i < 3; i++)
{
    episodes[i] = await GenerateEpisodeAsync(colors[i].Item1, durations[i], frequencies[i]);
    var path = Path.Combine(workDir, $"source-episode-{i + 1}.mkv");
    await File.WriteAllBytesAsync(path, episodes[i]);
    Console.WriteLine($"[demo] episode {i + 1}: {colors[i].Item2}, {durations[i]}s, {episodes[i].Length:N0} bytes → {path}");
}

// --- 2) mock usenet: publish the pack two ways --------------------------------------
var nntp = new MockNntpServer { RequireAuth = true };
Console.WriteLine($"[demo] mock NNTP listening on {nntp.Host}:{nntp.Port}");

var monolithic = Rar4TestWriter.WriteMultiVolumePack(
    "Show.S01.1080p.WEB-DL.x264-DEMO",
    [
        ("Show.S01E01.mkv", episodes[0]),
        ("Show.S01E02.mkv", episodes[1]),
        ("Show.S01E03.mkv", episodes[2]),
    ],
    RarChunkSize);
var monolithicFiles = monolithic
    .Select((v, i) => NzbTestFixtures.PublishFile(nntp, v.FileName, v.Bytes, $"demo-pack-vol{i}"))
    .ToArray();
var monolithicNzb = Path.Combine(workDir, "season-pack.nzb");
File.WriteAllText(monolithicNzb, NzbTestFixtures.BuildNzbXml(monolithicFiles));
Console.WriteLine($"[demo] monolithic pack: {monolithic.Count} RAR volumes, one archive, three inner episodes");

var setFiles = new List<PublishedNzbFile>();
for (var e = 1; e <= 3; e++)
{
    var set = Rar4TestWriter.WriteMultiVolume(
        $"Show.S01E{e:D2}.1080p.WEB-DL.x264-DEMOSETS", $"Show.S01E{e:D2}.mkv", episodes[e - 1], RarChunkSize);
    setFiles.AddRange(set.Select((v, i) => NzbTestFixtures.PublishFile(nntp, v.FileName, v.Bytes, $"demo-sets-e{e}v{i}")));
}

var setsNzb = Path.Combine(workDir, "season-pack-sets.nzb");
File.WriteAllText(setsNzb, NzbTestFixtures.BuildNzbXml(setFiles.ToArray()));
Console.WriteLine($"[demo] per-episode-sets pack: {setFiles.Count} RAR volumes across three sets in one NZB");

// --- 3) boot the real Core Server ---------------------------------------------------
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { EnvironmentName = Environments.Production });
builder.WebHost.UseUrls($"http://127.0.0.1:{Port}");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
{
    ["Serilog:MinimumLevel:Default"] = "Warning",
    ["Streamarr:ApiKey"] = ApiKey,
    ["Streamarr:Admin:Password"] = "packdemo-admin-password-123",
    ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(workDir, "streamarr.db")}",
    ["Streamarr:DataProtectionKeysPath"] = Path.Combine(workDir, "keys"),
    ["Streamarr:AllowLocalNzbFiles"] = "true",
    ["Streamarr:PreDownload:CachePath"] = Path.Combine(workDir, "pre-download"),
    ["Streamarr:Providers:0:Name"] = "mock",
    ["Streamarr:Providers:0:Host"] = nntp.Host,
    ["Streamarr:Providers:0:Port"] = nntp.Port.ToString(),
    ["Streamarr:Providers:0:UseSsl"] = "false",
    ["Streamarr:Providers:0:Username"] = nntp.Username,
    ["Streamarr:Providers:0:Password"] = nntp.Password,
    ["Streamarr:Providers:0:MaxConnections"] = "8",
});
builder.AddStreamarrServer();
var app = builder.Build();
app.UseStreamarrServer();
await app.StartAsync();

// --- 4) register the pack under its episode works (what /tv season discovery does) ---
var store = app.Services.GetRequiredService<IReleaseStore>();
for (var e = 1; e <= 4; e++) // e04 exists in the directory but NOT in the pack
{
    store.Register($"tmdb-tv-777-s01e{e:D2}", new Release
    {
        ReleaseId = "demo-season-pack",
        Title = "Show.S01.1080p.WEB-DL.x264-DEMO",
        Indexer = "demo-indexer",
        SizeBytes = 0,
        Score = 900,
        NzbUrl = monolithicNzb,
    });
    store.Register($"tmdb-tv-777-s01e{e:D2}", new Release
    {
        ReleaseId = "demo-season-pack-sets",
        Title = "Show.S01.1080p.WEB-DL.x264-DEMOSETS",
        Indexer = "demo-indexer",
        SizeBytes = 0,
        Score = 850,
        NzbUrl = setsNzb,
    });
}

Console.WriteLine($"[demo] Streamarr Core Server ready on http://127.0.0.1:{Port}");
Console.WriteLine($"[demo] api key: {ApiKey}");
Console.WriteLine("[demo] releases: demo-season-pack (monolithic RAR), demo-season-pack-sets (per-episode RAR sets)");
Console.WriteLine("[demo] workIds: tmdb-tv-777-s01e01 … s01e04 (e04 is not in the pack)");
Console.WriteLine("READY");
await Task.Delay(Timeout.Infinite);

static async Task<byte[]> GenerateEpisodeAsync(string color, int seconds, int frequency)
{
    var path = Path.Combine(Path.GetTempPath(), $"packdemo-{Guid.NewGuid():N}.mkv");
    try
    {
        var psi = new ProcessStartInfo("ffmpeg") { RedirectStandardError = true, UseShellExecute = false };
        foreach (var arg in new[]
        {
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", $"color=c={color}:duration={seconds}:size=320x240:rate=10",
            "-f", "lavfi", "-i", $"sine=frequency={frequency}:duration={seconds}:sample_rate=44100",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "64k", "-shortest", path,
        })
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = Process.Start(psi)!;
        var stderr = await process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"ffmpeg failed: {stderr}");
        return await File.ReadAllBytesAsync(path);
    }
    finally
    {
        if (File.Exists(path))
            File.Delete(path);
    }
}
