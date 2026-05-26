# Catalogue Data

`tycho2_mag8.bin.gz` is generated from the Tycho-2 main catalogue plus
`suppl_1.dat` and `suppl_2.dat`. The generator keeps entries with
`V_T < 8`, sorts them by `V_T`, and writes a compact browser catalogue.

The binary payload is platform independent:

- gzip-compressed byte stream
- bytes `0..7`: ASCII magic `WISCAT1\0`
- bytes `8..11`: unsigned 32-bit little-endian star count
- bytes `12..15`: unsigned 32-bit little-endian float stride, currently `3`
- records: IEEE-754 binary32 little-endian triples
  `[raHours, decDeg, vtMag]`

For the Tycho-2 main catalogue, the generator uses the J2000 mean position
columns `RAmdeg` and `DEmdeg`, not the observed Tycho position columns. The
supplement files use their `RAdeg`, `DEdeg`, and `VTmag` fields.

Regenerate with:

```sh
node tools/build_tycho2_catalog.js
```

