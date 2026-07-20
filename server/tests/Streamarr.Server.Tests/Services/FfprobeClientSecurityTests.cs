using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Streamarr.Server.Contracts;
using Streamarr.Server.Options;
using Streamarr.Server.Services;

namespace Streamarr.Server.Tests.Services;

public sealed class FfprobeClientSecurityTests
{
    [Fact]
    public async Task BoundedReader_AllowsExactLimit_AndRejectsOneByteMore()
    {
        var exact = new MemoryStream(Encoding.UTF8.GetBytes(new string('a', 64)));
        Assert.Equal(
            new string('a', 64),
            await FfprobeClient.ReadBoundedTextAsync(exact, 64, CancellationToken.None));

        var killed = false;
        var oversized = new MemoryStream(Encoding.UTF8.GetBytes(new string('b', 65)));
        await Assert.ThrowsAsync<InvalidDataException>(() =>
            FfprobeClient.ReadBoundedTextAsync(
                oversized,
                64,
                CancellationToken.None,
                () => killed = true));
        Assert.True(killed);
    }

    [Fact]
    public void Parse_BoundsStreamCountAndRejectsInvalidScalarValues()
    {
        var streams = string.Join(',', Enumerable.Range(0, FfprobeClient.MaxMediaStreams + 10)
            .Select(_ => "{\"codec_type\":\"video\",\"codec_name\":\"h264\",\"width\":999999}"));
        var result = FfprobeClient.Parse($"{{\"format\":{{\"duration\":\"NaN\"}},\"streams\":[{streams}]}}");

        Assert.Null(result.RunTimeTicks);
        Assert.Equal(FfprobeClient.MaxMediaStreams, result.MediaStreams.Count);
        Assert.All(result.MediaStreams, stream => Assert.Null(stream.Width));
    }

    [Fact]
    public void StartInfo_AppliesBoundedProbeBudgets_AndKeepsCapabilityLiteral()
    {
        const string capability = "http://127.0.0.1:1234/api/v1/stream/token?x=$(ignored)";
        var startInfo = FfprobeClient.CreateStartInfo("ffprobe", capability, 1_048_576, 2_000);

        Assert.Contains("1048576", startInfo.ArgumentList);
        Assert.Contains("2000000", startInfo.ArgumentList);
        Assert.Equal(capability, startInfo.ArgumentList[startInfo.ArgumentList.Count - 1]);
        Assert.False(startInfo.UseShellExecute);
    }

    [Fact]
    public async Task FastProbe_WithStreamsButNoRuntime_Escalates()
    {
        var partial = Result(runTimeTicks: null);
        var complete = Result(TimeSpan.FromMinutes(90).Ticks);
        var client = new ScriptedFfprobeClient(
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions()),
            (call, _) => Task.FromResult<FfprobeResult?>(call == 1 ? partial : complete));

        var result = await client.ProbeAsync("http://127.0.0.1/stream", CancellationToken.None);

        Assert.Same(complete, result);
        Assert.Equal(2, client.Calls);
        Assert.False(FfprobeClient.IsCompleteFastResult(partial));
        Assert.True(FfprobeClient.IsCompleteFastResult(complete));
    }

    [Fact]
    public async Task ProcessTimeout_StartsAfterWaitingForTheConcurrencyGate()
    {
        var firstEntered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var client = new ScriptedFfprobeClient(
            Microsoft.Extensions.Options.Options.Create(new StreamarrOptions
            {
                FfprobeTimeoutSeconds = 1,
                MaxConcurrentFfprobe = 1,
            }),
            async (call, ct) =>
            {
                if (call == 1)
                    firstEntered.TrySetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, ct);
                return null;
            });

        var first = client.ProbeAsync("http://127.0.0.1/first", CancellationToken.None);
        await firstEntered.Task.WaitAsync(TimeSpan.FromSeconds(1));
        var second = client.ProbeAsync("http://127.0.0.1/second", CancellationToken.None);

        var results = await Task.WhenAll(first, second).WaitAsync(TimeSpan.FromSeconds(5));

        Assert.All(results, Assert.Null);
        Assert.Equal(2, client.Calls);
    }

    private static FfprobeResult Result(long? runTimeTicks) => new()
    {
        RunTimeTicks = runTimeTicks,
        MediaStreams = [new MediaStreamInfo { Type = "Video", Codec = "h264" }],
    };

    private sealed class ScriptedFfprobeClient : FfprobeClient
    {
        private readonly Func<int, CancellationToken, Task<FfprobeResult?>> _run;
        private int _calls;

        public ScriptedFfprobeClient(
            IOptions<StreamarrOptions> options,
            Func<int, CancellationToken, Task<FfprobeResult?>> run)
            : base(options, NullLogger<FfprobeClient>.Instance)
        {
            _run = run;
        }

        public int Calls => Volatile.Read(ref _calls);

        protected override async Task<FfprobeResult?> ProbeCoreAsync(
            string url,
            int probeSizeBytes,
            int analyzeDurationMs,
            CancellationToken ct)
        {
            var call = Interlocked.Increment(ref _calls);
            return await _run(call, ct);
        }
    }
}
