# AIDA Browser Star Calibration

This directory contains a browser-only AIDA star calibration tool. It is used to
align catalog stars with all-sky images, manually pair stars, fit the AIDA lens
model, inspect residuals, and export the calibrated optical parameters.

Open `index.html` directly in a browser. No local web server is needed.

## What It Does

- Loads PNG, JPEG, HEIC, and HEIF images.
- Loads a bundled allsky7 example image automatically on startup.
- Reads UTC time and observer position from EXIF metadata when available.
- Falls back to known allsky7 filename/station metadata when possible.
- Uses the embedded bright-star catalog and AIDA camera projection code.
- Provides an opt-in automatic star identifier that runs a bounded bright-star
  finder, keeps at most the top 50 image detections, compares them with Yale
  catalog stars brighter than magnitude 4, and adds plausible pairings.
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
6. Optionally click `Auto identify stars`. This is a user-requested action, not
   a startup default. The first pass uses bright-star triangle asterisms and a
   KD-tree lookup so it can still help when the current lens state is only a
   rough guess; the current projected lens state is used as a fallback.
7. Hold `S` and click an image star. The local star position is refined with
   the interpolated density estimate.
8. Release `S`, then click the matching red catalog star.
9. Repeat until several well-spread star pairs are available.
10. Press `F` for robust randomized Nelder-Mead, or `G` for
   Levenberg-Marquardt.
11. Press `R` to inspect residuals and remove bad pairs if needed.
12. Export the fitted model with the copy buttons.

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
- `M` + click: mask a local image region.
- `Z`: show the zoom/magnifier view.
- `Cmd/Ctrl Z`: undo the most recent accepted fit.
- `Esc`: cancel the current interaction or close the density popup.
- `Auto identify stars`: run the opt-in top-50 bright-star detector and
  Yale-catalog matcher. The automatic matcher is capped at magnitude 4 even if
  the display limiting magnitude is fainter.

The automatic identifier is deliberately not run by default. Manual KDE-based
star picking remains the most controlled way to add or correct pairings.

## Image Display

The image is high-pass filtered by default with a 100 px Gaussian background
estimate. Brightness and contrast are applied after high-pass filtering. The
default brightness is slightly raised so background noise and weak stars remain
visible.

## Coordinates And Camera Models

The browser uses true 0-based image pixel coordinates. The AIDA/MATLAB optical
model values are converted from MATLAB's 1-based pixel convention inside
`js/aidatools.js`.

The browser camera model is tested against the Python and MATLAB reference
implementations for the parametric AIDA optmods `1`, `2`, `3`, `4`, `5`, and
`12`, and has a separate browser unit test for the Brown-Conrady
radial/tangential projection. The MATLAB lookup-table and instrument-specific
camera models are intentionally not in the browser UI because they require
external calibration tables or special camera code.

The AIDA model names are descriptive names for the implemented radial forms,
not literature names. Brown-Conrady is usually a good starting point for
ordinary phone-camera lenses, including iPhone images, while the AIDA radial
models are often better for fisheye and all-sky optics. Brown-Conrady is the
standard Brown-Conrady radial/tangential distortion model; see Nowakowski and
Skarbek (2013),
"Analysis of Brown camera distortion model", in Photonics Applications in
Astronomy, Communications, Industry, and High-Energy Physics Experiments 2013,
SPIE volume 8903, pages 248-257.

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

The camera-model cross-check starts Python and imports `aida_tools_py`. Set
`PYTHON=/path/to/python` if the default `/opt/miniconda3/bin/python` is not the
right environment.

## Command-Line Lucky Calibration Report

Run the browser-style "I'm feeling lucky" calibration over the images in
`calibration_images/` with:

```bash
npm run lucky:report
```

The script prints per-image progress, writes star-overlay panels with raw
detections, debug asterism lines, and fitted stars to `lucky-report/index.html`,
and includes timing totals for image decode, star detection, blind asterism
matching, projected matching, and lens fitting.

Useful variants:

```bash
npm run lucky:report -- --filter IMG_0537
npm run lucky:report -- --limit 5
npm run lucky:report -- --lat 69.65 --lon 18.95 --time 2025-01-29T18:45:02Z
```

Saved `test_cases/*/metadata.json` files are used when available. Otherwise
the script infers allsky7 timestamps and station metadata from filenames, and
falls back to the command-line site/time options or a Tromso default. HEIC and
JPEG inputs are normalized to PNG report assets with macOS `sips`.
