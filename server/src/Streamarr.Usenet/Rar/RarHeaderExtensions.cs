// Ported from nzbdav (https://github.com/nzbdav-dev/nzbdav), MIT License.
// Source: backend/Extensions/{RarHeaderExtensions,ReflectionExtensions}.cs
//         @ 794948be293eaade7e495cb9ea88045ae33d699b
// See NOTICE at the repository root. Modified for Streamarr:
// AES/password support dropped (password-protected archives are rejected upstream);
// numeric conversions hardened for SharpCompress 0.49.x.

using System.Reflection;
using SharpCompress.Common.Rar.Headers;

namespace Streamarr.Usenet.Rar;

/// <summary>
/// SharpCompress keeps the RAR header details internal; like nzbdav we read them
/// via reflection. The SharpCompress version is pinned in Streamarr.Usenet.csproj
/// and these accessors are exercised by the RAR fixture tests.
/// </summary>
public static class RarHeaderExtensions
{
    private static object? GetReflectionProperty(this object obj, string propertyName)
    {
        var property = obj.GetType().GetProperty(
            propertyName,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (property == null)
            throw new MissingMemberException(obj.GetType().FullName, propertyName);
        return property.GetValue(obj);
    }

    private static object? GetReflectionField(object obj, string fieldName)
    {
        var field = obj.GetType().GetField(
            fieldName,
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (field == null)
            throw new MissingMemberException(obj.GetType().FullName, fieldName);
        return field.GetValue(obj);
    }

    public static byte GetCompressionMethod(this IRarHeader header)
    {
        return (byte)header.GetReflectionProperty("CompressionMethod")!;
    }

    public static bool GetIsStored(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsStored")!;
    }

    public static long GetDataStartPosition(this IRarHeader header)
    {
        return (long)header.GetReflectionProperty("DataStartPosition")!;
    }

    public static long GetAdditionalDataSize(this IRarHeader header)
    {
        return (long)header.GetReflectionProperty("AdditionalDataSize")!;
    }

    public static long GetCompressedSize(this IRarHeader header)
    {
        return (long)header.GetReflectionProperty("CompressedSize")!;
    }

    public static long GetUncompressedSize(this IRarHeader header)
    {
        return (long)header.GetReflectionProperty("UncompressedSize")!;
    }

    public static string GetFileName(this IRarHeader header)
    {
        return (string)header.GetReflectionProperty("FileName")!;
    }

    public static bool IsDirectory(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsDirectory")!;
    }

    public static bool GetIsSplitBefore(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsSplitBefore")!;
    }

    public static bool GetIsSplitAfter(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsSplitAfter")!;
    }

    public static int? GetVolumeNumber(this IRarHeader header)
    {
        var value = header.GetReflectionProperty("VolumeNumber");
        return value == null ? null : Convert.ToInt32(value);
    }

    public static bool GetIsFirstVolume(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsFirstVolume")!;
    }

    public static bool GetIsEncrypted(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsEncrypted")!;
    }

    public static bool GetIsSolid(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsSolid")!;
    }

    public static bool GetIsRar5(this IRarHeader header)
    {
        return (bool)header.GetReflectionProperty("IsRar5")!;
    }

    /// <summary>
    /// RAR5 per-file AES-256-CBC encryption parameters (salt/IV/KDF round count),
    /// read from SharpCompress's internal <c>FileHeader.Rar5CryptoInfo</c>. Null when
    /// the entry isn't encrypted, or uses legacy (RAR3/4) encryption instead.
    /// </summary>
    public static RarFileCrypto? GetRar5Crypto(this IRarHeader header)
    {
        var info = header.GetReflectionProperty("Rar5CryptoInfo");
        if (info is null)
            return null;

        var salt = (byte[])GetReflectionField(info, "Salt")!;
        var initV = (byte[])GetReflectionField(info, "InitV")!;
        var lg2Count = (int)GetReflectionField(info, "LG2Count")!;
        return new RarFileCrypto
        {
            Salt = salt,
            InitV = initV,
            Lg2Count = lg2Count,
        };
    }
}
