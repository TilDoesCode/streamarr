// Ported from UsenetSharp (https://github.com/nzbdav-dev/UsenetSharp), MIT License.
// Source: UsenetSharp/Streams/YencStream.cs @ ccc5de1b114c0b0dc7dae0c933a10a2b99562cac
// See NOTICE at the repository root.
// Modified for Streamarr: the native RapidYencSharp decoder was replaced with a
// fully managed incremental yEnc decoder including =yend CRC32 validation.

using System.Text;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Streams;

namespace Streamarr.Usenet.Yenc;

/// <summary>
/// A read-only stream that incrementally decodes yEnc-encoded content from an
/// inner stream (a raw, dot-unstuffed NNTP article body with CRLF line endings).
/// Parses <c>=ybegin</c>/<c>=ypart</c> headers, decodes data lines, and validates
/// the <c>=yend</c> CRC32/pcrc32 trailer when present.
/// </summary>
public class YencStream : FastReadOnlyNonSeekableStream
{
    private readonly Stream _innerStream;
    private readonly bool _validateCrc;

    // Header state
    private bool _headersRead;
    private YencHeader? _yencHeader;

    // Read buffer for chunked reading from the inner stream
    private readonly byte[] _readBuffer;
    private int _readBufferPosition;
    private int _readBufferLength;

    // Decode buffer holding decoded bytes of the current line
    private byte[] _decodeBuffer;
    private int _decodeBufferPosition;
    private int _decodeBufferLength;

    // Line assembly buffer for lines spanning chunk boundaries
    private byte[] _lineAssemblyBuffer;
    private int _lineAssemblyLength;

    // Decoder state: true when the previous byte was an unconsumed '=' escape
    private bool _escaped;

    // Trailer / CRC state
    private uint _crcState = Crc32.InitialState;
    private long _decodedByteCount;
    private bool _endReached;

    private const int ReadBufferSize = 8192;
    private const int DecodeBufferSize = 1024;
    private const int LineAssemblyBufferSize = 1024;

    public YencStream(Stream innerStream, bool validateCrc = true)
    {
        _innerStream = innerStream ?? throw new ArgumentNullException(nameof(innerStream));
        _validateCrc = validateCrc;
        _readBuffer = new byte[ReadBufferSize];
        _decodeBuffer = new byte[DecodeBufferSize];
        _lineAssemblyBuffer = new byte[LineAssemblyBufferSize];
    }

    /// <summary>
    /// Gets the yEnc headers from the stream. If headers haven't been read yet,
    /// reads and parses them asynchronously.
    /// </summary>
    public virtual async ValueTask<YencHeader?> GetYencHeadersAsync(CancellationToken cancellationToken = default)
    {
        if (!_headersRead)
        {
            await ParseHeadersAsync(cancellationToken).ConfigureAwait(false);
            _headersRead = true;
        }

        return _yencHeader;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        // Parse headers on first read
        if (!_headersRead)
        {
            await ParseHeadersAsync(cancellationToken).ConfigureAwait(false);
            _headersRead = true;
        }

        var totalRead = 0;

        while (totalRead < buffer.Length)
        {
            // Serve from decode buffer if we have leftover data
            if (_decodeBufferPosition < _decodeBufferLength)
            {
                var bytesToCopy = Math.Min(buffer.Length - totalRead, _decodeBufferLength - _decodeBufferPosition);
                _decodeBuffer.AsSpan(_decodeBufferPosition, bytesToCopy).CopyTo(buffer.Span[totalRead..]);
                _decodeBufferPosition += bytesToCopy;
                totalRead += bytesToCopy;
                continue;
            }

            if (_endReached) break;

            // Need to decode the next line
            var line = await ReadNextLineAsync(cancellationToken).ConfigureAwait(false);

            if (line.Length == 0)
            {
                if (_readBufferLength == 0)
                {
                    // EOF without =yend trailer
                    _endReached = true;
                    break;
                }

                continue; // skip empty lines
            }

            if (StartsWith(line, "=yend"u8))
            {
                HandleTrailer(ToLatin1String(line));
                _endReached = true;
                break;
            }

            DecodeLine(line);
        }

        return totalRead;
    }

    /// <summary>Decodes one yEnc data line into the decode buffer and updates the CRC.</summary>
    private void DecodeLine(ReadOnlyMemory<byte> lineMemory)
    {
        var line = lineMemory.Span;
        if (_decodeBuffer.Length < line.Length)
            _decodeBuffer = new byte[Math.Max(line.Length, _decodeBuffer.Length * 2)];

        var written = 0;
        foreach (var b in line)
        {
            if (_escaped)
            {
                _decodeBuffer[written++] = unchecked((byte)(b - 64 - 42));
                _escaped = false;
            }
            else if (b == (byte)'=')
            {
                _escaped = true;
            }
            else
            {
                _decodeBuffer[written++] = unchecked((byte)(b - 42));
            }
        }

        _decodeBufferPosition = 0;
        _decodeBufferLength = written;
        _decodedByteCount += written;
        _crcState = Crc32.Update(_crcState, _decodeBuffer.AsSpan(0, written));
    }

