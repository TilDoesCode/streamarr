// Written for Streamarr.

using System.Security.Cryptography;
using System.Text;

namespace Streamarr.Usenet.Rar;

/// <summary>
/// RAR5 AES-256-CBC decryption for random-access reads.
///
/// RAR encrypts a stored (uncompressed) file's plaintext bytes directly — there is no
/// separate compression step for method m0 — so decrypting the raw ciphertext IS the
/// finished file. Key derivation is the standard RAR5 scheme: PBKDF2-HMAC-SHA256 over
/// the UTF-8 password and a 16-byte salt, with <c>1 &lt;&lt; lg2Count</c> rounds
/// producing a 32-byte AES-256 key (<see cref="DeriveKey"/>).
///
/// CBC decryption is inherently seek-friendly: plaintext[i] = AES-ECB-decrypt(cipher[i])
/// XOR cipher[i-1] (or XOR the file's IV for block 0). Rather than a stateful,
/// forward-only <see cref="ICryptoTransform"/>, <see cref="Decrypt"/> does this XOR
/// chaining itself so any block can be decrypted independently given whatever ciphertext
/// precedes it — which is exactly what <c>RarStoredFileStream</c>'s existing per-volume
/// seek plumbing can already fetch.
/// </summary>
public static class RarAesCbcDecryptor
{
    public const int BlockSize = 16;
    public const int KeyLength = 32;

    /// <summary>Derives the file's 32-byte AES-256 key from its password, salt, and round count.</summary>
    public static byte[] DeriveKey(string password, byte[] salt, int lg2Count)
    {
        ArgumentNullException.ThrowIfNull(password);
        ArgumentNullException.ThrowIfNull(salt);
        if (lg2Count is < 0 or > 24)
            throw new ArgumentOutOfRangeException(nameof(lg2Count), "RAR5 KDF round count is out of range.");

        var iterations = 1 << lg2Count;
        return Rfc2898DeriveBytes.Pbkdf2(
            Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, KeyLength);
    }

    /// <summary>
    /// Decrypts one or more whole 16-byte ciphertext blocks (CBC). <paramref name="previousCipherBlock"/>
    /// must be either the file's initialization vector (for the very first block of the file's
    /// ciphertext stream) or the raw ciphertext bytes immediately preceding
    /// <paramref name="cipherBlocks"/> — wherever those physically live (possibly a different
    /// RAR volume than the one being decrypted).
    /// </summary>
    public static byte[] Decrypt(byte[] key, byte[] previousCipherBlock, byte[] cipherBlocks)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(previousCipherBlock);
        ArgumentNullException.ThrowIfNull(cipherBlocks);
        if (previousCipherBlock.Length != BlockSize)
            throw new ArgumentException($"Expected a {BlockSize}-byte block.", nameof(previousCipherBlock));
        if (cipherBlocks.Length == 0 || cipherBlocks.Length % BlockSize != 0)
            throw new ArgumentException(
                "Ciphertext must be a non-zero multiple of the block size.", nameof(cipherBlocks));

        using var aes = Aes.Create();
        aes.Key = key;
        aes.Mode = CipherMode.ECB;
        aes.Padding = PaddingMode.None;
        using var transform = aes.CreateDecryptor();

        var plaintext = new byte[cipherBlocks.Length];
        var previous = (byte[])previousCipherBlock.Clone();
        var ecbBlock = new byte[BlockSize];

        for (var offset = 0; offset < cipherBlocks.Length; offset += BlockSize)
        {
            transform.TransformBlock(cipherBlocks, offset, BlockSize, ecbBlock, 0);
            for (var b = 0; b < BlockSize; b++)
                plaintext[offset + b] = (byte)(ecbBlock[b] ^ previous[b]);

            Buffer.BlockCopy(cipherBlocks, offset, previous, 0, BlockSize);
        }

        return plaintext;
    }
}
