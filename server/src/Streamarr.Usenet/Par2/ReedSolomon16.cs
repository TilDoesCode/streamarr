using System.Runtime.InteropServices;

namespace Streamarr.Usenet.Par2;

/// <summary>
/// PAR2 Reed-Solomon primitives over GF(2^16): word-wise multiply-accumulate on slice
/// buffers and Vandermonde-system inversion for the missing-slice solve.
/// </summary>
public static class ReedSolomon16
{
    /// <summary>accumulator ^= factor * input, treating both buffers as little-endian 16-bit words.</summary>
    public static void MultiplyAccumulate(
        ReadOnlySpan<byte> input,
        Span<byte> accumulator,
        ushort factor,
        CancellationToken ct = default)
    {
        if (input.Length > accumulator.Length || input.Length % 2 != 0)
            throw new ArgumentException("Slice buffers must be word-aligned and fit the accumulator.");
        ct.ThrowIfCancellationRequested();
        if (factor == 0 || input.IsEmpty)
            return;

        var src = MemoryMarshal.Cast<byte, ushort>(input);
        var dst = MemoryMarshal.Cast<byte, ushort>(accumulator);
        if (factor == 1)
        {
            for (var i = 0; i < src.Length; i++)
            {
                if ((i & 0xfff) == 0)
                    ct.ThrowIfCancellationRequested();
                dst[i] ^= src[i];
            }
            return;
        }

        // Split-table: mul(factor, w) = low[w & 0xff] ^ high[w >> 8].
        Span<ushort> low = stackalloc ushort[256];
        Span<ushort> high = stackalloc ushort[256];
        for (var b = 0; b < 256; b++)
        {
            low[b] = GaloisField16.Multiply(factor, (ushort)b);
            high[b] = GaloisField16.Multiply(factor, (ushort)(b << 8));
        }
        for (var i = 0; i < src.Length; i++)
        {
            if ((i & 0xfff) == 0)
                ct.ThrowIfCancellationRequested();
            var w = src[i];
            dst[i] ^= (ushort)(low[w & 0xff] ^ high[w >> 8]);
        }
    }

    /// <summary>
    /// Inverts the PAR2 recovery matrix M[row=e][col=j] = C(missing_j)^exponent_e for the
    /// chosen exponents. Returns inverse[j][e] such that missing_j = XOR_e inverse[j][e] * T_e,
    /// where T_e is the syndrome of recovery slice e. Throws when the system is singular.
    /// </summary>
    public static ushort[][] InvertRecoveryMatrix(
        IReadOnlyList<int> missingGlobalIndices,
        IReadOnlyList<uint> exponents,
        CancellationToken ct = default,
        Par2RecoveryLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(missingGlobalIndices);
        ArgumentNullException.ThrowIfNull(exponents);
        var n = missingGlobalIndices.Count;
        if (n == 0 || exponents.Count != n)
            throw new ArgumentException("Need exactly one recovery exponent per missing slice.");
        (limits ?? Par2RecoveryLimits.Default).EnsureMatrixWithinBounds(n, exponents.Count);
        ct.ThrowIfCancellationRequested();

        // Augmented [M | I] Gauss-Jordan over GF(2^16).
        var m = new ushort[n][];
        for (var row = 0; row < n; row++)
        {
            ct.ThrowIfCancellationRequested();
            m[row] = new ushort[2 * n];
            for (var col = 0; col < n; col++)
            {
                var constant = GaloisField16.InputConstant(missingGlobalIndices[col]);
                m[row][col] = GaloisField16.Pow(constant, exponents[row]);
            }
            m[row][n + row] = 1;
        }

        for (var col = 0; col < n; col++)
        {
            ct.ThrowIfCancellationRequested();
            var pivot = -1;
            for (var row = col; row < n; row++)
            {
                if (m[row][col] != 0)
                {
                    pivot = row;
                    break;
                }
            }
            if (pivot < 0)
                throw new Par2FormatException("The PAR2 recovery matrix is singular; the chosen slices cannot repair this damage.");
            (m[col], m[pivot]) = (m[pivot], m[col]);

            var inv = GaloisField16.Divide(1, m[col][col]);
            for (var k = 0; k < 2 * n; k++)
                m[col][k] = GaloisField16.Multiply(m[col][k], inv);

            for (var row = 0; row < n; row++)
            {
                ct.ThrowIfCancellationRequested();
                if (row == col || m[row][col] == 0)
                    continue;
                var factor = m[row][col];
                for (var k = 0; k < 2 * n; k++)
                    m[row][k] ^= GaloisField16.Multiply(factor, m[col][k]);
            }
        }

        var inverse = new ushort[n][];
        for (var j = 0; j < n; j++)
        {
            inverse[j] = new ushort[n];
            for (var e = 0; e < n; e++)
                inverse[j][e] = m[j][n + e];
        }
        return inverse;
    }

    /// <summary>Selects a full-rank subset of recovery exponents for the damaged slices.</summary>
    public static bool TrySelectIndependentRecoveryExponents(
        IReadOnlyList<int> missingGlobalIndices,
        IReadOnlyList<uint> candidates,
        out uint[] selectedExponents,
        CancellationToken ct = default,
        Par2RecoveryLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(missingGlobalIndices);
        ArgumentNullException.ThrowIfNull(candidates);
        var n = missingGlobalIndices.Count;
        if (n == 0)
        {
            selectedExponents = [];
            return true;
        }
        (limits ?? Par2RecoveryLimits.Default).EnsureMatrixWithinBounds(n, candidates.Count);
        var basisByPivot = new ushort[n][];
        var selected = new List<uint>(n);

        foreach (var exponent in candidates)
        {
            ct.ThrowIfCancellationRequested();
            var row = new ushort[n];
            for (var col = 0; col < n; col++)
            {
                row[col] = GaloisField16.Pow(
                    GaloisField16.InputConstant(missingGlobalIndices[col]),
                    exponent);
            }

            for (var pivot = 0; pivot < n; pivot++)
            {
                var basis = basisByPivot[pivot];
                var factor = row[pivot];
                if (basis is null || factor == 0)
                    continue;
                for (var col = pivot; col < n; col++)
                    row[col] ^= GaloisField16.Multiply(factor, basis[col]);
            }

            var newPivot = Array.FindIndex(row, value => value != 0);
            if (newPivot < 0)
                continue;

            var inverse = GaloisField16.Divide(1, row[newPivot]);
            for (var col = newPivot; col < n; col++)
                row[col] = GaloisField16.Multiply(row[col], inverse);
            basisByPivot[newPivot] = row;
            selected.Add(exponent);
            if (selected.Count == n)
            {
                selectedExponents = [.. selected];
                return true;
            }
        }

        selectedExponents = [.. selected];
        return false;
    }
}
