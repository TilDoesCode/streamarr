using SharpCompress.Archives.Rar;
using SharpCompress.Readers;
using Streamarr.Tests.Shared;
using Streamarr.Usenet.Exceptions;
using Streamarr.Usenet.Rar;

namespace Streamarr.Usenet.Tests.Rar;

/// <summary>
/// RAR5 AES-256 per-file data encryption: generate_fixtures.py builds real,
/// independently-decryptable ciphertext (PBKDF2-HMAC-SHA256 key + AES-256-CBC,
/// per the RAR5 spec) for a known payload/password, so these tests can prove
/// RarAesCbcDecryptor/RarStoredFileStream recover the exact original bytes —
/// including from arbitrary mid-file offsets, not just from the start — and
/// cross-validate the result against SharpCompress's own independent
/// decompression pipeline (the same "trust an independent reader" philosophy as
/// RarFixtureSanityTests).
///
/// The multi-volume fixture deliberately uses a *different* IV per volume (see
/// generate_fixtures.py): an earlier version of this fixture assumed one continuous
/// cipher stream across volumes, and cross-validating against SharpCompress's own
/// decompression caught that it was wrong — RAR encrypts each volume's contribution
/// to a file independently, resetting the CBC chain from that volume's own IV. The
/// distinct-per-volume IVs here pin that model down and stop it regressing.
/// </summary>
public class RarEncryptedStreamTests
{
    private const string Password = "correct horse battery staple";
    private const string WrongPassword = "not the right password";
    private static byte[] Payload => YencTestEncoder.LcgBytes(99, 40_000);

    private static readonly string[] MultiVolumeParts =
    [
        "encrypted-multi-rar5.part1.rar",
        "encrypted-multi-rar5.part2.rar",
        "encrypted-multi-rar5.part3.rar",
        "encrypted-multi-rar5.part4.rar",
        "encrypted-multi-rar5.part5.rar",
    ];

    [Fact]
    public async Task SingleVolume_NoPassword_IsRejectedCleanly()
    {
        await using var stream = File.OpenRead(RarFixtures.PathOf("encrypted-rar5.rar"));
        var ex = await Assert.ThrowsAsync<UnsupportedRarCompressionMethodException>(
            () => RarVolumeReader.ReadAsync(stream, "encrypted-rar5.rar", CancellationToken.None));
        Assert.Equal("Encrypted rar entries are not supported.", ex.Message);
    }

    [Fact]
    public async Task SingleVolume_CorrectPassword_CapturesRar5CryptoParams()
    {
        var volume = await ReadVolume("encrypted-rar5.rar", Password);
        var slice = Assert.Single(volume.Slices);
        Assert.NotNull(slice.Crypto);
        Assert.Equal(16, slice.Crypto!.Salt.Length);
        Assert.Equal(16, slice.Crypto.InitV.Length);
        Assert.Equal(3, slice.Crypto.Lg2Count);
    }

    [Fact]
    public async Task SingleVolume_CorrectPassword_DecryptsExactOriginalBytes()
    {
        var volume = await ReadVolume("encrypted-rar5.rar", Password);
        var file = Assert.Single(RarArchiveIndexer.Index([volume]));

        await using var stream = new RarStoredFileStream(
            file, (_, _) => new ValueTask<Stream>(File.OpenRead(RarFixtures.PathOf("encrypted-rar5.rar"))), Password);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(Payload, ms.ToArray());
    }

    [Theory]
    [InlineData(0, 100)]
    [InlineData(12_345, 4_096)]
    [InlineData(39_999, 1)] // last byte
    [InlineData(20_000, 20_000)] // straddles many blocks, ends past a 16-byte boundary
    public async Task SingleVolume_CorrectPassword_RandomAccessReadsMatchDirectSlice(int offset, int count)
    {
        var volume = await ReadVolume("encrypted-rar5.rar", Password);
        var file = Assert.Single(RarArchiveIndexer.Index([volume]));

        await using var stream = new RarStoredFileStream(
            file, (_, _) => new ValueTask<Stream>(File.OpenRead(RarFixtures.PathOf("encrypted-rar5.rar"))), Password);
        var buffer = await ReadExactAsync(stream, offset, count);

        Assert.Equal(Payload.AsSpan(offset, count).ToArray(), buffer);
    }

    [Fact]
    public async Task SingleVolume_WrongPassword_DoesNotThrow_ButProducesWrongBytes()
    {
        // Per-file (not archive-header) RAR5 encryption doesn't let SharpCompress detect a
        // wrong password while just walking headers -- that's an explicit, documented scope
        // boundary (no PswCheck pre-validation). This pins down the actual failure mode: wrong
        // output, not a crash, matching how ffprobe/playback would simply fail on garbage bytes.
        var volume = await ReadVolume("encrypted-rar5.rar", WrongPassword);
        var file = Assert.Single(RarArchiveIndexer.Index([volume]));

        await using var stream = new RarStoredFileStream(
            file,
            (_, _) => new ValueTask<Stream>(File.OpenRead(RarFixtures.PathOf("encrypted-rar5.rar"))),
            WrongPassword);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.NotEqual(Payload, ms.ToArray());
    }

    [Fact]
    public void SingleVolume_CrossValidatesAgainstSharpCompressOwnDecompression()
    {
        using var archive = RarArchive.OpenArchive(
            RarFixtures.PathOf("encrypted-rar5.rar"), new ReaderOptions { Password = Password });
        var entry = archive.Entries.First(e => !e.IsDirectory);
        using var sharpCompressStream = entry.OpenEntryStream();
        using var sharpCompressBytes = new MemoryStream();
        sharpCompressStream.CopyTo(sharpCompressBytes);

        Assert.Equal(Payload, sharpCompressBytes.ToArray());
    }

