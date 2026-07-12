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

import zlib
import struct
import os

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

    print("fixtures written")


if __name__ == "__main__":
    main()
