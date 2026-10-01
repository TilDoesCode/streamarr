using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Streamarr.Tools.HlsSim;

// hlssim — drives a running Streamarr server like an HLS player and validates the transcoded rendition.
//
//   dotnet run --project server/tools/hlssim -- --server http://127.0.0.1:8080 --password <admin> --sample h264-1080p-ac3
//   dotnet run --project server/tools/hlssim -- --server ... --api-key <key> --release <releaseId> --rate 1 --seek 20:300,320:40
//   options: --max-height 720 --bitrate 4000 --rate 1|0 --buffer 30 --duration 120 --start 0 --decode --concurrency 3 --json out.json --keep

var arguments = ParseArguments(args);
if (arguments.ContainsKey("help") || !arguments.ContainsKey("server"))
{
    Console.WriteLine("usage: hlssim --server URL (--password PW [--user admin] | --api-key KEY) " +
                      "(--sample ID | --release ID [--work ID] | --stream-token TOKEN | --playlist URL) " +
                      "[--max-height N] [--bitrate KBPS] [--rate X] [--buffer S] [--duration S] [--start S] " +
                      "[--seek AT:TO,...] [--decode] [--concurrency N] [--json FILE] [--keep] [--quiet] " +
                      "[--mode auto|remux|transcode] [--video-codecs LIST] [--audio-codecs LIST] [--containers LIST] [--max-channels N] " +
                      "[--ten-bit] [--hdr-formats LIST] [--subtitle-formats LIST] [--audio-index N] [--subtitle-index N] [--no-subtitles] [--subtitles-first]");
    return 2;
}

var server = new Uri(arguments["server"].TrimEnd('/') + "/");
var cookies = new CookieContainer();
using var http = new HttpClient(new HttpClientHandler { CookieContainer = cookies }) { BaseAddress = server, Timeout = TimeSpan.FromMinutes(10) };
if (arguments.TryGetValue("api-key", out var apiKey))
{
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
}
else if (arguments.TryGetValue("password", out var password))
{
    var login = await http.PostAsJsonAsync("api/v1/auth/login", new { username = arguments.GetValueOrDefault("user", "admin"), password });
    if (!login.IsSuccessStatusCode)
    {
        Console.Error.WriteLine($"login failed: {(int)login.StatusCode}");
        return 2;
    }
    var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
    http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
}

var options = new HlsSimOptions
{
    PlaybackRate = Double("rate", 1),
    BufferTargetSeconds = Double("buffer", 30),
    StartPositionSeconds = Double("start", 0),
    StopAfterMediaSeconds = arguments.ContainsKey("duration") ? Double("duration", 0) : null,
    Seeks = ParseSeeks(arguments.GetValueOrDefault("seek")),
    Decode = arguments.ContainsKey("decode"),
    ValidateSubtitles = !arguments.ContainsKey("no-subtitles"),
    SubtitlesFirst = arguments.ContainsKey("subtitles-first"),
};
var concurrency = (int)Double("concurrency", 1);
var quiet = arguments.ContainsKey("quiet") || concurrency > 1;

var tasks = Enumerable.Range(0, Math.Max(1, concurrency)).Select(async n =>
{
    var (playlist, stop) = await CreatePlaylistAsync(n);
    try
    {
        var simulator = new HlsPlayerSimulator(http, options, quiet ? null : line => Console.WriteLine($"[{n}] {line}"));
        return await simulator.RunAsync(playlist, CancellationToken.None);
    }
    finally
    {
        if (stop is not null && !arguments.ContainsKey("keep"))
            await http.DeleteAsync(stop);
    }
}).ToList();

var reports = await Task.WhenAll(tasks);
for (var i = 0; i < reports.Length; i++)
    Print(i, reports[i]);
if (arguments.TryGetValue("json", out var jsonPath))
    await File.WriteAllTextAsync(jsonPath, JsonSerializer.Serialize(reports, new JsonSerializerOptions { WriteIndented = true }));
