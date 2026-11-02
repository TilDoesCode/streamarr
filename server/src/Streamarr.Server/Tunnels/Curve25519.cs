using System.Numerics;

namespace Streamarr.Server.Tunnels;

/// <summary>
/// X25519 scalar multiplication (RFC 7748 §5) over <see cref="BigInteger"/>. Streamarr only uses it to show the
/// public key that belongs to a stored WireGuard private key; it is not used for any live key exchange, so the
/// non-constant-time arithmetic is acceptable.
/// </summary>
internal static class Curve25519
{
    private static readonly BigInteger P = BigInteger.Pow(2, 255) - 19;
    private static readonly BigInteger A24 = 121665;

    /// <summary>The 32-byte public key of a 32-byte private key (scalar × base point 9).</summary>
    public static byte[] PublicKey(ReadOnlySpan<byte> privateKey)
    {
        var basePoint = new byte[32];
        basePoint[0] = 9;
        return ScalarMult(privateKey, basePoint);
    }

    /// <summary>X25519(k, u) with both inputs and the output as 32-byte little-endian strings.</summary>
    public static byte[] ScalarMult(ReadOnlySpan<byte> scalar, ReadOnlySpan<byte> u)
    {
        if (scalar.Length != 32)
            throw new ArgumentException("The scalar must be 32 bytes.", nameof(scalar));
        if (u.Length != 32)
            throw new ArgumentException("The u-coordinate must be 32 bytes.", nameof(u));

        var k = scalar.ToArray();
        k[0] &= 248;
        k[31] &= 127;
        k[31] |= 64;
        var uBytes = u.ToArray();
        uBytes[31] &= 127;

        var x1 = new BigInteger(uBytes, isUnsigned: true, isBigEndian: false) % P;
        var kInt = new BigInteger(k, isUnsigned: true, isBigEndian: false);
        BigInteger x2 = 1, z2 = 0, x3 = x1, z3 = 1;
        var swap = 0;
        for (var t = 254; t >= 0; t--)
        {
            var kt = (int)((kInt >> t) & 1);
            swap ^= kt;
            if (swap == 1)
            {
                (x2, x3) = (x3, x2);
                (z2, z3) = (z3, z2);
            }
            swap = kt;

            var a = (x2 + z2) % P;
            var aa = a * a % P;
            var b = (x2 - z2 + P) % P;
            var bb = b * b % P;
            var e = (aa - bb + P) % P;
            var c = (x3 + z3) % P;
            var d = (x3 - z3 + P) % P;
            var da = d * a % P;
            var cb = c * b % P;
            var sum = (da + cb) % P;
            x3 = sum * sum % P;
            var diff = (da - cb + P) % P;
            z3 = x1 * (diff * diff % P) % P;
            x2 = aa * bb % P;
            z2 = e * ((aa + A24 * e) % P) % P;
        }

        if (swap == 1)
        {
            (x2, x3) = (x3, x2);
            (z2, z3) = (z3, z2);
        }

        var result = x2 * BigInteger.ModPow(z2, P - 2, P) % P;
        var bytes = result.ToByteArray(isUnsigned: true, isBigEndian: false);
        var output = new byte[32];
        Array.Copy(bytes, output, Math.Min(bytes.Length, 32));
        return output;
    }
}
