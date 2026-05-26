# AIDA Browser Star Calibration

[![Fast Unit Tests](https://github.com/jvierine/widefield-star-calibrator/actions/workflows/fast-tests.yml/badge.svg)](https://github.com/jvierine/widefield-star-calibrator/actions/workflows/fast-tests.yml)

This repository contains a JavaScript wide-field star calibration tool. The
strength of the code, and the reason for the JavaScript implementation, is the
interactive browser GUI for aligning catalog stars with sky images, fitting lens
models, inspecting residuals, and exporting calibrated optical parameters.
However, it can also be installed and run on the command line like a normal
Linux/Unix command-line program; see the installation instructions below.

The tool was inspired by the legendary aurora image data analysis (AIDA) tools,
a useful set of MATLAB scripts developed by Björn Gustavsson. This repository
only implements the lens-model calibration parts needed by the browser and
command-line calibrator.

Original AIDA_tools MATLAB toolbox:
https://github.com/jvierine/AIDA_tools

Authors: Juha Vierinen, Björn Gustavsson, and Codex.

License: Creative Commons Attribution 4.0 International (CC BY 4.0). See
[`LICENSE.md`](LICENSE.md).

Try the hosted version here:

http://4.235.86.214/aida/

![Wide-field star calibrator GUI](docs/gui-screenshot.png)

Open `index.html` directly in a browser. No local web server is needed.

## Installation

Clone the repository and install the command-line wrapper:

```bash
git clone https://github.com/jvierine/widefield-star-calibrator.git
cd widefield-star-calibrator
scripts/install.sh
```

The installer links `widefield-star-calibrate` into `~/.local/bin` by default.
Set `PREFIX=/usr/local` or `BINDIR=/some/bin` before running the script to
choose another install location. The command-line calibrator needs Node.js; HEIC
and JPEG input conversion uses macOS `sips`.

## What It Does

- Loads PNG, JPEG, HEIC, and HEIF images.
- Loads a bundled allsky7 example image automatically on startup.
- Reads UTC time and observer position from EXIF metadata when available.
- Falls back to known allsky7 filename/station metadata when possible.
- Uses the embedded bright-star catalog and AIDA camera projection code.
- Provides the `I'm feeling lucky` workflow: it detects stars, uses triangle
  asterisms to identify likely catalog matches, fits the selected lens model,
  expands to fainter stars, and prunes obvious bad automatic matches.
- Supports the self-contained parametric AIDA/MATLAB lens models (`optmod 1`,
  `2`, `3`, `4`, `5`, and `12`) plus a Brown-Conrady radial/tangential
  distortion model under browser `optmod 20`; the selected optical model is
  the one used by the fit.
- Lets the user manually pick image stars with a 40x interpolated density
  estimate and pair them with catalog stars.
- Fits the model-specific `optpar` vector: eight parameters for AIDA radial
  models, and twelve for Brown-Conrady with `k1`, `k2`, `k3`, `p1`, and `p2`.
- Exports the fitted `optpar` and mapper code as Python, Julia, C, or MATLAB.
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
- `Cmd/Ctrl Z`: undo the most recent accepted fit.
- `Esc`: cancel the current interaction or close the density popup.
- `I'm feeling lucky...`: run automatic star finding, asterism identification,
  and staged lens fitting for the currently selected optical model.

Manual KDE-based star picking remains the most controlled way to add or correct
pairings after an automatic run.

## Basic Workflow

1. Open `index.html` in a browser.
2. Load an image, or use the bundled default image.
3. Check UTC time, latitude, longitude, and altitude.
4. Select the optical model to fit: an AIDA radial model (`optmod 1`, `2`,
   `3`, `4`, `5`, or `12`) or Brown-Conrady.
5. Roughly align the star field:
   - left-drag to move the zenith point,
   - right-drag to rotate the field,
   - mouse wheel to scale `f1` and `f2` together.
6. Click `I'm feeling lucky...` or press `L` to run the automatic detector,
   asterism matcher, and staged lens fit. Re-running it respects any masked
   image tiles.
7. To add or correct pairs manually, hold `S` and click an image star. The
   local star position is refined with
   the interpolated density estimate.
8. Release `S`, then click the matching red catalog star.
9. Repeat until several well-spread star pairs are available.
10. Press `F` for robust randomized Nelder-Mead, or `G` for
   Levenberg-Marquardt.
11. Press `R` to inspect residuals and remove bad pairs if needed.
12. Export the fitted model with the copy buttons.

## Automatic Command-Line Lens Calibration

Run the browser-style "I'm feeling lucky" calibration from the command line by
giving an image filename. Latitude, longitude, altitude, and UTC time may be
provided as flags; if they are omitted, saved test-case metadata and image
EXIF-derived metadata are used by default when available, followed by filename
or fallback values.

```bash
widefield-star-calibrate calibration_images/IMG_9953.HEIC --lat 69.644233 --lon 18.925919 --alt 95 --time 2024-12-31T22:37:51Z --optpar-out calibration.json --code python
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
  Supported code languages are `python`, `julia`, `c`, and `matlab`.

Saved `test_cases/*/metadata.json` files are used when available. Otherwise
the script infers allsky7 timestamps and station metadata from filenames, and
falls back to a Tromso default. HEIC and JPEG inputs are normalized to PNG
report assets with macOS `sips`.

For scripted meteor-camera operation, run the command after each image or
stacked frame is available, then read `calibration.json`. A failed solve keeps
`solved: false` and `optpar: null`, so automation can reject it without parsing
the visual HTML report.

## Coordinates And Camera Models

The AIDA radial models are based on tried-and-true, robust lens models from
the original AIDA_tools MATLAB code, where they have been used on a range of
wide-field and all-sky lenses. The GUI exposes these options:

- `optmod 1`: rectilinear/pinhole projection.
- `optmod 2`: sinusoidal radial projection, a good common choice for fisheye
  and all-sky lenses.
- `optmod 3`: hybrid tangent/equidistant radial projection.
- `optmod 4`: power-law equidistant-style radial projection.
- `optmod 5`: scaled rectilinear projection.
- `optmod 12`: unified radial projection that can smoothly move between
  sine-like, equidistant, and tangent-like behavior.
- `Brown-Conrady` (`optmod 20`): the standard radial/tangential distortion
  model, usually a good starting point for ordinary phone-camera lenses,
  including iPhone images. See Nowakowski and Skarbek (2013), "Analysis of
  Brown camera distortion model", in Photonics Applications in Astronomy,
  Communications, Industry, and High-Energy Physics Experiments 2013, SPIE
  volume 8903, pages 248-257.

## Test Data

The generated PNG copies live in `calibration_images/`. The source HDF5/MATLAB
references remain under the local `allsky7 -> ../python/examples/allsky7`
symlink when present.

The file `2025_02_19_03_44_00_000_010760_first1s.png` is included in the
graphical star-fit report with a manually supplied known-good optmod 2
solution, because the optpar stored in its HDF5 file is not the accepted
reference solution for this frame.

Regenerate the bundled calibration cases with:

```bash
python tools/generate_calibration_cases.py
```

## Tests

Run the JavaScript unit tests with:

```bash
npm test
```

GitHub Actions runs these fast tests on every pushed commit and pull request.
Long-running reports and sensitivity studies are intentionally local-only; they
write into ignored directories such as `test-report/`, `lucky-report/`, and
`test_cases/report/`.

The camera-model cross-check starts Python and imports `aida_tools_py`. Set
`PYTHON=/path/to/python` if the default `/opt/miniconda3/bin/python` is not the
right environment.

