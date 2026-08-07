using Streamarr.Usenet.Par2;

namespace Streamarr.Usenet.Tests.Par2;

public class GaloisField16Tests
{
    [Fact]
    public void InputConstants_MatchThePar2Specification()
    {
        // 2^n for n coprime to {3, 5, 17, 257}: n = 1, 2, 4, 7, 8, 11, 13, 14 ...
        Assert.Equal(2, GaloisField16.InputConstant(0));
        Assert.Equal(4, GaloisField16.InputConstant(1));
        Assert.Equal(16, GaloisField16.InputConstant(2));
        Assert.Equal(128, GaloisField16.InputConstant(3));
        Assert.Equal(256, GaloisField16.InputConstant(4));
        Assert.Equal(2048, GaloisField16.InputConstant(5));
        Assert.Equal(8192, GaloisField16.InputConstant(6));
        Assert.Equal(16384, GaloisField16.InputConstant(7));
        var constants = GaloisField16.InputConstants.ToArray();
        Assert.Equal(32768, constants.Length);
        Assert.Equal(constants.Length, constants.Distinct().Count());
    }

    [Fact]
    public void MultiplyAndDivide_RoundTrip()
    {
        var random = new Random(42);
        for (var i = 0; i < 10_000; i++)
        {
            var a = (ushort)random.Next(1, 65536);
            var b = (ushort)random.Next(1, 65536);
            var product = GaloisField16.Multiply(a, b);
            Assert.Equal(a, GaloisField16.Divide(product, b));
            Assert.Equal(product, GaloisField16.Multiply(b, a));
        }
        Assert.Equal(0, GaloisField16.Multiply(0, 123));
        Assert.Equal(0, GaloisField16.Multiply(123, 0));
        Assert.Throws<DivideByZeroException>(() => GaloisField16.Divide(1, 0));
    }

    [Fact]
    public void Pow_MatchesRepeatedMultiplication()
    {
        var random = new Random(7);
        for (var i = 0; i < 200; i++)
        {
            var value = (ushort)random.Next(1, 65536);
            var exponent = random.Next(0, 40);
            ushort expected = 1;
            for (var k = 0; k < exponent; k++)
                expected = GaloisField16.Multiply(expected, value);
            Assert.Equal(expected, GaloisField16.Pow(value, exponent));
        }
        Assert.Equal(1, GaloisField16.Pow(0, 0));
        Assert.Equal(0, GaloisField16.Pow(0, 5));
    }

    [Fact]
    public void Pow_UintExponentUsesTheFieldPeriodWithoutSignedOverflow()
    {
        const ushort value = 41_077;

        Assert.Equal(GaloisField16.Pow(value, 0), GaloisField16.Pow(value, uint.MaxValue));
        Assert.Equal(GaloisField16.Pow(value, 1), GaloisField16.Pow(value, 65_536u));
    }
}
