# par2cmdline golden fixture

These files cross-check Streamarr's PAR2 parser and GF(2^16) reconstruction against an
independent implementation. The Creator packet records **par2cmdline 0.8.1**. From
this directory, the checked-in parity layout can be reproduced from the canonical
source with:

```sh
par2create -s65536 -c4 -n2 golden.par2 golden-source.bin
```

Verify the fixture before replacing it:

```text
62aa46bf058090419437430a57645874d3534984ca38cd811e9c75fe9eb7fa62  golden-source.bin
9ad2a18d3a4459e605d6a7841a4d509f0ac1b6a445112f747b26751360af3e08  golden.par2
ae72b78f413aa59a5cd1d95e425b3e586fd95dfc172aff523f20243ed7bf8722  golden.vol0+2.par2
8bcf5b371154c126dcb7d76d729193deb389093fd70db203d28cae3646856200  golden.vol2+2.par2
```

The source itself is retained so regeneration does not depend on a pseudo-random
generator or platform-specific byte stream. A replacement must update all four hashes
and continue to pass the golden parser and recovery tests.
