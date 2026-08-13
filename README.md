# WISC - Widefield Star Calibrator

[![Fast Unit Tests](https://github.com/jvierine/widefield-star-calibrator/actions/workflows/fast-tests.yml/badge.svg)](https://github.com/jvierine/widefield-star-calibrator/actions/workflows/fast-tests.yml)

This repository contains WISC, the Widefield Star Calibrator, a stand-alone
JavaScript wide-field star calibration tool. WISC can run star finding,
asterism matching, and lens-model fitting as a somewhat robust automated
process. The strength of the code, and the reason for the JavaScript
implementation, is the interactive browser GUI for fine tuning, inspection, and
completely manual star-pairing based optical model fitting assisted by the Yale
Bright Star Catalogue. This is useful for difficult images that do not
automatically plate solve cleanly.
However, it can also be installed and run on the command line like a normal
Linux/Unix command-line program named `wisc`; see the command-line section
below.

Authors: Juha Vierinen and Björn Gustavsson. More authors can be added later.
Merge requests are welcome!

Acknowledgements: The tool was inspired by the legendary aurora image data
analysis (AIDA) MATLAB tools. This repository only implements the lens-model
calibration parts needed by the browser and command-line calibrator. Original
AIDA_tools MATLAB toolbox: https://github.com/jvierine/AIDA_tools. Thank you
to Daniel Kastinen for suggesting making this a web page. The blind
asterism-search ideas are also informed by astrometry.net. The star-detection
experiments and reports were also informed by SExtractor and
[SEP](https://sep.readthedocs.io/). Codex is gratefully acknowledged for
contributions to implementation and testing.

License: Creative Commons Attribution 4.0 International (CC BY 4.0). See
[`LICENSE.md`](LICENSE.md).

Try the hosted version here:

http://4.235.86.214/aida/

![WISC GUI](docs/gui-screenshot.png)

The tool is fully client-side JavaScript, with the GUI rendered in WebGL. For
normal GUI use, no installation is required: open the hosted link above in a
browser, or open `index.html` directly from a local checkout:

```bash
git clone https://github.com/jvierine/widefield-star-calibrator.git
code widefield-star-calibrator
# open index.html
```

Hosted test cases can also have short quick links. Create or update one with:

```bash
npm run quicklink -- tc01 Sunniva_Alomar_23-03-2023_21-30UT
```

This writes `quick_links.json` and a small `tc01/index.html` redirect. After
deployment, `https://juha.no/aida/tc01` opens the browser GUI and loads the
mapped saved test case. If a short name is not listed in `quick_links.json`,
WISC tries to load a saved test case with that exact id.

DDR data policy disclaimer: all data goes directly to STASI main archives. Just
kidding. Most calibration work is purely client-side JavaScript. Images are not
uploaded during ordinary viewing, star picking, fitting, or code export. If you
click "Submit as test case", the browser uploads the currently loaded image and
the current calibration metadata to the server. The stored metadata includes the
test-case id, image filename, image dimensions, UTC timestamp, observer latitude,
longitude and altitude, selected optical model and `optpar`, display/flip
settings, marked bad star-finder detections/regions, residual summary, and the
picked image-to-catalog star pairings with catalog names, coordinates, and
magnitudes. On the hosted deployment these submitted test cases are stored on
the server for testing and development of the calibrator.

Kudos to the person who finds all the easter eggs hidden in the GUI.

## What It Does

- Fits optical models manually in the browser by picking image stars and
  pairing them with catalog stars.
- Fits optical models automatically with the `L` / `I'm feeling lucky`
  workflow, which detects stars, matches triangle asterisms, fits the selected
  lens model, expands to fainter stars, and prunes obvious bad automatic
  matches.
- Loads PNG, JPEG, HEIC, HEIF, and FITS images.
- Loads a bundled iPhone HEIC example image automatically on startup.
- Reads UTC time and observer position from EXIF metadata when available.
- Falls back to known allsky7 filename/station metadata when possible.
- Uses the embedded bright-star catalog and AIDA camera projection code.
- Supports the self-contained parametric AIDA/MATLAB lens models (`optmod 1`,
  `2`, `3`, `4`, `5`, `6`, and `12`) plus a Brown-Conrady radial/tangential
  distortion model under browser `optmod 20`; the selected optical model is
  the one used by the fit.
- Lets the user manually pick image stars with a 40x interpolated density
  estimate and pair them with catalog stars.
- Fits the model-specific `optpar` vector: eight parameters for AIDA radial
  models, and twelve for Brown-Conrady with `k1`, `k2`, `k3`, `p1`, and `p2`.
- Copies the fitted `optpar`, directly downloads the compact fit HDF5, and can
  download an HDF5 azimuth/elevation map for every image pixel.
- Generates a ZIP report bundle with LaTeX source, star-overlay figures,
  residual plots, one base image, bare Python overlay scripts, and an optional
  script that creates the HDF5 az/el grid locally.
- Shows RGB images in color when the high-pass image display option is off.
- Provides residual inspection, including 20x exaggerated on-image residual
  vectors so subpixel offsets are visible.
- Includes pure image and pure Stellarium views for visual checking.
- Includes an optional generated ambient audio mode with subtle interaction
  feedback.

## Views And Controls

- `C`: toggle star pairing view and Stellarium-style catalog view.
- `X`: alternate pure image view and pure Stellarium view. Labels and pairings
  are hidden, but the az/el grid remains visible if enabled.
- `N`: show or hide star names in the current view.
- `K`: show only the picked KDE subpixel star positions.
- `T`: show or hide the lucky asterism line overlay.
- `R`: show or hide residual view.
- `A`: show or hide the az/el grid.
- `D` + click: delete the nearest matched star pair.
- `H`: show or hide automatic star-detection markers.
- `M` + click or drag: paint fast 128x128 black not-star mask tiles. Masked
  tiles are ignored by later star finding.
- `Z`: show the zoom/magnifier view.
- Use the viewer's `-`, `Fit`, and `+` controls for persistent image zoom up to
  16x. Left-drag pans while zoomed; `Cmd/Ctrl` + mouse wheel zooms around the
  pointer. View zoom affects only display and never changes calibration pixels
  or report framing. Above 10x, black dots automatically mark the exact picked
  subpixel star positions while the green pairing circles remain visible.
- `Cmd/Ctrl Z`: undo the most recent accepted fit.
- `Esc`: cancel the current interaction or close the density popup.
- `L` or `I'm feeling lucky...`: run automatic star finding, asterism
  identification, and staged lens fitting for the currently selected optical
  model.

Manual KDE-based star picking remains the most controlled way to add or correct
pairings after an automatic run.

## Basic Workflow

1. Open `index.html` in a browser.
2. Load an image, or use the bundled default image.
3. Check UTC time, latitude, longitude, and altitude.
4. Select the optical model to fit: an AIDA radial model (`optmod 1`, `2`,
   `3`, `4`, `5`, `6`, or `12`) or Brown-Conrady.
5. Roughly align the star field: left-drag to move the zenith point,
   Shift-left-drag or right-drag to rotate the field, and use the mouse wheel
   to scale `f1` and `f2` together.
6. Click `I'm feeling lucky...` or press `L` to run the automatic detector,
   asterism matcher, and staged lens fit. Re-running it respects any masked
   image tiles.
7. To add or correct pairs manually, hold `S` and click an image star. The
   local star position is refined with the interpolated density estimate.
   Release `S`, then click the matching red catalog star.
8. Repeat until several well-spread star pairs are available.
9. Press `F` for robust randomized Nelder-Mead, or `G` for
   Levenberg-Marquardt.
10. Press `R` to inspect residuals and remove bad pairs if needed.
11. Export the fitted model with the copy buttons.

## Field Of View Adjustment

The first alignment step is meant to be visual and approximate. Drag with the
left mouse button until the catalog zenith is near the image zenith. Shift-drag
with the left mouse button, or drag with the right mouse button, to rotate the
star field so bright catalog stars line up with the image orientation. Use the
mouse wheel if the projected catalog field is too wide or too narrow. After the
field is close, use `S` to create accurate star pairs and let the lens optimizer
refine the selected model parameters.

## Star Picking Details

When `S` is held, a magnified view follows the mouse. Click near the image
star; the magnifier disappears and a density-estimate popup is placed away from
the click area. The selected star position is found from a 40x interpolated
local image patch smoothed with a Gaussian kernel. On low-resolution images,
the picker first searches for the nearby intensity peak so a one-pixel click
error cannot bias the small KDE patch. The popup shows the unfiltered
interpolated bitmap underneath contour lines of the smoothed density estimate.

Image-star coordinates use zero-based pixel centers: `(0, 0)` is the center of
the upper-left pixel. Pixel-corner coordinates are used only by the separate
pcolormesh-compatible az/el HDF5 grid.

Press `K` to inspect only the picked subpixel image-star positions. In this
KDE-dot mode all other overlays are hidden, which is useful for checking
whether centroiding is landing on the intended stars.

## Residuals And Undo

Residual mode draws the fitted catalog location and the selected image location
for each pair. The suggested removal marker is based on the star whose residual
is furthest from the main residual pattern, rather than simply the largest
absolute residual.

Accepted fits and automatic pairing batches are stored in an undo stack. Use
the Undo button or `Cmd/Ctrl Z` to restore the state from before the latest
accepted fit or automatic pairing run. Loading a new image or removing all star
pairings clears the undo history.

## Automatic Command-Line Lens Calibration

Installation is only required for command-line use. The browser GUI works
without installing anything. To install the `wisc` command-line wrapper, clone
the repository and run:

```bash
git clone https://github.com/jvierine/widefield-star-calibrator.git
cd widefield-star-calibrator
scripts/install.sh
```

The installer links `wisc` into `~/.local/bin` by default.
Set `PREFIX=/usr/local` or `BINDIR=/some/bin` before running the script to
choose another install location. The command-line calibrator needs
[Node.js](https://nodejs.org/), and the installer fetches the Node
image-decoding dependencies used for PNG, JPEG, HEIC, HEIF, and FITS input.

Run the browser-style "I'm feeling lucky" calibration from the command line by
giving `wisc` an image filename. Latitude, longitude, altitude, and UTC time may
be provided as flags; if they are omitted, saved test-case metadata and image
EXIF-derived metadata are used by default when available, followed by filename
or fallback values.

```bash
wisc calibration_images/IMG_9953.HEIC --lat 69.644233 --lon 18.925919 --alt 95 --time 2024-12-31T22:37:51Z --optpar-out calibration.json --code python
```

The script runs the same automatic star finding and asterism matching strategy
as the GUI, fits the selected lens model, and writes:

- `lucky-report/index.html`: visual overlay report with raw detections,
  asterisms, matched stars, residuals, timing, and fitted `optpar`.
- `lucky-report/summary.json`: machine-readable calibration summary with
  `optmod`, `[optmod, ...optpar]`, RMS, match count, site/time metadata, and
  timing totals.
- `calibration.json`: compact machine-readable optpar output when
  `--optpar-out` is used. This is the file a meteor-camera pipeline should
  consume automatically.
- `lucky-report/code/*_mapper.py`: mapper source code when `--code` is used.
  Supported code languages are `python`, `julia`, `c`, and `matlab`. Python
  mapper output is self-contained and includes the lens-model code, optpar, and
  image dimensions in one file.

Saved `test_cases/*/metadata.json` files are used when available. Otherwise
the script infers allsky7 timestamps and station metadata from filenames, and
falls back to a Tromso default. HEIC and JPEG inputs are normalized to PNG
report assets by the Node command-line tool, without relying on macOS `sips`.

For scripted meteor-camera operation, run the command after each image or
stacked frame is available, then read `calibration.json`. A failed solve keeps
`solved: false` and `optpar: null`, so automation can reject it without parsing
the visual HTML report.

## Export Notes

The copied `optpar` array always starts with the optical model number. For AIDA
radial models it contains
`[optmod, f1, f2, alpha, beta, gamma, du, dv, radial_alpha]`. For
Brown-Conrady (`optmod 20`), it contains
`[20, f1, f2, alpha, beta, gamma, du, dv, k1, k2, k3, p1, p2]`.

Lens parameters always map directly to raw, zero-based image pixel centers and
never depend on GUI flip state. `Flip model X` negates only `f1`; `Flip model Y`
negates only `f2`. Image-flip controls affect display only. Legacy saved cases
with external overlay flips are converted once on load to equivalent raw-pixel
parameters; new test cases and HDF5 products record
`modelCoordinates = raw_image_pixel_centers`.

The export language selector controls the syntax used by `Copy optpar`:
Python, Julia, C, or MATLAB. The results ZIP still includes the complete
self-contained Python mapper for the fitted model.

The `Download az/el HDF5` button writes a browser-generated HDF5 file with
`/azimuth_deg` and `/elevation_deg` Float32 datasets shaped
`[image_height + 1, image_width + 1]` and indexed as
`[corner_y, corner_x]`. Values describe pixel corners from `(-0.5, -0.5)` to
`(image_width - 0.5, image_height - 0.5)`, making the arrays directly
compatible with `pcolormesh` image data. The root attributes store the image
name, image and coordinate-grid sizes, UTC timestamp, site
latitude/longitude/altitude, selected optical model, `optpar`,
`[optmod, ...optpar]`, corner origin/step, and overlay/image flip flags used for
the export.

The `Download results` button packages `report.tex`, star-overlay and residual
figures, a single root-level `base_image.png`, and Yale Bright Star Catalogue
rows embedded directly in root-level Python examples. The ZIP is named
`<image-prefix>_results.zip`. It also includes
`<image-prefix>_calibration.h5`, the authoritative compact calibration product.
It stores the best native AIDA/WISC `optmod/optpar`, equidistant and equisolid
MIRACLE compatibility fits, center offsets, per-model pixel/angular error
statistics and residuals, and the complete selected-star table with an
`included_in_fit` flag (the same data is also provided in
`selected_stars.tsv`). Dataset names and root attributes
document every column and unit. The ZIP includes working
`read_calibration_hdf5.py` and `read_calibration_hdf5.m` examples for all three
models, plus `wisc_mapper.py` for the recommended native fit. It also includes
`evaluate_miracle_error.py`; it reads this
HDF5 file and evaluates the absolute angular difference between the native WISC
fit and MIRACLE approximation at a specified 1-based image row/column or over a
sampled image-aligned grid.

The `Download fit HDF5` button downloads the same authoritative
`<image-prefix>_calibration.h5` product directly, without building the report
ZIP.

The results ZIP also contains `<image-prefix>.miracle`, a plain ASCII file.
Its first commented header and numeric row contain the backward-compatible
equidistant `Glat Glon Xc Yc k_equdist rotAngle` parameters. A second commented
header and numeric row contain the equisolid
`Glat Glon Xc Yc k_equisolid a p rotAngle RMS` values for the simple
`d = k_equisolid sin(0.5 z_rad)` model, with `a = 0.5` and `p = 0` fixed.
No generalized `k sin(a z) + p` model is fitted. `Glat` and `Glon` are station
geographic coordinates in degrees. MIRACLE's historical image axes are
intentionally twisted: `Xc` is the 1-based vertical coordinate
(`zenithRow`) and `Yc` is the 1-based horizontal coordinate (`zenithCol`),
with `(1, 1)` at the upper-left. `k_equdist` is in pixels per degree for
`d = k_equdist z_degree`; `k_equisolid` is in pixels for
`d = k_equisolid sin(z_rad/2)`; `rotAngle` is in radians; and `RMS` is the
two-dimensional selected-star residual RMS in pixels. A positive angle means rotating the image
clockwise aligns north upward, equivalently the uncorrected image is rotated
counter-clockwise. Additional `%` comment lines summarize both fits and their
residual errors. The legacy equidistant row remains the first numeric row.

WISC fits the MIRACLE camera parameters directly from selected-star
row/column positions using the unmirrored east-left projection in the MIRACLE
`starcalibration` function. `selected_stars.tsv` provides every selected star
with `altitude_deg`, `azimuth_deg`, `star_row_px_1based`, and
`star_col_px_1based` columns that map directly to MATLAB `starAlt`, `starAz`,
`starRow`, and `starCol`, plus J2000 RA/Dec, magnitude, modeled position, and
residual. The report includes a three-column equidistant/equisolid/native-AIDA
comparison table using the stars included by the current GUI magnitude limit,
so the native pixel RMS matches the GUI, including center offsets,
pixel and angular RMS/standard deviations, and the approximate transverse
error at 150 km. It also includes
`figures/miracle_absolute_angular_error.png`, a pcolormesh-style bitmap of the
absolute sky-angle difference in degrees between the native WISC model and the
six-parameter MIRACLE approximation. The image-aligned heatmap preserves the
source aspect ratio and is capped at 512 pixels on its longest side.

`overlay_lens_model.py` has the optpar, site/time, image size, and star rows in
the code. `create_az_el_table.py` optionally creates `calibration_az_el.h5`
locally; `overlay_hdf5.py` reads that file after it has been created. The HDF5
az/el corner grid is not bundled in the ZIP because it can be much larger than
the compact calibration HDF5. The examples use Astropy for RA/Dec to
azimuth/elevation, draw hollow yellow circles on `base_image.png`, and write a
PNG in the same folder. The examples do not read JSON metadata, residual, or
catalog files. Compile `report.tex` after unzipping with `pdflatex` or
`latexmk`.

## Python Lens Module

The repository also includes a reusable Python module, `wisc_lens.py`, which
implements all browser lens models. This is useful when you want to write a
normal Python program instead of pasting the complete mapper code from the GUI.
It can be installed as a tiny module:

```bash
python setup.py install
```

or copied directly into the same directory as a Python script. It only depends
on NumPy. The module uses the same `optpar` convention as the GUI export: the
first value is the optical model number.

```python
from wisc_lens import WiscCamera, az_el_to_pixel, pixel_to_az_el

optpar = [20, -0.93, -0.70, -12.1, -58.9, -15.2,
          0.006, 0.004, 0.24, -0.30, -0.03, -0.013, 0.004]
width = 3024
height = 4032

camera = WiscCamera(optpar, width, height)
x, y = camera.az_el_to_pixel(az_deg=210.0, el_deg=45.0)
az, el = camera.pixel_to_az_el(x, y)

# Functional API:
x, y = az_el_to_pixel(210.0, 45.0, optpar, width, height)
az, el = pixel_to_az_el(x, y, optpar, width, height)
```

`pixel_to_az_el` is a numerical inverse intended for calibrated pixels inside
the useful field of view. Pass `return_error=True` to also get the residual
reprojection error in pixels.

## Why JavaScript?

JavaScript is not a beautiful language for mathematical software. In fact, I
truly hate this language with a passion; there are only a few worse programming
languages in the world to program in: Brainfuck, and normal Java. But JavaScript
is extremely well optimized because it runs software for a huge fraction of the
world's internet users. It is also very well suited for graphical user
interfaces that can be shared over the internet without asking users to install a
desktop application. WebGL is fast enough for the interactive image display and
overlay work this tool needs.

The GUI is optional, because the same calibrator can be installed as
`wisc` and run like any other command-line program. Still,
the GUI is a major advantage when a difficult star field does not automatically
plate solve and needs a few manual corrections.

## Coordinates And Camera Models

For a catalog star at azimuth $\mathrm{az}$ and zenith angle $\mathrm{ze}$,
WISC first writes the local sky direction as an east/north/up unit vector:

$$
\mathbf{e} =
\left[
\sin(\mathrm{ze})\sin(\mathrm{az}),
\sin(\mathrm{ze})\cos(\mathrm{az}),
\cos(\mathrm{ze})
\right]^T .
$$

The camera pointing parameters rotate this direction into the camera frame:

$$
\mathbf{s}
= R(\alpha_\mathrm{cam}, \beta_\mathrm{cam}, \gamma_\mathrm{cam})\mathbf{e}
= \left[s_1, s_2, s_3\right]^T .
$$

The final image coordinates are normalized coordinates multiplied by image
size:

$$
x = W u - 1, \qquad y = H v - 1,
$$

where $W$ and $H$ are the image width and height in pixels.

For the radial AIDA-style models, define

$$
\rho = \sqrt{s_1^2 + s_2^2}, \qquad
\theta = \mathrm{atan2}(\rho, s_3),
$$

$$
u = \frac{1}{2} + d_x + f_1\frac{s_1}{\rho}q(\theta), \qquad
v = \frac{1}{2} + d_y + f_2\frac{s_2}{\rho}q(\theta).
$$

At the optical axis, where $\rho = 0$, WISC uses
$u = \frac{1}{2} + d_x$ and $v = \frac{1}{2} + d_y$.

The AIDA radial models are based on tried-and-true, robust lens models from
the original AIDA_tools MATLAB code, where they have been used on a range of
wide-field and all-sky lenses. The GUI exposes these options, with the radial
function $q(\theta)$ defined as:

- `optmod 1`: rectilinear/pinhole projection:
  $u = \frac{1}{2} + d_x + f_1s_1/s_3$ and
  $v = \frac{1}{2} + d_y + f_2s_2/s_3$.
- `optmod 2`: sinusoidal radial projection:
  $q(\theta) = \sin(a\theta)$. This is often useful for fisheye and all-sky
  lenses.
- `optmod 3`: hybrid rectilinear/equidistant projection:
  $p_x = (1-a)s_1/s_3 + a\theta s_1/\rho$ and
  $p_y = (1-a)s_2/s_3 + a\theta s_2/\rho$.
- `optmod 4`: power-law equidistant-style projection:
  $q(\theta) = \lvert \theta \rvert^a$.
- `optmod 5`: scaled rectilinear projection:
  $q(\theta) = \tan(a\theta)$.
- `optmod 6`: simple equisolid projection:
  $q(\theta) = \sin(\theta/2)$.
- `optmod 12`: unified radial projection:
  $q(\theta)=\tan(a\theta)/a$ for $a>0$, $q(\theta)=\theta$ for $a=0$, and
  $q(\theta)=\sin(a\theta)/a$ for $a<0$.
- `optmod 20`: Brown-Conrady radial/tangential distortion model. This is
  usually a good starting point for ordinary phone-camera lenses, including
  iPhone images.

For Brown-Conrady, the undistorted pinhole coordinates are

$$
x_n = \frac{s_1}{s_3}, \qquad
y_n = \frac{s_2}{s_3}, \qquad
r^2 = x_n^2 + y_n^2.
$$

The distorted normalized coordinates are

$$
D(r) = 1 + k_1r^2 + k_2r^4 + k_3r^6,
$$

$$
x_d = x_nD(r) + 2p_1x_ny_n + p_2(r^2 + 2x_n^2),
$$

$$
y_d = y_nD(r) + p_1(r^2 + 2y_n^2) + 2p_2x_ny_n,
$$

$$
u = \frac{1}{2} + d_x + f_1x_d, \qquad
v = \frac{1}{2} + d_y + f_2y_d.
$$

## Tests

Run the JavaScript unit tests with:

```bash
npm test
```

GitHub Actions runs these fast tests on every pushed commit and pull request.
Long-running reports and sensitivity studies are intentionally local-only; they
write into ignored directories such as `test-report/`, `lucky-report/`, and
`test_cases/report/`.

To independently check the two low-resolution `BACC_*` cases, first load each
case in WISC and click `Download az/el HDF5`. Then run:

```bash
conda run -n base python tools/verify_bacc_astropy_hdf5.py
```

The script downloads the saved images and J2000 catalog coordinates, calculates
unrefracted apparent azimuth/elevation with Astropy, and numerically inverts the
downloaded `[height + 1, width + 1]` pixel-edge grids. It does not import the
WISC/AIDA lens mapper. The command fails if either fit exceeds its expected RMS,
if the grid inversion is inaccurate, or if the mean x/y residual indicates a
pixel-indexing offset. It writes full-frame high-pass overlays, pixel-resolved
montages of every selected-star cutout, and a detailed HDF5 result to
`test-report/bacc-astropy-hdf5/`. The high-pass and contrast stretch are only
used for display; calculations use the original coordinates and az/el grid. Use repeated
`--grid CASE_ID=/path/to/file.h5` options if the downloads are elsewhere.

A shorter direct check of the Python WISC library is available as:

```bash
conda run -n base python tools/check_bacc_pixel2azel.py
```

It reads the two tracked BACC images and test-case JSON files, explicitly
separates the saved `optmod = optpar[0]` from the remaining parameters, runs
`wisc_lens.pixel2azel` on the selected zero-based pixel centers, compares
the result with Astropy, and plots the selected and predicted pixel centers.
There is no fitting or HDF5 inversion in this test. Integer coordinates are
displayed at image pixel centers using an image extent from `-0.5` to
`size - 0.5`.

The camera-model cross-check starts Python and imports `aida_tools_py`. Set
`PYTHON=/path/to/python` if the default `/opt/miniconda3/bin/python` is not the
right environment.

## References

- Warren Jr., W. H., and Hoffleit, D. (1987). The Bright Star Catalogue.
  *Bulletin of the American Astronomical Society*, 19, 733.
- Nowakowski, A., and Skarbek, W. (2013). Analysis of Brown camera distortion
  model. In *Photonics Applications in Astronomy, Communications, Industry,
  and High-Energy Physics Experiments 2013*, SPIE Vol. 8903, 248-257.
- Lang, D., Hogg, D. W., Mierle, K., Blanton, M., and Roweis, S. (2010).
  Astrometry.net: Blind astrometric calibration of arbitrary astronomical
  images. *The Astronomical Journal*, 139(5), 1782-1800.
- Bertin, E., and Arnouts, S. (1996). SExtractor: Software for source
  extraction. *Astronomy and Astrophysics Supplement Series*, 117, 393-404.
  doi:10.1051/aas:1996164.
- Barbary, K. (2016). [SEP: Source Extractor as a
  library](https://doi.org/10.21105/joss.00058). *Journal of Open Source
  Software*, 1(6), 58. Project documentation:
  https://sep.readthedocs.io/.