    /// <summary>Parses the =yend line and validates size and CRC32 when present.</summary>
    private void HandleTrailer(string yendLine)
    {
        if (!_validateCrc) return;

        var attributes = ParseAttributes(yendLine);

        if (attributes.TryGetValue("size", out var sizeValue) &&
            long.TryParse(sizeValue, out var expectedSize) &&
            expectedSize != _decodedByteCount)
        {
            throw new YencCrcMismatchException(
                $"yEnc size mismatch: =yend declared {expectedSize} bytes but {_decodedByteCount} were decoded.");
        }

        // pcrc32 = CRC of this part's decoded data; crc32 = CRC of the whole file.
        // For single-part files, crc32 covers the (only) part's data as well.
        var crcAttribute =
            attributes.TryGetValue("pcrc32", out var pcrc) ? pcrc :
            _yencHeader?.IsFilePart != true && attributes.TryGetValue("crc32", out var crc) ? crc :
            null;

        if (crcAttribute == null) return;

        if (!uint.TryParse(crcAttribute, System.Globalization.NumberStyles.HexNumber, null, out var expectedCrc))
            return; // malformed crc attribute — tolerate

        var actualCrc = Crc32.Finalize(_crcState);
        if (actualCrc != expectedCrc)
        {
            throw new YencCrcMismatchException(
                $"yEnc CRC32 mismatch: expected {expectedCrc:x8}, computed {actualCrc:x8}.");
        }
    }

    /// <summary>
    /// Reads the next line from the stream using buffered chunked reading.
    /// Handles lines spanning multiple read chunks.
    /// </summary>
    private async ValueTask<ReadOnlyMemory<byte>> ReadNextLineAsync(CancellationToken cancellationToken)
    {
        while (true)
        {
            // Ensure we have data in the read buffer
            if (_readBufferPosition >= _readBufferLength)
            {
                var hasMoreData = await FillReadBufferAsync(cancellationToken).ConfigureAwait(false);
                if (!hasMoreData && _lineAssemblyLength == 0)
                {
                    return ReadOnlyMemory<byte>.Empty; // EOF
                }

                if (!hasMoreData)
                {
                    // Return partial line at EOF
                    var result = new ReadOnlyMemory<byte>(_lineAssemblyBuffer, 0, _lineAssemblyLength);
                    _lineAssemblyLength = 0;
                    return result;
                }
            }

            // Scan for a line ending in the current buffer (sync helper: no spans in async)
            if (TryTakeLine(out var line))
                return line;
        }
    }

    /// <summary>Extracts the next complete line from the read buffer, if any.</summary>
    private bool TryTakeLine(out ReadOnlyMemory<byte> line)
    {
        var searchSpan = _readBuffer.AsSpan(_readBufferPosition, _readBufferLength - _readBufferPosition);
        var lfIndex = searchSpan.IndexOf((byte)'\n');

        if (lfIndex >= 0)
        {
            // Found complete line
            var lineEndPos = _readBufferPosition + lfIndex;
            var lineStartPos = _readBufferPosition;

            // Check for CRLF vs LF
            var lineLength = lfIndex;
            if (lfIndex > 0 && searchSpan[lfIndex - 1] == (byte)'\r')
            {
                lineLength--; // Exclude CR
            }

            _readBufferPosition = lineEndPos + 1; // Move past LF

            // If we have a partial line in the assembly buffer, combine them
            if (_lineAssemblyLength > 0)
            {
                // A CR may have been buffered at a chunk boundary ("...\r" + "\n...")
                if (lineLength == 0 && _lineAssemblyBuffer[_lineAssemblyLength - 1] == (byte)'\r')
                    _lineAssemblyLength--;

                EnsureLineAssemblyCapacity(_lineAssemblyLength + lineLength);
                searchSpan[..lineLength].CopyTo(_lineAssemblyBuffer.AsSpan(_lineAssemblyLength));
                var totalLength = _lineAssemblyLength + lineLength;
                _lineAssemblyLength = 0;
                line = new ReadOnlyMemory<byte>(_lineAssemblyBuffer, 0, totalLength);
                return true;
            }

            // Return line directly from read buffer
            line = new ReadOnlyMemory<byte>(_readBuffer, lineStartPos, lineLength);
            return true;
        }

        // No line ending in current buffer - save to assembly buffer and read more
        var remainingLength = _readBufferLength - _readBufferPosition;
        EnsureLineAssemblyCapacity(_lineAssemblyLength + remainingLength);
        searchSpan.CopyTo(_lineAssemblyBuffer.AsSpan(_lineAssemblyLength));
        _lineAssemblyLength += remainingLength;
        _readBufferPosition = _readBufferLength; // Consumed entire buffer
        line = ReadOnlyMemory<byte>.Empty;
        return false;
    }

    private void EnsureLineAssemblyCapacity(int required)
    {
        if (_lineAssemblyBuffer.Length >= required) return;
        var newBuffer = new byte[Math.Max(required, _lineAssemblyBuffer.Length * 2)];
        _lineAssemblyBuffer.AsSpan(0, _lineAssemblyLength).CopyTo(newBuffer);
        _lineAssemblyBuffer = newBuffer;
    }

