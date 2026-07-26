#!/usr/bin/env python3
"""One-time generator for the checked-in RAR test fixtures.

The `rar` CLI cannot run headlessly on this machine (Gatekeeper), so these
fixtures are built by hand following the RAR 4.x ("technote" OLD) and RAR 5.0
archive format specifications (https://www.rarlab.com/technote.htm), stored
(method m0) only. Their correctness is asserted in RarFixtureSanityTests by
extracting them with SharpCompress (an independent reader) and comparing
against the deterministic payloads produced by `lcg_bytes` below.

Run from this directory:  python3 generate_fixtures.py
"""

import hashlib
import zlib
import struct
import os

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

# ---------------------------------------------------------------- payloads


def lcg_bytes(seed: int, n: int) -> bytes:
    out = bytearray()
    x = seed
    for _ in range(n):
        x = (1103515245 * x + 12345) % (1 << 31)
        out.append(x & 0xFF)
    return bytes(out)


PAYLOAD = lcg_bytes(42, 96 * 1024)  # 96 KiB pseudo-random media stand-in
NOTES = b"Streamarr RAR fixture: small stored text entry.\n" * 4

# Deliberately NOT a multiple of 16: exercises the CBC padding on the file's final
# ciphertext block (RarArchiveIndexer clamping ByteRangeWithinFile below the padded
# ByteRangeWithinPart).
ENCRYPTED_PAYLOAD = lcg_bytes(99, 40_000)
ENCRYPTED_PASSWORD = "correct horse battery staple"
# Tiny on purpose: only the KDF *formula* (1 << Lg2Count) is under test here, not
# real-world hardness, so keep fixture generation and test runs fast.
ENCRYPTED_KDF_COUNT = 3

# ---------------------------------------------------------------- RAR4 (OLD)

RAR4_MARKER = b"Rar!\x1a\x07\x00"


def crc16(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFF


def rar4_main_header(volume: bool, first_volume: bool) -> bytes:
    flags = 0
    if volume:
        flags |= 0x0001  # MHD_VOLUME
        if first_volume:
            flags |= 0x0100  # MHD_FIRSTVOLUME
    body = struct.pack("<BHH", 0x73, flags, 13) + struct.pack("<HI", 0, 0)
    return struct.pack("<H", crc16(body)) + body


def rar4_file_header(name: bytes, chunk: bytes, unp_size: int,
                     split_before: bool, split_after: bool,
                     method: int = 0x30) -> bytes:
    flags = 0x8000  # long block: ADD_SIZE (PACK_SIZE) present
    if split_before:
        flags |= 0x0001  # LHD_SPLIT_BEFORE
    if split_after:
        flags |= 0x0002  # LHD_SPLIT_AFTER
    head_size = 32 + len(name)
    body = struct.pack(
        "<BHHIIBIIBBHI",
        0x74,               # HEAD_TYPE
        flags,              # HEAD_FLAGS
        head_size,          # HEAD_SIZE
        len(chunk),         # PACK_SIZE
        unp_size,           # UNP_SIZE
        2,                  # HOST_OS (win32)
        zlib.crc32(chunk),  # FILE_CRC (crc of this volume's chunk)
        0x5A21A020,         # FTIME (arbitrary DOS time)
        20,                 # UNP_VER
        method,             # METHOD (0x30 = stored)
        len(name),          # NAME_SIZE
        0x20,               # ATTR
    ) + name
    return struct.pack("<H", crc16(body)) + body + chunk


def write_rar4_single(path: str, entries, method: int = 0x30) -> None:
    with open(path, "wb") as f:
        f.write(RAR4_MARKER)
        f.write(rar4_main_header(volume=False, first_volume=False))
        for name, data in entries:
            f.write(rar4_file_header(name, data, len(data), False, False, method))


def write_rar4_encrypted_header(path: str, entries) -> None:
    """A RAR4 archive with MHD_PASSWORD set on the main header (RAR's -hp option):
    block headers themselves are encrypted, so SharpCompress can't even enumerate
    entries without a password and throws CryptographicException mid-walk (before
    any per-file header is readable). This regresses the /resolve 500 caused by
    that exception escaping RarVolumeReader unhandled."""
    flags = 0x0080  # MHD_PASSWORD
    body = struct.pack("<BHH", 0x73, flags, 13) + struct.pack("<HI", 0, 0)
    main_header = struct.pack("<H", crc16(body)) + body
    with open(path, "wb") as f:
        f.write(RAR4_MARKER)
        f.write(main_header)
        for name, data in entries:
            f.write(rar4_file_header(name, data, len(data), False, False))


def write_rar4_multi(base: str, name: bytes, data: bytes, chunk_size: int) -> None:
    chunks = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]
    for i, chunk in enumerate(chunks):
        # old-style numbering: .rar, .r00, .r01, ...
        ext = ".rar" if i == 0 else ".r%02d" % (i - 1)
        with open(base + ext, "wb") as f:
            f.write(RAR4_MARKER)
            f.write(rar4_main_header(volume=True, first_volume=i == 0))
            f.write(rar4_file_header(
                name, chunk, len(data),
                split_before=i > 0,
                split_after=i < len(chunks) - 1,
            ))

