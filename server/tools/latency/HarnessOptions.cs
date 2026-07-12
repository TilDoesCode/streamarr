namespace Streamarr.Tools.Latency;

/// <summary>Which NNTP target the harness measures against.</summary>
public enum TargetMode
{
    /// <summary>In-repo mock NNTP server + canned yEnc/NZB fixtures (default, CI-safe).</summary>
    Mock,

    /// <summary>Real Usenet provider(s) from appsettings.Local.json (owner-supplied creds).</summary>
    Real,
}

/// <summary>Parsed command-line + config knobs for a harness run.</summary>
public sealed record HarnessOptions
{
    public TargetMode Mode { get; init; } = TargetMode.Mock;
    public int Iterations { get; init; } = 8;
    public int SeekWarmup { get; init; } = 1;
    public double SeekOffsetFraction { get; init; } = 0.7;

    /// <summary>Emit the measured table as a Markdown snippet (for docs/m1-latency.md).</summary>
    public bool Markdown { get; init; }

    /// <summary>
    /// Run the end-to-end smoke instead of the latency measurement: ffprobe the
    /// stream URL, then a scripted mpv/ffplay play + seek (SKIP if not installed).
    /// </summary>
    public bool Smoke { get; init; }

    public static HarnessOptions FromArgs(string[] args, HarnessOptions defaults)
    {
        var opts = defaults;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--mode":
                    opts = opts with { Mode = ParseMode(Next(args, ref i)) };
                    break;
                case "--iterations" or "-n":
                    opts = opts with { Iterations = int.Parse(Next(args, ref i)) };
                    break;
                case "--seek-warmup":
                    opts = opts with { SeekWarmup = int.Parse(Next(args, ref i)) };
                    break;
                case "--seek-offset":
                    opts = opts with { SeekOffsetFraction = double.Parse(Next(args, ref i)) };
                    break;
                case "--markdown" or "--md":
                    opts = opts with { Markdown = true };
                    break;
                case "--smoke":
                    opts = opts with { Smoke = true };
                    break;
                case "--help" or "-h":
                    throw new HelpRequested();
                default:
                    throw new ArgumentException($"Unknown argument: {args[i]}");
            }
        }

        if (opts.Iterations < 1)
            throw new ArgumentException("--iterations must be >= 1");
        if (opts.SeekOffsetFraction is <= 0 or >= 1)
            throw new ArgumentException("--seek-offset must be in (0, 1)");

        return opts;
    }

    private static TargetMode ParseMode(string value) => value.ToLowerInvariant() switch
    {
        "mock" => TargetMode.Mock,
        "real" => TargetMode.Real,
        _ => throw new ArgumentException($"--mode must be 'mock' or 'real', got '{value}'"),
    };

    private static string Next(string[] args, ref int i)
    {
        if (i + 1 >= args.Length)
            throw new ArgumentException($"Missing value after {args[i]}");
        return args[++i];
    }

    public const string Usage = """
        Streamarr latency harness — cold-start + seek latency (BRIEF §10 M1 acceptance).

        Usage: dotnet run --project server/tools/latency -- [options]

          --mode <mock|real>    Target. mock (default) = in-repo mock NNTP + fixtures.
                                real = provider(s) from appsettings.Local.json.
          --iterations, -n <N>  Samples per metric (default 8).
          --seek-warmup <N>     Discarded warm-up seeks before timing (default 1).
          --seek-offset <F>     Seek offset as a fraction of file size (default 0.70).
          --markdown, --md      Also print a Markdown table (paste into docs/m1-latency.md).
          --smoke               End-to-end smoke instead of measurement: ffprobe the
                                stream + scripted mpv/ffplay play + seek (SKIP if absent).
          --help, -h            Show this help.
        """;
}

/// <summary>Sentinel thrown when --help is requested so Program can print usage and exit 0.</summary>
public sealed class HelpRequested : Exception;
