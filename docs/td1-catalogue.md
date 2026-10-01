# TD-1 far-ultraviolet star overlay

Choose **Stars → Star catalogue → TD-1 far UV · 156.5 nm**. The limiting
magnitude and marker brightness now refer to AB magnitude at 156.5 nm, not
visual magnitude. Increase the limit to show fainter UV stars; Yale and
Tycho remain selectable. Existing manually associated stars are retained.

The bundled 17,762 entries have positive flux and uncertainty and F1565
signal-to-noise at least 5 in Thompson et al. (1978), CDS II/59B:
https://cdsarc.cds.unistra.fr/ftp/II/59B/ReadMe

The builder converts FK4/B1950 positions to FK5/J2000 with Astropy. No
proper motions are supplied or inferred. It computes AB magnitude from
F_lambda in erg/s/cm²/Angstrom using
`m_AB = -2.5 log10(F_lambda) - 5 log10(1565) - 2.406`.
The 156.5-nm broad-band measurement is a UV visibility proxy, not an exact
SMILE UVI bandpass convolution. Blended/missing sources and colour-dependent
brightness differences remain possible. Validate a pointing fit against
independent stars and multiple frames.

Rebuild with `conda run -n base python tools/build_td1_catalog.py INPUT.gz`,
where INPUT.gz is the original CDS II/59B/catalog.dat.gz. Source URL and
SHA-256 are stored in both outputs: the scientific HDF5 product and the
compact JSON browser asset. The ordinary overlay and nearby matching use
TD-1 when selected; specialised precomputed Yale blind-identification
indexes remain Yale-specific.
