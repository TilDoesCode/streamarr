using System.Diagnostics;
using System.Globalization;

namespace Streamarr.Server.Transcoding;

public sealed record FfmpegRunResult(
    int ExitCode,
    bool TimedOut,
    TimeSpan Elapsed,
    TimeSpan CpuTime,
    long Frames,
    double OutSeconds,
    string StandardErrorTail);

/// <summary>Runs one bounded ffmpeg command to completion while streaming <c>-progress</c> updates (samples and benchmarks).</summary>
public static class FfmpegRun
{
    public static async Task<FfmpegRunResult> ExecuteAsync(
        string ffmpegPath,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        Action<double, double>? onProgress,
        CancellationToken ct)
    {
        var psi = new ProcessStartInfo(ffmpegPath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        FfmpegEnvironment.Apply(psi);
        foreach (var argument in arguments)
            psi.ArgumentList.Add(argument);

        using var process = new Process { StartInfo = psi };
        var watch = Stopwatch.StartNew();
        process.Start();
        long frames = 0;
        double outSeconds = 0, speed = 0;
        var stderr = new List<string>();

        var progress = Task.Run(async () =>
        {
            string? line;
            while ((line = await process.StandardOutput.ReadLineAsync()) is not null)
            {
                var separator = line.IndexOf('=');
                if (separator <= 0)
                    continue;
                var value = line[(separator + 1)..].Trim();
                switch (line[..separator])
                {
                    case "frame" when long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var f):
                        frames = f;
                        break;
                    case "out_time_us" when long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var us) && us > 0:
                        outSeconds = us / 1_000_000d;
                        break;
                    case "speed" when double.TryParse(value.TrimEnd('x'), NumberStyles.Float, CultureInfo.InvariantCulture, out var s):
                        speed = s;
                        break;
                    case "progress":
                        onProgress?.Invoke(outSeconds, speed);
                        break;
                }
            }
        }, CancellationToken.None);
        var errors = Task.Run(async () =>
        {
            string? line;
            while ((line = await process.StandardError.ReadLineAsync()) is not null)
            {
                lock (stderr)
                {
                    stderr.Add(line);
                    if (stderr.Count > 200)
                        stderr.RemoveAt(0);
                }
            }
        }, CancellationToken.None);

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        linked.CancelAfter(timeout);
        var cpu = TimeSpan.Zero;
        var timedOut = false;
        try
        {
            while (!process.HasExited)
            {
                cpu = ProcessRunner.SampleCpu(process, cpu);
                var exit = process.WaitForExitAsync(linked.Token);
                if (await Task.WhenAny(exit, Task.Delay(250, linked.Token)) == exit)
                    await exit;
            }
        }
        catch (OperationCanceledException)
        {
            timedOut = !ct.IsCancellationRequested;
            ProcessRunner.Kill(process);
            await process.WaitForExitAsync(CancellationToken.None);
            if (!timedOut)
                throw;
        }

        await Task.WhenAll(progress, errors).WaitAsync(TimeSpan.FromSeconds(5)).ContinueWith(_ => { }, TaskScheduler.Default);
        watch.Stop();
        string tail;
        lock (stderr)
            tail = TranscodeRedaction.Tail(string.Join('\n', stderr), 12);
        return new FfmpegRunResult(process.ExitCode, timedOut, watch.Elapsed, cpu, frames, outSeconds, tail);
    }
}
