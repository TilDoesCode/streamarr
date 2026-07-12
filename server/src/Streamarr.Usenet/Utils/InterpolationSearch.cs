// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Utils/InterpolationSearch.cs @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr (sync variant dropped).

using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Models;

namespace Streamarr.Usenet.Utils;

/// <summary>
/// Interpolation search over the segment list of a file: given a target byte
/// offset, finds the segment (index) whose decoded byte range contains it, using
/// each guessed segment's yEnc part offset/size as the probe.
/// </summary>
public static class InterpolationSearch
{
    public static async Task<Result> Find
    (
        long searchByte,
        LongRange indexRangeToSearch,
        LongRange byteRangeToSearch,
        Func<int, ValueTask<LongRange>> getByteRangeOfGuessedIndex,
        CancellationToken cancellationToken
    )
    {
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();

            // make sure our search is even possible.
            if (!byteRangeToSearch.Contains(searchByte) || indexRangeToSearch.Count <= 0)
                throw new SeekPositionNotFoundException($"Corrupt file. Cannot find byte position {searchByte}.");

            // make a guess
            var searchByteFromStart = searchByte - byteRangeToSearch.StartInclusive;
            var bytesPerIndex = (double)byteRangeToSearch.Count / indexRangeToSearch.Count;
            var guessFromStart = (long)Math.Floor(searchByteFromStart / bytesPerIndex);
            var guessedIndex = (int)(indexRangeToSearch.StartInclusive + guessFromStart);
            var byteRangeOfGuessedIndex = await getByteRangeOfGuessedIndex(guessedIndex).ConfigureAwait(false);

            // make sure the result is within the range of our search space
            if (!byteRangeOfGuessedIndex.IsContainedWithin(byteRangeToSearch))
                throw new SeekPositionNotFoundException($"Corrupt file. Cannot find byte position {searchByte}.");

            // if we guessed too low, adjust our lower bounds in order to search higher next time
            if (byteRangeOfGuessedIndex.EndExclusive <= searchByte)
            {
                indexRangeToSearch = indexRangeToSearch with { StartInclusive = guessedIndex + 1 };
                byteRangeToSearch = byteRangeToSearch with { StartInclusive = byteRangeOfGuessedIndex.EndExclusive };
            }

            // if we guessed too high, adjust our upper bounds in order to search lower next time
            else if (byteRangeOfGuessedIndex.StartInclusive > searchByte)
            {
                indexRangeToSearch = indexRangeToSearch with { EndExclusive = guessedIndex };
                byteRangeToSearch = byteRangeToSearch with { EndExclusive = byteRangeOfGuessedIndex.StartInclusive };
            }

            // if we guessed correctly, we're done
            else if (byteRangeOfGuessedIndex.Contains(searchByte))
                return new Result(guessedIndex, byteRangeOfGuessedIndex);
        }
    }

    public record Result(int FoundIndex, LongRange FoundByteRange);
}