# ---------------------------------------------------------------- RAR5


RAR5_SIGNATURE = b"Rar!\x1a\x07\x01\x00"


def vint(value: int) -> bytes:
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def rar5_block(header_data: bytes, data_area: bytes = b"") -> bytes:
    size = vint(len(header_data))
    crc = zlib.crc32(size + header_data)
    return struct.pack("<I", crc) + size + header_data + data_area


def rar5_main_header(volume: bool, volume_number=None) -> bytes:
    archive_flags = 0
    if volume:
        archive_flags |= 0x0001
    if volume_number is not None:
        archive_flags |= 0x0002
    body = vint(1) + vint(0) + vint(archive_flags)  # type=1, header flags=0
    if volume_number is not None:
        body += vint(volume_number)
    return rar5_block(body)


def rar5_file_header(name: bytes, chunk: bytes, unp_size: int,
                     split_before: bool, split_after: bool,
                     method: int = 0) -> bytes:
    header_flags = 0x0002  # data area present
    if split_before:
        header_flags |= 0x0008
    if split_after:
        header_flags |= 0x0010
    compression_info = (method & 0x7) << 7  # version 0, not solid, dict 128KB
    body = (
        vint(2)                  # type = file header
        + vint(header_flags)
        + vint(len(chunk))       # data size
        + vint(0)                # file flags (no mtime, no crc)
        + vint(unp_size)
        + vint(0x20)             # attributes
        + vint(compression_info)
        + vint(0)                # host os = windows
        + vint(len(name))
        + name
    )
    return rar5_block(body, chunk)


def rar5_end_header(more_volumes: bool) -> bytes:
    body = vint(5) + vint(0) + vint(0x0001 if more_volumes else 0)
    return rar5_block(body)


def write_rar5_single(path: str, entries, method: int = 0) -> None:
    with open(path, "wb") as f:
        f.write(RAR5_SIGNATURE)
        f.write(rar5_main_header(volume=False, volume_number=None))
        for name, data in entries:
            f.write(rar5_file_header(name, data, len(data), False, False, method))
        f.write(rar5_end_header(more_volumes=False))


def write_rar5_multi(base: str, name: bytes, data: bytes, chunk_size: int) -> None:
    chunks = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]
    for i, chunk in enumerate(chunks):
        path = "%s.part%d.rar" % (base, i + 1)
        with open(path, "wb") as f:
            f.write(RAR5_SIGNATURE)
            f.write(rar5_main_header(volume=True, volume_number=i if i > 0 else None))
            f.write(rar5_file_header(
                name, chunk, len(data),
                split_before=i > 0,
                split_after=i < len(chunks) - 1,
            ))
            f.write(rar5_end_header(more_volumes=i < len(chunks) - 1))

# ------------------------------------------------------- RAR5 AES-256 (password)


