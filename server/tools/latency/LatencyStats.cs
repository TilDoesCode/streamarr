using System.Globalization;

namespace Streamarr.Tools.Latency;

/// <summary>Summary statistics for one metric's sampled latencies (milliseconds).</summary>
public sealed record LatencyStats
{
    public required string Metric { get; init; }
    public required IReadOnlyList<double> SamplesMs { get; init; }

    public int Count => SamplesMs.Count;
    public double MinMs => SamplesMs.Min();
    public double MaxMs => SamplesMs.Max();
    public double MeanMs => SamplesMs.Average();
    public double MedianMs => Percentile(50);
    public double P95Ms => Percentile(95);

    /// <summary>Linear-interpolated percentile over the samples (0–100).</summary>
    public double Percentile(double p)
    {
        var sorted = SamplesMs.OrderBy(x => x).ToArray();
        if (sorted.Length == 1)
            return sorted[0];

        var rank = p / 100.0 * (sorted.Length - 1);
        var lo = (int)Math.Floor(rank);
        var hi = (int)Math.Ceiling(rank);
        if (lo == hi)
            return sorted[lo];

        var frac = rank - lo;
        return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
    }

    public static LatencyStats Of(string metric, IEnumerable<double> samplesMs)
        => new() { Metric = metric, SamplesMs = samplesMs.ToArray() };

    private static string F(double ms) => ms.ToString("0.0", CultureInfo.InvariantCulture);

    /// <summary>One aligned console line: metric, n, min, median, p95, max, mean.</summary>
    public string ToConsoleRow() =>
        $"  {Metric,-14} n={Count,-3} " +
        $"min={F(MinMs),7}  median={F(MedianMs),7}  p95={F(P95Ms),7}  max={F(MaxMs),7}  mean={F(MeanMs),7}  (ms)";

    /// <summary>One Markdown table row for docs/m1-latency.md.</summary>
    public string ToMarkdownRow() =>
        $"| {Metric} | {Count} | {F(MinMs)} | {F(MedianMs)} | {F(P95Ms)} | {F(MaxMs)} | {F(MeanMs)} |";

    public static string MarkdownHeader =>
        "| Metric | n | min | median | p95 | max | mean |\n" +
        "|---|---|---|---|---|---|---|";
}
