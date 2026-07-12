using Microsoft.Extensions.Configuration;
using Streamarr.Tools.Latency;

// Load appsettings[.Local].json from the output dir (copied there by the build) so
// the same config drives both defaults and the booted server.
var config = new ConfigurationBuilder()
    .SetBasePath(AppContext.BaseDirectory)
    .AddJsonFile("appsettings.json", optional: true)
    .AddJsonFile("appsettings.Local.json", optional: true)
    .AddEnvironmentVariables()
    .Build();

var defaults = new HarnessOptions
{
    Iterations = config.GetValue("Latency:Iterations", 8),
    SeekWarmup = config.GetValue("Latency:SeekWarmup", 1),
    SeekOffsetFraction = config.GetValue("Latency:SeekOffsetFraction", 0.7),
};

HarnessOptions options;
try
{
    options = HarnessOptions.FromArgs(args, defaults);
}
catch (HelpRequested)
{
    Console.WriteLine(HarnessOptions.Usage);
    return 0;
}
catch (ArgumentException ex)
{
    Console.Error.WriteLine($"error: {ex.Message}");
    Console.Error.WriteLine();
    Console.Error.WriteLine(HarnessOptions.Usage);
    return 2;
}

Console.WriteLine("Streamarr latency harness — M1 acceptance (BRIEF §10)");
Console.WriteLine("=====================================================");

await using var harness = new LatencyHarness(options, config);
try
{
    return options.Smoke
        ? await harness.RunSmokeAsync()
        : await harness.RunAsync();
}
catch (Exception ex)
{
    Console.Error.WriteLine($"harness failed: {ex.Message}");
    return 1;
}
