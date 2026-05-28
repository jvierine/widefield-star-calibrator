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

`yale_asterisms_mag4_min1p5_max40.bin.gz` is generated from
`js/star_catalog.js`. It stores precomputed Yale triangular asterisms using
stars brighter than or equal to visual magnitude 4.0, pairwise separations
between 1.5 and 40 degrees, and side ratios sorted as `a <= b <= c`.

The binary payload is platform independent:

- gzip-compressed byte stream
- bytes `0..7`: ASCII magic `WISAST1\0`
- bytes `8..11`: unsigned 32-bit little-endian asterism count
- bytes `12..15`: unsigned 32-bit little-endian source Yale star count
- bytes `16..19`: unsigned 32-bit little-endian record stride in bytes,
  currently `20`
- bytes `20..31`: IEEE-754 binary32 little-endian metadata
  `[maxMag, minSepDeg, maxSepDeg]`
- records: `[float32 a/c, float32 b/c, uint16 yale_i0, uint16 yale_i1,
  uint16 yale_i2, uint16 reserved, float32 longest_side_deg]`

The browser loader exposes `get_asterisms(ac, bc, delta_ac, delta_bc)`, which
returns record indices in the rectangular signature window. Regenerate with:

```sh
npm run catalog:yale-asterisms
```

Use environment variables to make deeper or tighter variants:

```sh
YALE_ASTERISM_MAX_MAG=6 YALE_ASTERISM_MIN_SEP_DEG=1.5 YALE_ASTERISM_MAX_SEP_DEG=30 npm run catalog:yale-asterisms
```
