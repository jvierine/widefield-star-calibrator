"""Independent scientific check of Rust CLI FITS maps (no Rust inverse import)."""

import argparse
import json
from pathlib import Path
import sys
import warnings

import numpy as np
from astropy.io import fits
from scipy.optimize import least_squares

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wisc_lens import az_el_to_pixel  # noqa: E402


def verify(calibration_path, map_path):
    document = json.loads(Path(calibration_path).read_text())
    calibration = document["calibration"]
    parameters = [calibration["model"], *calibration["optpar"]]
    width, height = calibration["width"], calibration["height"]
    with warnings.catch_warnings():
        warnings.simplefilter("error", fits.verify.VerifyWarning)
        with fits.open(map_path) as hdus:
            hdus.verify("exception")
            header = hdus[0].header
            data = hdus[0].data.copy()
    step = int(header["CDELT1"])
    assert step > 0 and header["CDELT2"] == step
    assert header["BUNIT"] == "deg"
    assert header["PLANE1"] == "AZIMUTH" and header["PLANE2"] == "ELEVATION"
    assert header["CRPIX1"] == 1 and header["CRVAL1"] == 0
    assert data.shape == (2, (height + step - 1) // step, (width + step - 1) // step)
    assert [header[f"OPTPAR{i + 1}"] for i in range(len(calibration["optpar"]))] == calibration["optpar"]
    angular_errors = []
    pixel_errors = []
    for fraction_x, fraction_y in [(0.5, 0.5), (0.3, 0.3), (0.72, 0.62), (0.2, 0.6), (0.62, 0.26)]:
        x, y = int(data.shape[2] * fraction_x), int(data.shape[1] * fraction_y)
        target = np.array([step * x, step * y], dtype=float)

        def residual(sky):
            return np.array(az_el_to_pixel(*sky, parameters, width, height)) - target

        solutions = [
            least_squares(
                residual, [azimuth, elevation], bounds=([-360, -89.9], [720, 89.9999]),
                xtol=1e-13, ftol=1e-13, gtol=1e-13,
            )
            for azimuth in [0, 90, 180, 270] for elevation in [30, 70, 85]
        ]
        best = min(solutions, key=lambda result: np.linalg.norm(result.fun))
        assert np.linalg.norm(best.fun) < 1e-5, "independent inverse did not converge"
        azimuth, elevation = best.x
        map_azimuth, map_elevation = map(float, data[:, y, x])
        delta_azimuth = (map_azimuth - azimuth + 180) % 360 - 180
        delta_elevation = map_elevation - elevation
        angular_errors.append(np.hypot(delta_azimuth * np.cos(np.deg2rad(elevation)), delta_elevation))
        pixel_errors.append(np.linalg.norm(residual([map_azimuth, map_elevation])))
    assert max(angular_errors) < 1e-4, angular_errors
    assert max(pixel_errors) < 1e-3, pixel_errors
    print(f"Astropy FITS validation passed; max SciPy inverse disagreement {max(angular_errors):.8f} deg")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("calibration")
    parser.add_argument("map")
    arguments = parser.parse_args()
    verify(arguments.calibration, arguments.map)