def derive_key(password: str, salt: bytes, kdf_count: int) -> bytes:
    """RAR5 spec: PBKDF2-HMAC-SHA256, 1 << kdf_count rounds, 32-byte key."""
    iterations = 1 << kdf_count
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations, dklen=32)


def aes256_cbc_encrypt(key: bytes, iv: bytes, data: bytes) -> bytes:
    assert len(data) % 16 == 0
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return encryptor.update(data) + encryptor.finalize()


def rar5_encryption_extra_record(salt: bytes, init_v: bytes, kdf_count: int) -> bytes:
    """RAR5 file-header extra-area "Encryption" record (type 0x01): version(vint)=0,
    flags(vint), KDF round count (vint), 16-byte salt, 16-byte CBC IV for the start
    of this file's ciphertext, then an (unverified) password-check value.

    SharpCompress's FileHeader parser nulls out Rar5CryptoInfo (and so IsEncrypted)
    whenever PswCheck.All(b => b == 0) -- which is vacuously *true* for an empty
    array when the FHEXTRA_CRYPT_PSWCHECK flag is unset, since PswCheck is then
    never assigned. So the check value must be present (flag bit set) and non-zero,
    even though nothing here -- SharpCompress's own decompression included --
    actually verifies it matches the password."""
    assert len(salt) == 16 and len(init_v) == 16
    psw_check = bytes(range(1, 9))
    psw_check_csum = bytes(range(9, 13))
    type_and_data = (
        vint(0x01) + vint(0) + vint(1)  # version=0, flags=FHEXTRA_CRYPT_PSWCHECK
        + vint(kdf_count) + salt + init_v + psw_check + psw_check_csum
    )
    return vint(len(type_and_data)) + type_and_data


def rar5_file_header_encrypted(name: bytes, cipher_chunk: bytes, unp_size: int,
                               split_before: bool, split_after: bool,
                               salt: bytes, init_v: bytes, kdf_count: int) -> bytes:
    """Like rar5_file_header, but the data area is already-encrypted ciphertext
    (a whole 16-byte-aligned multiple) and the header carries an Encryption extra
    record so SharpCompress (and our own reader) can find Salt/InitV/KDF count."""
    header_flags = 0x0002 | 0x0001  # data area + extra area present
    if split_before:
        header_flags |= 0x0008
    if split_after:
        header_flags |= 0x0010
    extra = rar5_encryption_extra_record(salt, init_v, kdf_count)
    body = (
        vint(2)                   # type = file header
        + vint(header_flags)
        + vint(len(extra))        # extra area size
        + vint(len(cipher_chunk)) # data size (this slice's ciphertext length)
        + vint(0)                 # file flags (no mtime, no crc)
        + vint(unp_size)          # true plaintext size of the whole (multi-volume) file
        + vint(0x20)              # attributes
        + vint(0)                 # compression info (method 0 = stored, version 0)
        + vint(0)                 # host os = windows
        + vint(len(name))
        + name
        + extra
    )
    return rar5_block(body, cipher_chunk)


def write_rar5_encrypted_single(path: str, name: bytes, payload: bytes, password: str, kdf_count: int = 3) -> None:
    """A single-volume RAR5 archive whose one stored file is AES-256-CBC encrypted
    (RAR5 password protection, e.g. WinRAR's "encrypt file data" option). Headers
    themselves are NOT encrypted here (that's the separate -hp/archive-header-crypt
    case already covered by encrypted-header-rar4.rar) — only the file's data,
    which is what RarAesCbcDecryptor actually decrypts."""
    salt = bytes(range(16))
    init_v = bytes(range(16, 32))
    key = derive_key(password, salt, kdf_count)
    pad = (-len(payload)) % 16
    ciphertext = aes256_cbc_encrypt(key, init_v, payload + b"\x00" * pad)

    with open(path, "wb") as f:
        f.write(RAR5_SIGNATURE)
        f.write(rar5_main_header(volume=False, volume_number=None))
        f.write(rar5_file_header_encrypted(
            name, ciphertext, len(payload),
            split_before=False, split_after=False,
            salt=salt, init_v=init_v, kdf_count=kdf_count,
        ))
        f.write(rar5_end_header(more_volumes=False))


