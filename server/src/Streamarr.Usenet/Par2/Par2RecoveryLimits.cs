namespace Streamarr.Usenet.Par2;

/// <summary>Hard resource bounds for one PAR2 reconstruction.</summary>
public sealed record Par2RecoveryLimits
{
    public static Par2RecoveryLimits Default { get; } = new();

    /// <summary>Most damaged input slices solved in one reconstruction.</summary>
    public int MaxDamagedSlices { get; init; } = 256;

    /// <summary>Maximum estimated peak memory used by slice buffers and recovery matrices.</summary>
    public long MaxWorkingMemoryBytes { get; init; } = 512L * 1024 * 1024;

    /// <summary>Maximum estimated Galois-field operations used to select and invert a matrix.</summary>
    public long MaxMatrixOperations { get; init; } = 100_000_000;

    /// <summary>Maximum estimated word operations for the complete reconstruction.</summary>
    public long MaxReconstructionOperations { get; init; } = 50_000_000_000;

    internal void EnsureWithinBounds(
        int damagedSlices,
        int candidateExponents,
        long sliceSize,
        long totalSlices)
    {
        EnsureMatrixWithinBounds(damagedSlices, candidateExponents);
        if (MaxReconstructionOperations <= 0)
            throw new ArgumentOutOfRangeException(nameof(MaxReconstructionOperations));
        if (totalSlices < damagedSlices)
            throw new ArgumentOutOfRangeException(nameof(totalSlices));

        try
        {
            var n = (long)damagedSlices;
            var sliceBuffers = checked((n + 2) * sliceSize);
            var matrixBytes = checked(6 * n * n);
            var arrayOverhead = checked(128 * (n + 4));
            var workingBytes = checked(sliceBuffers + matrixBytes + arrayOverhead);
            if (workingBytes > MaxWorkingMemoryBytes)
            {
                throw new Par2RecoveryLimitException(
                    $"The repair needs an estimated {workingBytes} bytes of working memory; "
                    + $"the limit is {MaxWorkingMemoryBytes} bytes.");
            }

            var wordsPerSlice = sliceSize / 2;
            var presentSlices = totalSlices - n;
            var sourceOperations = checked(presentSlices * n * wordsPerSlice);
            var recoveryOperations = checked(n * wordsPerSlice);
            var solveOperations = checked(n * n * wordsPerSlice);
            var selectionOperations = checked((long)candidateExponents * n * n);
            var inversionOperations = checked(4 * n * n * n);
            var reconstructionOperations = checked(
                sourceOperations
                + recoveryOperations
                + solveOperations
                + selectionOperations
                + inversionOperations);
            if (reconstructionOperations > MaxReconstructionOperations)
            {
                throw new Par2RecoveryLimitException(
                    $"The repair needs an estimated {reconstructionOperations} reconstruction operations; "
                    + $"the limit is {MaxReconstructionOperations}.");
            }
        }
        catch (OverflowException)
        {
            throw new Par2RecoveryLimitException("The repair's estimated resource use exceeds supported bounds.");
        }
    }

    internal void EnsureMatrixWithinBounds(int damagedSlices, int candidateExponents)
    {
        if (MaxDamagedSlices <= 0)
            throw new ArgumentOutOfRangeException(nameof(MaxDamagedSlices));
        if (MaxWorkingMemoryBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(MaxWorkingMemoryBytes));
        if (MaxMatrixOperations <= 0)
            throw new ArgumentOutOfRangeException(nameof(MaxMatrixOperations));
        if (damagedSlices > MaxDamagedSlices)
        {
            throw new Par2RecoveryLimitException(
                $"The repair needs {damagedSlices} damaged slices; the limit is {MaxDamagedSlices}.");
        }

        try
        {
            var n = (long)damagedSlices;
            var matrixBytes = checked(6 * n * n + 128 * (n + 4));
            if (matrixBytes > MaxWorkingMemoryBytes)
            {
                throw new Par2RecoveryLimitException(
                    $"The repair needs an estimated {matrixBytes} bytes for recovery matrices; "
                    + $"the working-memory limit is {MaxWorkingMemoryBytes} bytes.");
            }

            var selectionOperations = checked((long)candidateExponents * n * n);
            var inversionOperations = checked(4 * n * n * n);
            var matrixOperations = checked(selectionOperations + inversionOperations);
            if (matrixOperations > MaxMatrixOperations)
            {
                throw new Par2RecoveryLimitException(
                    $"The repair needs an estimated {matrixOperations} matrix operations; "
                    + $"the limit is {MaxMatrixOperations}.");
            }
        }
        catch (OverflowException)
        {
            throw new Par2RecoveryLimitException("The repair's estimated matrix resource use exceeds supported bounds.");
        }
    }
}

/// <summary>A PAR2 reconstruction was refused before allocating excessive resources.</summary>
public sealed class Par2RecoveryLimitException(string message) : Exception(message);
