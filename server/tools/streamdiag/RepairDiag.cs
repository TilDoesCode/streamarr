// Repair diagnostic harness: boots the REAL Core Server against the in-process mock
// NNTP server, publishes a release whose mid-file article STATs alive but BODYs 430,
// attaches a spec-shaped PAR2 set, then measures the full dynamic repair path:
// resolve -> linear stream over the hole (wait-at-hole) -> ranges around the hole ->
// artifact-cache re-resolve. Output is redacted: no message-ids, tokens or paths.

using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Streamarr.Core.Media;
using Streamarr.Server;
using Streamarr.Tests.Shared;

internal static class RepairDiag
{
    private const string ApiKey = "diag-api-key-0123456789abcdef0123456789abcdef";
    private const string AdminPassword = "diag-admin-password-0123456789";
    private const string ReleaseId = "diag-repairable";

    public static async Task Run(int mediaSeconds, int damagedArticles, int recoverySlices, bool hold = false)
    {
        if (mediaSeconds is < 60 or > 3_600)
            throw new ArgumentOutOfRangeException(nameof(mediaSeconds), "Use 60-3600 seconds so the damage stays beyond startup probing.");
        if (damagedArticles is < 1 or > 32)
            throw new ArgumentOutOfRangeException(nameof(damagedArticles), "Use 1-32 damaged articles.");
        if (recoverySlices < damagedArticles || recoverySlices > 256)
            throw new ArgumentOutOfRangeException(nameof(recoverySlices), "Recovery slices must cover the damaged articles and not exceed 256.");

        var sw = Stopwatch.StartNew();
        void Log(string message) => Console.WriteLine($"[{sw.Elapsed.TotalSeconds,7:F1}s] {message}");

        Log($"generating {mediaSeconds}s mkv via ffmpeg …");
        var video = await TestMediaFile.GenerateMkvAsync(mediaSeconds);
        Log($"media: {video.Length / 1048576.0:F1} MiB");

        await using var nntp = new MockNntpServer { RequireAuth = true };
        var tempDir = Directory.CreateTempSubdirectory("streamarr-repairdiag-").FullName;
        try
        {
            // --- publish the damaged release + PAR2 set -----------------------------
            var published = NzbTestFixtures.PublishFile(nntp, "video.mkv", video, "diag-repairable");
            var totalSegments = published.SegmentIds.Length;
            var firstDamaged = Math.Max(9, totalSegments * 3 / 5);
            var holes = new List<(long Start, long End)>();
            for (var d = 0; d < damagedArticles; d++)
            {
                var index = Math.Min(totalSegments - 1, firstDamaged + d * Math.Max(1, totalSegments / 16));
                nntp.Articles.TryRemove(published.SegmentIds[index], out _);
                nntp.StatOnlyArticles.TryAdd(published.SegmentIds[index], 0);
                holes.Add((index * 64_000L, Math.Min((index + 1) * 64_000L, video.Length)));
            }
            Log($"published {totalSegments} articles; {damagedArticles} damaged (STAT 223 / BODY 430), first hole at media byte {holes[0].Start}");

            var par2 = Par2TestWriter.Create([("video.mkv", video)], sliceSize: 65_536, recoverySliceCount: recoverySlices);
            var nzbFiles = new List<PublishedNzbFile> { published, NzbTestFixtures.PublishFile(nntp, "video.par2", par2.IndexBytes, "diag-par2idx") };
            for (var v = 0; v < par2.Volumes.Count; v++)
                nzbFiles.Add(NzbTestFixtures.PublishFile(nntp, par2.Volumes[v].Name, par2.Volumes[v].Bytes, $"diag-vol{v}"));
            var nzbPath = Path.Combine(tempDir, "repairable.nzb");
            File.WriteAllText(nzbPath, NzbTestFixtures.BuildNzbXml(nzbFiles.ToArray()));
            Log($"PAR2 set: slice=64KiB, recoverySlices={recoverySlices}, volumes={par2.Volumes.Count}");

            // --- boot the real server ----------------------------------------------
            var builder = WebApplication.CreateBuilder(new WebApplicationOptions { ApplicationName = "Streamarr.Server" });
            builder.WebHost.UseUrls("http://127.0.0.1:0");
            builder.Configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Serilog:MinimumLevel:Default"] = "Warning",
                ["Streamarr:ApiKey"] = ApiKey,
                ["Streamarr:Admin:Password"] = AdminPassword,
                ["Streamarr:ConnectionString"] = $"Data Source={Path.Combine(tempDir, "streamarr.db")}",
                ["Streamarr:DataProtectionKeysPath"] = Path.Combine(tempDir, "keys"),
                ["Streamarr:ConnectionBudget"] = "12",
                ["Streamarr:SessionTtlSeconds"] = "300",
                ["Streamarr:AllowLocalNzbFiles"] = "true",
                ["Streamarr:HealthCheck:SampleCount"] = "24",
                ["Streamarr:HealthCheck:StartupSampleCount"] = "8",
                ["Streamarr:Providers:0:Name"] = "mock",
                ["Streamarr:Providers:0:Host"] = nntp.Host,
                ["Streamarr:Providers:0:Port"] = nntp.Port.ToString(),
                ["Streamarr:Providers:0:UseSsl"] = "false",
                ["Streamarr:Providers:0:Username"] = nntp.Username,
                ["Streamarr:Providers:0:Password"] = nntp.Password,
                ["Streamarr:Providers:0:MaxConnections"] = "8",
                ["Streamarr:Repair:WorkspacePath"] = Path.Combine(tempDir, "repair"),
                ["Streamarr:Repair:MinFreeDiskBytes"] = "0",
                ["Streamarr:Repair:MaxConnections"] = "4",
                ["Streamarr:Repair:WaitAtHoleTimeoutSeconds"] = "120",
            });
            builder.AddStreamarrServer();
            await using var app = builder.Build();
            app.UseStreamarrServer();
            await app.StartAsync();
            var baseUrl = app.Urls.First().Replace("[::]", "127.0.0.1").Replace("0.0.0.0", "127.0.0.1");
            app.Services.GetRequiredService<IReleaseStore>().Register("diag-work", new Release
            {
                ReleaseId = ReleaseId,
                Title = "Diag.Repairable.1080p.WEB-DL.x264-DIAG",
                Indexer = "diag",
                SizeBytes = 0,
                Score = 900,
                NzbUrl = nzbPath,
            });
            Log("server up (mock NNTP, repair enabled)");

