using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Tests.Nntp;

public class SegmentIdSecurityTests
{
    [Theory]
    [InlineData("valid.part@example.test", "valid.part@example.test")]
    [InlineData("<valid.part@example.test>", "valid.part@example.test")]
    public void ValidMessageIds_AreNormalized(string input, string expected)
        => Assert.Equal(expected, new SegmentId(input).ToString());

    [Theory]
    [InlineData("safe@example.test>\r\nDATE")]
    [InlineData("safe@example.test BODY")]
    [InlineData("safe@example.test><evil@example.test")]
    [InlineData("two@@example.test")]
    [InlineData("missing-at")]
    [InlineData("")]
    public void UnsafeMessageIds_AreRejectedBeforeAnyCommand(string input)
        => Assert.Throws<ArgumentException>(() => new SegmentId(input));
}