    [Fact]
    public async Task MultiVolume_CorrectPassword_DecryptsExactOriginalBytes_AcrossVolumeBoundaries()
    {
        var (file, partNames) = await ReadMultiVolumeFile(Password);

        await using var stream = new RarStoredFileStream(
            file,
            (partIndex, _) => new ValueTask<Stream>(File.OpenRead(RarFixtures.PathOf(partNames[partIndex]))),
            Password);
        using var ms = new MemoryStream();
        await stream.CopyToAsync(ms);

        Assert.Equal(Payload, ms.ToArray());

        // Also cross-validate the multi-volume case against SharpCompress's own
        // independent reassembly + decryption across the same volume boundary.
        IReadOnlyList<Stream> parts = partNames.Select(p => (Stream)File.OpenRead(RarFixtures.PathOf(p))).ToList();
        using var archive = RarArchive.OpenArchive(parts, new ReaderOptions { Password = Password });
        var entry = archive.Entries.First(e => !e.IsDirectory);
        using var sharpCompressStream = entry.OpenEntryStream();
        using var sharpCompressBytes = new MemoryStream();
        sharpCompressStream.CopyTo(sharpCompressBytes);
        Assert.Equal(Payload, sharpCompressBytes.ToArray());
    }

    [Theory]
    [InlineData(0, 50)] // start of volume 1
    [InlineData(7_999, 2)] // last byte of volume 1 + first byte of volume 2 (still same slice each side)
    [InlineData(8_000, 50)] // starts exactly at the volume 1/2 boundary -- a fresh IV, not a continued chain
    [InlineData(15_999, 1)] // last byte mapped by volume 2
    public async Task MultiVolume_RandomAccessReadWithinOrAtVolumeBoundary_MatchesDirectSlice(int offset, int count)
    {
        var (file, partNames) = await ReadMultiVolumeFile(Password);

        await using var stream = new RarStoredFileStream(
            file,
            (partIndex, _) => new ValueTask<Stream>(File.OpenRead(RarFixtures.PathOf(partNames[partIndex]))),
            Password);
        var buffer = await ReadExactAsync(stream, offset, count);

        Assert.Equal(Payload.AsSpan(offset, count).ToArray(), buffer);
    }

    private static async Task<(RarStoredFile File, string[] PartNames)> ReadMultiVolumeFile(string password)
    {
        var partNames = MultiVolumeParts.Where(name => File.Exists(RarFixtures.PathOf(name))).ToArray();
        Assert.True(partNames.Length >= 2, "Expected the encrypted multi-volume fixture to span several parts.");

        var volumes = new List<RarVolume>();
        foreach (var name in partNames)
        {
            await using var stream = File.OpenRead(RarFixtures.PathOf(name));
            volumes.Add(await RarVolumeReader.ReadAsync(stream, name, CancellationToken.None, password));
        }

        var file = Assert.Single(RarArchiveIndexer.Index(volumes));
        Assert.True(file.IsEncrypted);
        return (file, partNames);
    }

    private static async Task<byte[]> ReadExactAsync(RarStoredFileStream stream, int offset, int count)
    {
        stream.Seek(offset, SeekOrigin.Begin);
        var buffer = new byte[count];
        var read = 0;
        while (read < count)
        {
            var n = await stream.ReadAsync(buffer.AsMemory(read, count - read));
            Assert.True(n > 0, "Unexpected end of decrypted stream.");
            read += n;
        }

        return buffer;
    }

    private static async Task<RarVolume> ReadVolume(string fixture, string password)
    {
        await using var stream = File.OpenRead(RarFixtures.PathOf(fixture));
        return await RarVolumeReader.ReadAsync(stream, fixture, CancellationToken.None, password);
    }

    /// <summary>
    /// Sequential encrypted reads must keep all volume IO strictly forward. The CBC
    /// previous-block used to be re-read with a backward seek per read; over an
    /// NzbFileStream every such seek tears down the read-ahead pipeline and re-downloads
    /// a full article, which starved live playback of encrypted releases (~20x wire waste).
    /// </summary>
    [Fact]
    public async Task MultiVolume_SequentialRead_NeverSeeksVolumeStreamsBackward()
    {
        var (file, partNames) = await ReadMultiVolumeFile(Password);
        var backwardSeeks = 0;
        var opens = 0;

        await using var stream = new RarStoredFileStream(
            file,
            (partIndex, _) =>
            {
                opens++;
                return new ValueTask<Stream>(new SeekDirectionTrackingStream(
                    File.OpenRead(RarFixtures.PathOf(partNames[partIndex])),
                    onBackwardSeek: () => backwardSeeks++));
            },
            Password);
        using var ms = new MemoryStream();
        // Small copy buffer so many small unaligned reads exercise the block cache.
        await stream.CopyToAsync(ms, 4096);

        Assert.Equal(Payload, ms.ToArray());
        Assert.Equal(0, backwardSeeks);
        Assert.Equal(file.Slices.Select(s => s.PartIndex).Distinct().Count(), opens);
    }

    private sealed class SeekDirectionTrackingStream(FileStream inner, Action onBackwardSeek) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => true;
        public override bool CanWrite => false;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => Seek(value, SeekOrigin.Begin); }

        public override long Seek(long offset, SeekOrigin origin)
        {
            var target = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => inner.Position + offset,
                _ => inner.Length + offset,
            };
            if (target < inner.Position)
                onBackwardSeek();
            return inner.Seek(target, SeekOrigin.Begin);
        }

        public override int Read(byte[] buffer, int offset, int count) => inner.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken ct = default)
            => inner.ReadAsync(buffer, ct);
        public override void Flush() { }
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