def write_rar5_encrypted_multi(base: str, name: bytes, payload: bytes, chunk_size: int,
                               password: str, kdf_count: int = 3) -> None:
    """Multi-volume counterpart: unlike the unencrypted stored case (where a split
    file's bytes are one continuous range across volumes), RAR encrypts *each
    volume's contribution independently* -- confirmed empirically by cross-checking
    against SharpCompress's own decompression of an early (wrong) version of this
    fixture that assumed one continuous cipher stream: it decrypted the first volume
    correctly and diverged exactly at the second volume's first block. So each
    plaintext chunk is padded and AES-256-CBC encrypted on its own, with its own
    (here: distinct, to prove readers can't get away with reusing volume 1's IV)
    16-byte IV recorded in that volume's own file header. `chunk_size` must be a
    multiple of 16 for every volume but the last, matching how real archivers only
    ever need to pad the file's true final volume."""
    assert chunk_size % 16 == 0
    salt = bytes(range(16))
    key = derive_key(password, salt, kdf_count)

    plaintext_chunks = [payload[i:i + chunk_size] for i in range(0, len(payload), chunk_size)]
    for i, plain_chunk in enumerate(plaintext_chunks):
        init_v = bytes([(i + 1) % 256] * 16)  # distinct per volume, on purpose
        pad = (-len(plain_chunk)) % 16
        cipher_chunk = aes256_cbc_encrypt(key, init_v, plain_chunk + b"\x00" * pad)

        path = "%s.part%d.rar" % (base, i + 1)
        with open(path, "wb") as f:
            f.write(RAR5_SIGNATURE)
            f.write(rar5_main_header(volume=True, volume_number=i if i > 0 else None))
            f.write(rar5_file_header_encrypted(
                name, cipher_chunk, len(payload),
                split_before=i > 0,
                split_after=i < len(plaintext_chunks) - 1,
                salt=salt, init_v=init_v, kdf_count=kdf_count,
            ))
            f.write(rar5_end_header(more_volumes=i < len(plaintext_chunks) - 1))

# ---------------------------------------------------------------- outputs


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    with open("payload.bin", "wb") as f:
        f.write(PAYLOAD)
    with open("notes.txt", "wb") as f:
        f.write(NOTES)

    entries = [(b"payload.bin", PAYLOAD), (b"notes.txt", NOTES)]
    write_rar4_single("single-rar4.rar", entries)
    write_rar5_single("single-rar5.rar", entries)
    write_rar4_multi("multi-rar4", b"payload.bin", PAYLOAD, 32 * 1024)
    write_rar5_multi("multi-rar5", b"payload.bin", PAYLOAD, 32 * 1024)

    # fake "compressed" archives: method bits != store, headers only get walked
    write_rar4_single("compressed-rar4.rar", [(b"notes.txt", NOTES)], method=0x33)
    write_rar5_single("compressed-rar5.rar", [(b"notes.txt", NOTES)], method=3)

    # header-encrypted archive (RAR's -hp option): can't be enumerated without a password.
    write_rar4_encrypted_header("encrypted-header-rar4.rar", [(b"notes.txt", NOTES)])

    # RAR5 AES-256 per-file data encryption (real ciphertext, real PBKDF2 params).
    write_rar5_encrypted_single(
        "encrypted-rar5.rar", b"secret.bin", ENCRYPTED_PAYLOAD, ENCRYPTED_PASSWORD, ENCRYPTED_KDF_COUNT)
    write_rar5_encrypted_multi(
        "encrypted-multi-rar5", b"secret.bin", ENCRYPTED_PAYLOAD, 8_000, ENCRYPTED_PASSWORD, ENCRYPTED_KDF_COUNT)

    print("fixtures written")


if __name__ == "__main__":
    main()
