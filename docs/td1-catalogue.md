# TD-1 far-ultraviolet star overlay

Choose **Stars → Star catalogue → TD-1 far UV · 156.5 nm**. The limiting
magnitude and marker brightness now refer to AB magnitude at 156.5 nm, not
visual magnitude. Increase the limit to show fainter UV stars; Yale and
Tycho remain selectable. Existing manually associated stars are retained.
The UV slider extends to AB magnitude 13. The bundled S/N≥5 subset reaches
12.9286 and contains 152 entries between 12 and 13; increasing the limit
exposes those existing measurements, not a deeper or complete magnitude-13
survey. No lower-quality entries or optical magnitudes are substituted.

**Show RA/Dec grid** draws celestial coordinates through the current lens.
For narrow spacecraft views with a frame ephemeris, it uses a local J2000
grid (typically 1° declination and 15-minute RA spacing) rather than the
ground camera's coarse all-sky grid. It follows lens edits, pointing, zoom,
image flips and frame changes; labels are placed on visible grid portions.
The grid visualizes the assumed model and is not an independent calibration
constraint, especially in areas without identified stars.

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
