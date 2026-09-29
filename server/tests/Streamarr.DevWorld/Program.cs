using System.Diagnostics;
using System.Text.Json;
using Streamarr.DevWorld;
using Streamarr.Tests.Shared;

// Dev World launcher (dev/test only, never shipped): real Core Server + mock Usenet + canned indexer/TMDB; see README.md.

var total = Stopwatch.StartNew();
var options = DevWorldOptions.FromEnvironment(args);
void Log(string message) => Console.WriteLine($"[devworld] {message}");

Log($"catalog {options.CatalogPath}");
Log($"cache   {options.CacheDir}");
var plan = WorldPlan.Build(DevCatalog.Load(options.CatalogPath));
Log($"{plan.Releases.Count} releases over {plan.Media.Count} media files; generating missing media ({options.GenerateJobs} jobs)");

var mediaWatch = Stopwatch.StartNew();
var media = await new MediaGenerator(options, Log).EnsureAsync(plan.Media, CancellationToken.None);
mediaWatch.Stop();
var generated = media.Values.Count(m => !m.Reused);
var payloadBytes = media.Values.Sum(m => m.SizeBytes);
Log($"media ready in {mediaWatch.Elapsed.TotalSeconds:0.0}s: {generated} generated, {media.Count - generated} reused, {payloadBytes / 1024.0 / 1024.0:0.0} MiB total ({payloadBytes:N0} bytes)");
if (options.GenerateOnly)
    return;

// Fresh world on every boot: accounts, watch state and caches start from the seed.
if (Directory.Exists(options.StateDir))
    Directory.Delete(options.StateDir, recursive: true);
Directory.CreateDirectory(options.StateDir);

var store = new PublicationStore(plan, media, Path.Combine(options.StateDir, "nzb"), plan.Catalog.Defaults.PartSizeBytes);
var nntp = DevWorldHost.CreateNntp(store);

var state = new DevWorldState();
var app = DevWorldHost.Build(options, plan, store, nntp, state, args);
await app.StartAsync();
var bootSeconds = total.Elapsed.TotalSeconds;

var viewers = await WorldSeeder.SeedViewersAsync(app.Services, CancellationToken.None);
foreach (var viewer in viewers.Where(v => v.TotpSecret is not null))
    state.TotpSecrets[viewer.Username] = viewer.TotpSecret!;
var ranks = await WorldSeeder.WarmUpAsync(app.Services, store, CancellationToken.None);
if (options.CheckReleases)
{
    var checks = await WorldSeeder.CheckReleasesAsync(app.Services, store, options.LocalUrl, CancellationToken.None);
    var failed = checks.Where(c => !c.Passed).ToList();
    Log($"release check: {checks.Count - failed.Count}/{checks.Count} release/work pairs resolved as designed in {checks.Sum(c => c.Seconds):0.0}s (slowest {checks.Max(c => c.Seconds):0.0}s)");
    if (failed.Count > 0)
        throw new InvalidOperationException("Dev World release check failed:\n  " + string.Join("\n  ",
            failed.Select(c => $"{c.Name} for {c.WorkId}: designed {c.Designed}, resolved {c.Actual} after {c.Seconds:0.0}s")));
}

object? snapshot = null;
if (options.SnapshotInfoPath is { } snapshotPath && File.Exists(snapshotPath))
    snapshot = JsonSerializer.Deserialize<JsonElement>(await File.ReadAllTextAsync(snapshotPath));

var timings = new
{
    mediaSeconds = Math.Round(mediaWatch.Elapsed.TotalSeconds, 1),
    generatedFiles = generated,
    reusedFiles = media.Count - generated,
    payloadBytes,
    serverStartedAfterSeconds = Math.Round(bootSeconds, 1),
    readyAfterSeconds = Math.Round(total.Elapsed.TotalSeconds, 1),
};
var manifest = JsonSerializer.Serialize(
    WorldSeeder.BuildManifest(options, plan, store, media, viewers, ranks, timings, snapshot), DevCatalog.Json);
await WriteAtomicAsync(Path.Combine(options.CacheDir, $"devworld-{options.Port}.json"), manifest);
if (options.WritePrimaryManifest)
    await WriteAtomicAsync(Path.Combine(options.CacheDir, "devworld.json"), manifest);
state.MarkReady(manifest);

PrintBanner();
await app.WaitForShutdownAsync();
await app.DisposeAsync();
await nntp.DisposeAsync();
store.Dispose();
return;

static async Task WriteAtomicAsync(string path, string content)
{
    var tmp = $"{path}.{Guid.NewGuid():N}.tmp";
    await File.WriteAllTextAsync(tmp, content);
    File.Move(tmp, path, overwrite: true);
}

void PrintBanner()
{
    var line = new string('=', 78);
    Console.WriteLine(line);
    Console.WriteLine($" Streamarr Dev World ready on {options.LocalUrl}  (Android emulator: {options.AndroidEmulatorUrl})");
    Console.WriteLine($" ready after {total.Elapsed.TotalSeconds:0.0}s; media {mediaWatch.Elapsed.TotalSeconds:0.0}s ({generated} generated), payload {payloadBytes / 1024.0 / 1024.0:0.0} MiB");
    Console.WriteLine($" admin:   {WorldSeeder.AdminUsername} / {WorldSeeder.AdminPassword}   API key: {WorldSeeder.ApiKey}");
    Console.WriteLine($" viewers (password '{WorldSeeder.ViewerPassword}'):");
    foreach (var v in viewers)
        Console.WriteLine($"   {v.Username,-5} {v.Purpose}");
    Console.WriteLine($"   ben TOTP secret {WorldSeeder.BenTotpSecret}; current code: curl {options.LocalUrl}/devworld/totp/ben");
    Console.WriteLine($"   ben recovery codes: ben-recovery-01 .. ben-recovery-10; email codes: curl {options.LocalUrl}/devworld/outbox");
    Console.WriteLine($" titles: {string.Join(", ", plan.Catalog.Movies.Select(m => m.Title).Concat(plan.Catalog.Series.Select(s => s.Title)))}");
    Console.WriteLine($" manifest: {Path.Combine(options.CacheDir, options.WritePrimaryManifest ? "devworld.json" : $"devworld-{options.Port}.json")}  ({options.LocalUrl}/devworld.json)");
    Console.WriteLine(line);
    Console.WriteLine("[devworld] ready");
}
