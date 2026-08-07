namespace Streamarr.Usenet.Par2;

/// <summary>
/// GF(2^16) arithmetic for PAR2 Reed-Solomon coding (generator polynomial 0x1100B,
/// generator element 2), per the PAR 2.0 specification. Table-driven log/antilog.
/// </summary>
public static class GaloisField16
{
    public const int Order = 65536;
    public const int Limit = Order - 1;
    private const int Polynomial = 0x1100B;

    private static readonly ushort[] Exp = new ushort[Limit * 2];
    private static readonly int[] Log = new int[Order];
    private static readonly ushort[] InputConstantsStorage;

    static GaloisField16()
    {
        var value = 1;
        for (var power = 0; power < Limit; power++)
        {
            Exp[power] = (ushort)value;
            Exp[power + Limit] = (ushort)value;
            Log[value] = power;
            value <<= 1;
            if ((value & Order) != 0)
                value ^= Polynomial;
        }
        Log[0] = -1;
        InputConstantsStorage = BuildInputConstants();
    }

    public static ushort Multiply(ushort a, ushort b)
        => a == 0 || b == 0 ? (ushort)0 : Exp[Log[a] + Log[b]];

    public static ushort Divide(ushort a, ushort b)
    {
        if (b == 0)
            throw new DivideByZeroException("GF(2^16) division by zero.");
        return a == 0 ? (ushort)0 : Exp[(Log[a] - Log[b] + Limit) % Limit];
    }

    /// <summary>2^power for 0 &lt;= power (reduced modulo the group order).</summary>
    public static ushort AntiLog(int power)
        => Exp[((power % Limit) + Limit) % Limit];

    public static ushort Pow(ushort value, int exponent)
    {
        if (value == 0)
            return exponent == 0 ? (ushort)1 : (ushort)0;
        var log = (long)Log[value] * exponent;
        return Exp[(int)(((log % Limit) + Limit) % Limit)];
    }

    public static ushort Pow(ushort value, uint exponent)
    {
        if (value == 0)
            return exponent == 0 ? (ushort)1 : (ushort)0;
        var log = (long)Log[value] * exponent;
        return Exp[(int)(log % Limit)];
    }

    /// <summary>
    /// The PAR2 input-slice constant for global input slice <paramref name="index"/>:
    /// the (index+1)-th power of two whose order in the field is 65535, i.e. 2^n with
    /// n coprime to 3, 5, 17 and 257 (the prime factors of 65535).
    /// </summary>
    public static ushort InputConstant(int index)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(index);
        if (index >= InputConstantsStorage.Length)
            throw new ArgumentOutOfRangeException(nameof(index), "PAR2 supports at most 32768 input slices.");
        return InputConstantsStorage[index];
    }

    public static ReadOnlySpan<ushort> InputConstants => InputConstantsStorage;

    public static int InputConstantCount => InputConstantsStorage.Length;

    private static ushort[] BuildInputConstants()
    {
        var constants = new ushort[32768];
        var count = 0;
        for (var n = 1; n < Limit && count < constants.Length; n++)
        {
            if (n % 3 == 0 || n % 5 == 0 || n % 17 == 0 || n % 257 == 0)
                continue;
            constants[count++] = Exp[n];
        }
        return constants;
    }
}