    private async ValueTask<bool> FillReadBufferAsync(CancellationToken cancellationToken)
    {
        _readBufferPosition = 0;
        _readBufferLength = await _innerStream
            .ReadAsync(_readBuffer.AsMemory(0, ReadBufferSize), cancellationToken)
            .ConfigureAwait(false);
        return _readBufferLength > 0;
    }

    private async Task ParseHeadersAsync(CancellationToken cancellationToken)
    {
        string ybeginLine;
        string? ypartLine = null;

        // Read lines until we find =ybegin (skip empty lines that may appear before it)
        while (true)
        {
            var lineMemory = await ReadNextLineAsync(cancellationToken).ConfigureAwait(false);

            if (lineMemory.Length == 0)
            {
                // Distinguish between empty line and EOF
                if (_readBufferLength == 0)
                {
                    throw new InvalidDataException("Reached end of stream without finding =ybegin header");
                }

                continue; // Empty line - skip it
            }

            if (StartsWith(lineMemory, "=ybegin"u8))
            {
                ybeginLine = ToLatin1String(lineMemory);
                break;
            }
        }

        // Check if next line is =ypart or encoded data
        var nextLineMemory = await ReadNextLineAsync(cancellationToken).ConfigureAwait(false);
        if (nextLineMemory.Length > 0)
        {
            if (StartsWith(nextLineMemory, "=ypart"u8))
            {
                ypartLine = ToLatin1String(nextLineMemory);
                // Next line will be encoded data, ReadAsync will handle it
            }
            else if (StartsWith(nextLineMemory, "=yend"u8))
            {
                _yencHeader = ParseYencHeaders(ybeginLine, ypartLine);
                HandleTrailer(ToLatin1String(nextLineMemory));
                _endReached = true;
                return;
            }
            else
            {
                // This is the first encoded data line - decode it now
                DecodeLine(nextLineMemory);
            }
        }

        _yencHeader = ParseYencHeaders(ybeginLine, ypartLine);
    }

    private static bool StartsWith(ReadOnlyMemory<byte> line, ReadOnlySpan<byte> prefix) =>
        line.Length >= prefix.Length && line.Span[..prefix.Length].SequenceEqual(prefix);

    private static string ToLatin1String(ReadOnlyMemory<byte> line) =>
        Encoding.Latin1.GetString(line.Span);

    private static Dictionary<string, string> ParseAttributes(string headerLine)
    {
        // Format: =y... key1=value1 key2=value2 name=file name with spaces.bin
        var attributes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var parts = headerLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);

        for (var i = 1; i < parts.Length; i++) // skip the "=y..." keyword
        {
            var keyValue = parts[i].Split('=', 2);
            if (keyValue.Length != 2) continue;

            if (keyValue[0].Equals("name", StringComparison.OrdinalIgnoreCase))
            {
                // The name attribute is always last and may contain spaces.
                var nameIndex = headerLine.IndexOf("name=", StringComparison.OrdinalIgnoreCase);
                attributes["name"] = headerLine[(nameIndex + 5)..];
                break;
            }

            attributes[keyValue[0]] = keyValue[1];
        }

        return attributes;
    }

    private static YencHeader ParseYencHeaders(string ybeginLine, string? ypartLine)
    {
        var ybegin = ParseAttributes(ybeginLine);

        var lineLength = 128;
        long fileSize = 0;
        var fileName = string.Empty;
        var partNumber = 0;
        var totalParts = 0;

        if (ybegin.TryGetValue("line", out var lineValue)) int.TryParse(lineValue, out lineLength);
        if (ybegin.TryGetValue("size", out var sizeValue)) long.TryParse(sizeValue, out fileSize);
        if (ybegin.TryGetValue("name", out var nameValue)) fileName = nameValue;
        if (ybegin.TryGetValue("part", out var partValue)) int.TryParse(partValue, out partNumber);
        if (ybegin.TryGetValue("total", out var totalValue)) int.TryParse(totalValue, out totalParts);

        // Parse =ypart line if present. Format: =ypart begin=1 end=123456
        var partSize = fileSize;
        long partOffset = 0;

        if (ypartLine != null)
        {
            var ypart = ParseAttributes(ypartLine);
            long partBegin = 0;
            long partEnd = 0;
            if (ypart.TryGetValue("begin", out var beginValue)) long.TryParse(beginValue, out partBegin);
            if (ypart.TryGetValue("end", out var endValue)) long.TryParse(endValue, out partEnd);

            partOffset = partBegin - 1; // yEnc uses 1-based indexing
            partSize = partEnd - partBegin + 1;
        }

        return new YencHeader
        {
            FileName = fileName,
            FileSize = fileSize,
            LineLength = lineLength,
            PartNumber = partNumber,
            TotalParts = totalParts,
            PartSize = partSize,
            PartOffset = partOffset
        };
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _innerStream.Dispose();
        }

        base.Dispose(disposing);
    }

    public override async ValueTask DisposeAsync()
    {
        await _innerStream.DisposeAsync().ConfigureAwait(false);
        await base.DisposeAsync().ConfigureAwait(false);
    }
}
