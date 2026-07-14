using System.Text;
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
}
