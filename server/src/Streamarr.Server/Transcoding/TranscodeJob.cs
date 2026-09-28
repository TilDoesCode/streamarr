using System.Diagnostics;
using System.Globalization;

namespace Streamarr.Server.Transcoding;

/// <summary>One running ffmpeg process producing HLS segments from <see cref="StartSegment"/> onwards.</summary>
public sealed class TranscodeJob
{
    private const int MaxLogLines = 80;

    private readonly Process _process;
    private readonly string _directory;
    private readonly Queue<string> _log = new();
    private readonly object _logLock = new();
    private readonly TaskCompletionSource _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _front;
    private TimeSpan _cpu;
    private int _paused;
    private int _killed;
    private int _pid;
    private Task _pumps = Task.CompletedTask;

    private TranscodeJob(Process process, string directory, string tag, int startSegment, IReadOnlyList<string> arguments, DateTimeOffset startedAt)
    {
        _process = process;
        _directory = directory;
        Tag = tag;
        StartSegment = startSegment;
        Arguments = arguments;
        StartedAt = startedAt;
        StartedAtUtc = startedAt.UtcDateTime;
        _front = startSegment;
    }

    public string Tag { get; }
    public int StartSegment { get; }
    public IReadOnlyList<string> Arguments { get; }
    public DateTimeOffset StartedAt { get; }
    private DateTime StartedAtUtc { get; }
    public int ProcessId => _pid;
    public double Fps { get; private set; }
    public double Speed { get; private set; }
    public long Frames { get; private set; }
    public bool Paused => Volatile.Read(ref _paused) == 1;
    public bool Killed => Volatile.Read(ref _killed) == 1;
    public bool HasExited => _exited.Task.IsCompleted;
    public int? ExitCode { get; private set; }
    public DateTimeOffset? ExitedAt { get; private set; }
    public DateTimeOffset? FirstSegmentAt { get; private set; }
    public TimeSpan CpuTime => _cpu;
    public Task Exited => _exited.Task;
    public string InitFileName => $"init-{Tag}.mp4";

    public bool Failed => HasExited && !Killed && ExitCode is not 0;

    public static TranscodeJob Start(string ffmpegPath, IReadOnlyList<string> arguments, string directory, string tag, int startSegment)
    {
        var psi = new ProcessStartInfo(ffmpegPath)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            WorkingDirectory = directory,
        };
        FfmpegEnvironment.Apply(psi);
        foreach (var argument in arguments)
            psi.ArgumentList.Add(argument);

        var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        var job = new TranscodeJob(process, directory, tag, startSegment, TranscodeRedaction.RedactArguments(arguments), DateTimeOffset.UtcNow);
        process.Start();
        job._pid = process.Id;
        job._pumps = Task.WhenAll(job.PumpProgressAsync(), job.PumpLogAsync());
        _ = job.WatchExitAsync();
        return job;
    }

    /// <summary>First segment index at or after <see cref="StartSegment"/> this run has not yet finished.</summary>
    public int Front()
    {
        var front = Volatile.Read(ref _front);
        while (ProducedByThisRun(front))
            front++;
        if (front > StartSegment && FirstSegmentAt is null)
            FirstSegmentAt = new DateTimeOffset(File.GetLastWriteTimeUtc(Path.Combine(_directory, $"{StartSegment}.m4s")), TimeSpan.Zero);
        Volatile.Write(ref _front, front);
        return front;
    }

    public bool ProducedByThisRun(int segment)
    {
        var info = new FileInfo(Path.Combine(_directory, $"{segment}.m4s"));
        return info.Exists && info.LastWriteTimeUtc >= StartedAtUtc.AddMilliseconds(-5);
    }

    public bool InitReady()
    {
        var init = new FileInfo(Path.Combine(_directory, InitFileName));
        return init.Exists && init.Length > 0 && (ProducedByThisRun(StartSegment) || HasExited);
    }

    public bool Pause()
    {
        if (HasExited || !ProcessSignals.IsSupported || Interlocked.CompareExchange(ref _paused, 1, 0) != 0)
            return false;
        if (ProcessSignals.Pause(_pid))
            return true;
        Volatile.Write(ref _paused, 0);
        return false;
    }

    public bool Resume()
    {
        if (Interlocked.CompareExchange(ref _paused, 0, 1) != 1)
            return false;
        return HasExited || ProcessSignals.Resume(_pid);
    }

    public void SampleCpu() => _cpu = ProcessRunner.SampleCpu(_process, _cpu);

    public async Task KillAsync()
    {
        Interlocked.Exchange(ref _killed, 1);
        ProcessRunner.Kill(_process);
        try
        {
            await _exited.Task.WaitAsync(TimeSpan.FromSeconds(10));
        }
        catch (TimeoutException)
        {
        }
        foreach (var partial in Directory.Exists(_directory) ? Directory.GetFiles(_directory, "*.tmp") : [])
        {
            try
            {
                File.Delete(partial);
            }
            catch (IOException)
            {
            }
        }
    }

    public IReadOnlyList<string> LogTail(int max = 20)
    {
        lock (_logLock)
            return _log.TakeLast(max).ToList();
    }

    public string ErrorSummary()
    {
        var tail = LogTail(6);
        return tail.Count == 0 ? $"ffmpeg exited with code {ExitCode}." : string.Join('\n', tail);
    }

    private async Task PumpProgressAsync()
    {
        try
        {
            string? line;
            while ((line = await _process.StandardOutput.ReadLineAsync()) is not null)
            {
                var separator = line.IndexOf('=');
                if (separator <= 0)
                    continue;
                var key = line[..separator];
                var value = line[(separator + 1)..].Trim();
                switch (key)
                {
                    case "fps" when double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out var fps):
                        Fps = fps;
                        break;
                    case "frame" when long.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out var frame):
                        Frames = frame;
                        break;
                    case "speed" when double.TryParse(value.TrimEnd('x'), NumberStyles.Float, CultureInfo.InvariantCulture, out var speed):
                        Speed = speed;
                        break;
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private async Task PumpLogAsync()
    {
        try
        {
            string? line;
            while ((line = await _process.StandardError.ReadLineAsync()) is not null)
            {
                if (line.Length == 0)
                    continue;
                var redacted = TranscodeRedaction.Redact(line.Length > 500 ? line[..500] : line);
                lock (_logLock)
                {
                    if (_log.Count > 0 && _log.Last() == redacted)
                        continue;
                    _log.Enqueue(redacted);
                    while (_log.Count > MaxLogLines)
                        _log.Dequeue();
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    private async Task WatchExitAsync()
    {
        try
        {
            await _process.WaitForExitAsync();
            ExitCode = _process.ExitCode;
            await _pumps.WaitAsync(TimeSpan.FromSeconds(3)).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            ExitCode ??= -1;
        }
        finally
        {
            ExitedAt = DateTimeOffset.UtcNow;
            Volatile.Write(ref _paused, 0);
            _exited.TrySetResult();
            _process.Dispose();
        }
    }
}
