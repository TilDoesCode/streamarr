namespace Streamarr.Usenet.Par2;

/// <summary>Slice-granular IO the reconstruction engine runs against.</summary>
public interface IPar2BlockIo
{
    /// <summary>
    /// Reads the full (zero-padded) content of a present input slice into
    /// <paramref name="destination"/>, which is exactly slice-size bytes.
    /// </summary>
    ValueTask ReadPresentSliceAsync(int globalSliceIndex, Memory<byte> destination, CancellationToken ct);

    /// <summary>Reads the full payload of a verified recovery slice.</summary>
    ValueTask ReadRecoverySliceAsync(uint exponent, Memory<byte> destination, CancellationToken ct);

    /// <summary>Persists one reconstructed input slice (zero padding included).</summary>
    ValueTask WriteRecoveredSliceAsync(int globalSliceIndex, ReadOnlyMemory<byte> data, CancellationToken ct);
}

/// <summary>Progress of a reconstruction run, in processed source bytes.</summary>
public sealed record Par2ReconstructionProgress(long ProcessedBytes, long TotalBytes);

/// <summary>
/// Streaming PAR2 Reed-Solomon reconstruction: reads every present input slice exactly
/// once, accumulates per-exponent syndromes, folds in the recovery slices, then solves
/// for the missing slices. Peak memory is (missing + 2) slice buffers — the source is
/// never held in RAM as a whole.
/// </summary>
public static class Par2RecoveryEngine
{
    public static async Task ReconstructAsync(
        Par2SetInfo set,
        IReadOnlyList<int> missingGlobalIndices,
        IReadOnlyList<uint> exponents,
        IPar2BlockIo io,
        IProgress<Par2ReconstructionProgress>? progress = null,
        CancellationToken ct = default,
        Par2RecoveryLimits? limits = null)
    {
        ArgumentNullException.ThrowIfNull(set);
        ArgumentNullException.ThrowIfNull(missingGlobalIndices);
        ArgumentNullException.ThrowIfNull(exponents);
        ArgumentNullException.ThrowIfNull(io);
        limits ??= Par2RecoveryLimits.Default;
        var missing = missingGlobalIndices.Distinct().OrderBy(i => i).ToArray();
        if (missing.Length == 0)
            return;
        ct.ThrowIfCancellationRequested();
        if (set.TotalSlices <= 0 || set.TotalSlices > GaloisField16.InputConstantCount)
            throw new Par2FormatException("The recovery set declares an unsupported total slice count.");
        if (set.SliceSize is <= 0 or > int.MaxValue || set.SliceSize % 4 != 0)
            throw new Par2FormatException("The recovery set declares an unsupported slice size.");
        if (missing.Any(i => i < 0 || i >= set.TotalSlices))
            throw new ArgumentOutOfRangeException(nameof(missingGlobalIndices));

        var candidates = exponents.Distinct().OrderBy(e => e).ToArray();
        if (candidates.Length < missing.Length)
            throw new Par2FormatException("Recovery slice exponents are not distinct enough for this damage.");
        limits.EnsureWithinBounds(
            missing.Length, candidates.Length, set.SliceSize, set.TotalSlices);

        if (!ReedSolomon16.TrySelectIndependentRecoveryExponents(
                missing, candidates, out var usedExponents, ct, limits))
        {
            throw new Par2FormatException(
                "The available PAR2 recovery slices do not contain an independent matrix for this damage.");
        }
        var inverse = ReedSolomon16.InvertRecoveryMatrix(missing, usedExponents, ct, limits);
        var sliceSize = checked((int)set.SliceSize);
        var missingSet = missing.ToHashSet();

        // Syndrome accumulators, one per used exponent.
        var syndromes = new byte[usedExponents.Length][];
        for (var e = 0; e < usedExponents.Length; e++)
            syndromes[e] = new byte[sliceSize];

        var readBuffer = new byte[sliceSize];
        var totalBytes = (set.TotalSlices - missing.Length) * (long)sliceSize;
        long processed = 0;

        for (var index = 0; index < set.TotalSlices; index++)
        {
            if (missingSet.Contains(index))
                continue;
            ct.ThrowIfCancellationRequested();
            await io.ReadPresentSliceAsync(index, readBuffer, ct).ConfigureAwait(false);
            var constant = GaloisField16.InputConstant(index);
            for (var e = 0; e < usedExponents.Length; e++)
            {
                var factor = GaloisField16.Pow(constant, usedExponents[e]);
                ReedSolomon16.MultiplyAccumulate(readBuffer, syndromes[e], factor, ct);
            }
            processed += sliceSize;
            progress?.Report(new Par2ReconstructionProgress(processed, totalBytes));
        }

        // T_e = R_e XOR sum(present): fold each recovery slice into its syndrome.
        for (var e = 0; e < usedExponents.Length; e++)
        {
            ct.ThrowIfCancellationRequested();
            await io.ReadRecoverySliceAsync(usedExponents[e], readBuffer, ct).ConfigureAwait(false);
            ReedSolomon16.MultiplyAccumulate(readBuffer, syndromes[e], 1, ct);
        }

        // missing_j = XOR_e inverse[j][e] * T_e
        var output = new byte[sliceSize];
        for (var j = 0; j < missing.Length; j++)
        {
            ct.ThrowIfCancellationRequested();
            Array.Clear(output);
            for (var e = 0; e < usedExponents.Length; e++)
                ReedSolomon16.MultiplyAccumulate(syndromes[e], output, inverse[j][e], ct);
            await io.WriteRecoveredSliceAsync(missing[j], output, ct).ConfigureAwait(false);
        }
    }
}