            using var client = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromMinutes(5) };
            client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", ApiKey);

            // --- 1) resolve ---------------------------------------------------------
            var resolveSw = Stopwatch.StartNew();
            var resolveResponse = await client.PostAsJsonAsync("/api/v1/resolve", new { releaseId = ReleaseId, client = "repairdiag" });
            resolveResponse.EnsureSuccessStatusCode();
            var resolved = await resolveResponse.Content.ReadFromJsonAsync<JsonElement>();
            var streamUrl = resolved.GetProperty("streamUrl").GetString()!;
            Log($"resolve: status={resolved.GetProperty("status").GetString()} in {resolveSw.ElapsedMilliseconds} ms (streamUrl redacted, {streamUrl.Length} chars)");

            // --- 2) linear read over the hole (wait-at-hole + swap) -----------------
            var linearSw = Stopwatch.StartNew();
            long stallMsAtHole = 0;
            long position = 0;
            var mismatchAt = -1L;
            using (var response = await client.GetAsync(streamUrl, HttpCompletionOption.ResponseHeadersRead))
            {
                if (response.StatusCode != HttpStatusCode.OK || response.Content.Headers.ContentLength != video.Length)
                    throw new InvalidOperationException($"linear GET: {(int)response.StatusCode}, length={response.Content.Headers.ContentLength}");
                await using var body = await response.Content.ReadAsStreamAsync();
                var buffer = new byte[256 * 1024];
                while (true)
                {
                    var readSw = Stopwatch.StartNew();
                    var n = await body.ReadAsync(buffer);
                    if (position < holes[0].Start + buffer.Length && position + n >= holes[0].Start)
                        stallMsAtHole = Math.Max(stallMsAtHole, readSw.ElapsedMilliseconds);
                    if (n == 0)
                        break;
                    if (mismatchAt < 0 && !buffer.AsSpan(0, n).SequenceEqual(video.AsSpan((int)position, n)))
                        mismatchAt = position;
                    position += n;
                }
            }
            Log($"linear stream: {position}/{video.Length} bytes in {linearSw.Elapsed.TotalSeconds:F1}s, " +
                $"byte-exact={(mismatchAt < 0 && position == video.Length ? "YES" : $"NO(@{mismatchAt})")}, " +
                $"max stall at hole={stallMsAtHole} ms");
            if (mismatchAt >= 0 || position != video.Length)
                throw new InvalidOperationException("linear stream was not byte-exact — repair did NOT succeed");

            // --- 3) range around the hole ------------------------------------------
            var from = Math.Max(0, holes[0].Start - 1_048_576);
            var to = Math.Min(video.Length - 1, holes[0].End + 1_048_576 - 1);
            await VerifyRange(client, streamUrl, video, from, to, Log, "range across hole (±1 MiB)");
            await VerifyRange(client, streamUrl, video, video.Length - 262_144, video.Length - 1, Log, "tail range");

            // --- 4) artifact-cache re-resolve --------------------------------------
            var secondResolve = await client.PostAsJsonAsync("/api/v1/resolve", new { releaseId = ReleaseId, client = "repairdiag" });
            var second = await secondResolve.Content.ReadFromJsonAsync<JsonElement>();
            Log($"re-resolve: status={second.GetProperty("status").GetString()} originHealth={Get(second, "originHealth")} playability={Get(second, "playability")}");

            // --- 5) job accounting (admin surface, redacted by design) --------------
            using var admin = new HttpClient { BaseAddress = new Uri(baseUrl), Timeout = TimeSpan.FromMinutes(1) };
            var login = await admin.PostAsJsonAsync("/api/v1/auth/login", new { username = "admin", password = AdminPassword });
            login.EnsureSuccessStatusCode();
            var token = (await login.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString();
            admin.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);
            var overview = await admin.GetFromJsonAsync<JsonElement>("/api/v1/repairs");
            foreach (var job in overview.GetProperty("jobs").EnumerateArray())
            {
                Log($"job: state={job.GetProperty("state").GetString()} disposition={job.GetProperty("disposition").GetString()} " +
                    $"damagedBlocks={job.GetProperty("damagedBlocks").GetInt32()} recoveryUsed={job.GetProperty("recoveryBlocksUsed").GetInt32()} " +
                    $"sourceMiB={job.GetProperty("sourceBytesDownloaded").GetInt64() / 1048576.0:F1} parityMiB={job.GetProperty("parityBytesDownloaded").GetInt64() / 1048576.0:F2}");
                foreach (var e in job.GetProperty("events").EnumerateArray())
                    Log($"  event: [{e.GetProperty("state").GetString()}] {e.GetProperty("message").GetString()}");
            }
            var workspaceBytes = DirectorySize(Path.Combine(tempDir, "repair"));
            Log($"cache: used={overview.GetProperty("cacheBytesUsed").GetInt64() / 1048576.0:F1} MiB, workspace on disk={workspaceBytes / 1048576.0:F1} MiB");
            using var self = Process.GetCurrentProcess();
            var peak = Math.Max(self.PeakWorkingSet64, self.WorkingSet64);
            Log($"process RSS={peak / 1048576.0:F0} MiB, mock NNTP maxConns={nntp.MaxObservedConnections}");
            Log("repair diag PASSED");
            if (hold)
            {
                Log($"holding the server at {baseUrl} for interactive inspection (Ctrl+C to stop) …");
                Log($"admin login: user 'admin', password '{AdminPassword}' (diag-only credentials)");
                using var stop = new CancellationTokenSource();
                ConsoleCancelEventHandler cancel = (_, e) =>
                {
                    e.Cancel = true;
                    stop.Cancel();
                };
                Console.CancelKeyPress += cancel;
                try
                {
                    await Task.Delay(Timeout.InfiniteTimeSpan, stop.Token);
                }
                catch (OperationCanceledException) when (stop.IsCancellationRequested)
                {
                }
                finally
                {
                    Console.CancelKeyPress -= cancel;
                }
            }
            await app.StopAsync();
        }
        finally
        {
            try { Directory.Delete(tempDir, recursive: true); } catch { /* diag cleanup is best-effort */ }
        }
    }

    private static async Task VerifyRange(
        HttpClient client, string streamUrl, byte[] video, long from, long to,
        Action<string> log, string label)
    {
        var sw = Stopwatch.StartNew();
        using var request = new HttpRequestMessage(HttpMethod.Get, streamUrl);
        request.Headers.Range = new RangeHeaderValue(from, to);
        using var response = await client.SendAsync(request);
        var bytes = await response.Content.ReadAsByteArrayAsync();
        var ok = response.StatusCode == HttpStatusCode.PartialContent
                 && bytes.AsSpan().SequenceEqual(video.AsSpan((int)from, (int)(to - from + 1)));
        log($"{label}: bytes {from}-{to} -> {(int)response.StatusCode}, byte-exact={(ok ? "YES" : "NO")}, {sw.ElapsedMilliseconds} ms");
        if (!ok)
            throw new InvalidOperationException($"{label} failed");
    }

    private static string Get(JsonElement element, string name)
        => element.TryGetProperty(name, out var value) ? value.ToString() : "-";

    private static long DirectorySize(string path)
        => Directory.Exists(path)
            ? Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length)
            : 0;
}