return reports.All(r => r.Passed) ? 0 : 1;

async Task<(Uri Playlist, Uri? Stop)> CreatePlaylistAsync(int n)
{
    if (arguments.TryGetValue("playlist", out var direct))
        return (new Uri(server, direct), null);

    string? streamToken = arguments.GetValueOrDefault("stream-token");
    if (arguments.TryGetValue("release", out var releaseId))
    {
        var resolve = await http.PostAsJsonAsync("api/v1/resolve", new { releaseId, workId = arguments.GetValueOrDefault("work"), client = "hlssim" });
        var body = await resolve.Content.ReadFromJsonAsync<JsonElement>();
        if (!resolve.IsSuccessStatusCode || !body.TryGetProperty("streamUrl", out var streamUrl) || streamUrl.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException($"resolve failed ({(int)resolve.StatusCode}): {body}");
        streamToken = streamUrl.GetString()!.Split('/').Last();
    }

    var request = new Dictionary<string, object?>
    {
        ["streamToken"] = streamToken,
        ["sampleId"] = streamToken is null ? arguments.GetValueOrDefault("sample", "h264-1080p-ac3") : null,
        ["maxHeight"] = arguments.ContainsKey("max-height") ? (int)Double("max-height", 1080) : null,
        ["maxBitrateKbps"] = arguments.ContainsKey("bitrate") ? (int)Double("bitrate", 8000) : null,
        ["startPositionSeconds"] = options.StartPositionSeconds,
        ["clientName"] = $"hlssim-{n}",
        ["mode"] = arguments.GetValueOrDefault("mode"),
        ["audioStreamIndex"] = arguments.ContainsKey("audio-index") ? (int)Double("audio-index", 0) : null,
        ["subtitleStreamIndex"] = arguments.ContainsKey("subtitle-index") ? (int)Double("subtitle-index", 0) : null,
        ["client"] = ClientProfile(),
    };
    var created = await http.PostAsJsonAsync("api/v1/transcoding/sessions", request);
    var session = await created.Content.ReadFromJsonAsync<JsonElement>();
    if (!created.IsSuccessStatusCode)
        throw new InvalidOperationException($"session create failed ({(int)created.StatusCode}): {session}");
    var playlistUrl = session.GetProperty("playlistUrl").GetString()!;
    if (!quiet)
    {
        var plan = session.GetProperty("plan");
        var target = plan.GetProperty("target");
        Console.WriteLine($"[{n}] session {session.GetProperty("handle")} mode={session.GetProperty("mode")}: {plan.GetProperty("encoder")} " +
                          $"codecs={target.GetProperty("codecs")} range={target.GetProperty("videoRange")} " +
                          $"hwDecode={plan.GetProperty("hardwareDecode")} hwEncode={plan.GetProperty("hardwareEncode")} " +
                          $"toneMap={plan.GetProperty("toneMap")} filters=\"{plan.GetProperty("videoFilters")}\"");
        foreach (var reason in plan.GetProperty("reasons").EnumerateArray())
            Console.WriteLine($"[{n}]   reason {reason.GetProperty("code")}: {reason.GetProperty("message")}");
        if (plan.TryGetProperty("keyframeIndex", out var index) && index.ValueKind == JsonValueKind.Object)
            Console.WriteLine($"[{n}]   keyframe index {index}");
        foreach (var subtitle in plan.GetProperty("subtitles").EnumerateArray())
            Console.WriteLine($"[{n}]   subtitle #{subtitle.GetProperty("index")} {subtitle.GetProperty("codec")} {subtitle.GetProperty("name")} → {subtitle.GetProperty("deliveredAs")}");
    }
    return (new Uri(server, playlistUrl), new Uri(server, playlistUrl[..playlistUrl.LastIndexOf('/')]));
}

void Print(int n, HlsSimReport r)
{
    Console.WriteLine();
    Console.WriteLine($"== player {n}: {(r.Passed ? "PASS" : "FAIL")} ==");
    Console.WriteLine(string.Create(CultureInfo.InvariantCulture,
        $"playlist {r.PlaylistSegments} × {r.SegmentLength:0.###}s = {r.PlaylistDuration:0.0}s, codecs {r.Codecs}"));
    Console.WriteLine(string.Create(CultureInfo.InvariantCulture,
        $"time to first segment {r.TimeToFirstSegmentMs:0} ms, fetched {r.Fetches.Count} segments ({r.TotalBytes / 1024d / 1024:0.0} MiB) in {r.WallSeconds:0.0}s"));
    Console.WriteLine(string.Create(CultureInfo.InvariantCulture,
        $"segment latency p50 {r.LatencyPercentile(50):0} ms · p95 {r.LatencyPercentile(95):0} ms · max {r.LatencyPercentile(100):0} ms"));
    if (r.SeekLatenciesMs.Count > 0)
        Console.WriteLine($"seek latency: {string.Join(", ", r.SeekLatenciesMs.Select(s => $"{s:0} ms"))}");
    Console.WriteLine(string.Create(CultureInfo.InvariantCulture, $"stalls {r.Stalls} ({r.StallSeconds:0.0}s)"));
    if (r.AudioRenditions > 0)
        Console.WriteLine($"audio: {r.AudioRenditions} rendition(s), {r.AudioSegments} segments");
    if (r.SubtitleRenditions > 0)
    {
        Console.WriteLine($"subtitles: {r.SubtitleRenditions} rendition(s), {r.SubtitleSegments} WebVTT segments, {r.SubtitleCues} cues");
        foreach (var sample in r.SubtitleSamples.Take(6))
            Console.WriteLine($"  cue {sample}");
    }
    foreach (var warning in r.Warnings.Take(10))
        Console.WriteLine($"  warn: {warning}");
    foreach (var error in r.Errors.Take(20))
        Console.WriteLine($"  ERROR: {error}");
}

Dictionary<string, object?>? ClientProfile()
{
    if (!new[] { "video-codecs", "audio-codecs", "containers", "max-channels", "ten-bit", "hdr-formats", "subtitle-formats" }.Any(arguments.ContainsKey))
        return null;
    static string[]? List(string? value) => value?.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    return new Dictionary<string, object?>
    {
        ["videoCodecs"] = List(arguments.GetValueOrDefault("video-codecs")),
        ["audioCodecs"] = List(arguments.GetValueOrDefault("audio-codecs")),
        ["containers"] = List(arguments.GetValueOrDefault("containers")),
        ["maxAudioChannels"] = arguments.ContainsKey("max-channels") ? (int)Double("max-channels", 2) : null,
        ["supports10Bit"] = arguments.ContainsKey("ten-bit"),
        ["supportsHdr"] = arguments.ContainsKey("hdr-formats"),
        ["hdrFormats"] = List(arguments.GetValueOrDefault("hdr-formats")),
        ["subtitleFormats"] = List(arguments.GetValueOrDefault("subtitle-formats")),
    };
}

double Double(string key, double fallback)
    => arguments.TryGetValue(key, out var raw) && double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var v) ? v : fallback;

static IReadOnlyList<SeekStep> ParseSeeks(string? value)
    => string.IsNullOrWhiteSpace(value)
        ? []
        : value.Split(',', StringSplitOptions.RemoveEmptyEntries).Select(pair =>
        {
            var parts = pair.Split(':');
            return new SeekStep(double.Parse(parts[0], CultureInfo.InvariantCulture), double.Parse(parts[1], CultureInfo.InvariantCulture));
        }).ToList();

static Dictionary<string, string> ParseArguments(string[] args)
{
    var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].StartsWith("--", StringComparison.Ordinal))
            continue;
        var key = args[i][2..];
        var hasValue = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal);
        result[key] = hasValue ? args[++i] : "true";
    }
    return result;
}
