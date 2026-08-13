#!/usr/bin/env python3
"""Verify the two live BACC calibrations using Astropy and az/el corner grids.

This program deliberately does not import or reproduce the WISC/AIDA camera
model.  For each saved BACC test case it:

1. downloads the original image and selected-star RA/Dec coordinates,
2. reads the browser-exported ``*_az_el.h5`` pixel-corner grid,
3. uses Astropy (unrefracted AltAz) to calculate each star's azimuth/elevation,
4. numerically inverts the curvilinear corner grid to obtain image coordinates,
5. compares those coordinates with the independently picked image stars.

The corner grid has shape ``(image_height + 1, image_width + 1)``.  Fractional
corner-grid index ``(gx, gy)`` maps to zero-based pixel-center coordinates
``(x, y) = (gx - 0.5, gy - 0.5)``.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import astropy.units as u
import h5py
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.optimize import least_squares
from scipy.spatial import cKDTree


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CASES = (
    "BACC_LYR_20200101_002407",
    "BACC_NYA_20200218_010731",
)
DEFAULT_OUT = ROOT / "test-report" / "bacc-astropy-hdf5"
DEFAULT_GRID_DIR = Path.home() / "Downloads"
MAX_GRID_INVERSION_ERROR_DEG = 0.005
MAX_ABS_MEAN_OFFSET_PX = 0.15
CASE_RMS_LIMIT_PX = {
    "BACC_LYR_20200101_002407": 0.75,
    "BACC_NYA_20200218_010731": 1.10,
}


@dataclass
class GridInversion:
    x: float
    y: float
    angular_error_deg: float


def scalar_attribute(attrs: h5py.AttributeManager, name: str) -> float:
    value = np.asarray(attrs[name]).reshape(-1)
    if value.size != 1:
        raise ValueError(f"HDF5 attribute {name!r} must contain one value")
    return float(value[0])


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.load(response)


def fetch_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def az_el_to_unit(az_deg: np.ndarray | float, el_deg: np.ndarray | float) -> np.ndarray:
    az = np.deg2rad(az_deg)
    el = np.deg2rad(el_deg)
    cos_el = np.cos(el)
    return np.stack(
        (cos_el * np.sin(az), cos_el * np.cos(az), np.sin(el)),
        axis=-1,
    )


def angular_separation_deg(first: np.ndarray, second: np.ndarray) -> float:
    dot = float(np.clip(np.dot(first, second), -1.0, 1.0))
    return math.degrees(math.acos(dot))


def high_pass_display(image: Image.Image, sigma_px: float = 4.0) -> np.ndarray:
    """Return a display-only high-pass image; measurements never use this array."""
    rgb = np.asarray(image, dtype=np.float64)
    gray = 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]
    return gray - gaussian_filter(gray, sigma=sigma_px, mode="nearest")


def percentile_stretch(values: np.ndarray, low: float, high: float) -> np.ndarray:
    finite = values[np.isfinite(values)]
    if not finite.size:
        return np.zeros_like(values, dtype=np.float64)
    lower, upper = np.percentile(finite, (low, high))
    if not upper > lower:
        return np.zeros_like(values, dtype=np.float64)
    return np.clip((values - lower) / (upper - lower), 0.0, 1.0)


class CornerGridInverse:
    """Invert a pcolormesh-compatible az/el corner grid cell by cell."""

    def __init__(self, azimuth_deg: np.ndarray, elevation_deg: np.ndarray):
        if azimuth_deg.shape != elevation_deg.shape or azimuth_deg.ndim != 2:
            raise ValueError("azimuth/elevation grids must be same-shaped 2-D arrays")
        self.height, self.width = azimuth_deg.shape
        self.vectors = az_el_to_unit(azimuth_deg, elevation_deg)
        finite = np.isfinite(self.vectors).all(axis=2)
        self.valid_indices = np.argwhere(finite)
        if not len(self.valid_indices):
            raise ValueError("az/el grid contains no finite corner coordinates")
        self.tree = cKDTree(self.vectors[finite])

    def _cell_vector(self, cell_y: int, cell_x: int, uv: np.ndarray) -> np.ndarray:
        u_value, v_value = uv
        v00 = self.vectors[cell_y, cell_x]
        v10 = self.vectors[cell_y, cell_x + 1]
        v01 = self.vectors[cell_y + 1, cell_x]
        v11 = self.vectors[cell_y + 1, cell_x + 1]
        vector = (
            (1.0 - u_value) * (1.0 - v_value) * v00
            + u_value * (1.0 - v_value) * v10
            + (1.0 - u_value) * v_value * v01
            + u_value * v_value * v11
        )
        norm = np.linalg.norm(vector)
        return vector / norm if norm > 0 else vector

    def invert(self, azimuth_deg: float, elevation_deg: float) -> GridInversion:
        target = az_el_to_unit(float(azimuth_deg), float(elevation_deg))
        _, nearest = self.tree.query(target, k=1)
        corner_y, corner_x = self.valid_indices[int(nearest)]
        candidates: list[GridInversion] = []
        for cell_y in (corner_y - 1, corner_y):
            for cell_x in (corner_x - 1, corner_x):
                if not (0 <= cell_y < self.height - 1 and 0 <= cell_x < self.width - 1):
                    continue
                corners = self.vectors[cell_y : cell_y + 2, cell_x : cell_x + 2]
                if not np.isfinite(corners).all():
                    continue
                fit = least_squares(
                    lambda uv: self._cell_vector(cell_y, cell_x, uv) - target,
                    x0=np.array([0.5, 0.5]),
                    bounds=(0.0, 1.0),
                    xtol=1e-12,
                    ftol=1e-12,
                    gtol=1e-12,
                    max_nfev=80,
                )
                predicted = self._cell_vector(cell_y, cell_x, fit.x)
                candidates.append(
                    GridInversion(
                        # Corner 0 is x/y=-0.5; hence the final -0.5.
                        x=float(cell_x + fit.x[0] - 0.5),
                        y=float(cell_y + fit.x[1] - 0.5),
                        angular_error_deg=angular_separation_deg(predicted, target),
                    )
                )
        if not candidates:
            raise RuntimeError("could not find a finite az/el grid cell around target")
        return min(candidates, key=lambda item: item.angular_error_deg)


def astropy_altaz(test_case: dict) -> tuple[np.ndarray, np.ndarray]:
    matches = test_case["matches"]
    location = EarthLocation(
        lat=float(test_case["latDeg"]) * u.deg,
        lon=float(test_case["lonDeg"]) * u.deg,
        height=float(test_case.get("altM", 0.0)) * u.m,
    )
    frame = AltAz(
        obstime=Time(test_case["timestampUtc"], scale="utc"),
        location=location,
        pressure=0 * u.hPa,
    )
    stars = SkyCoord(
        ra=np.array([float(row["catalog"]["raHours"]) for row in matches]) * 15.0 * u.deg,
        dec=np.array([float(row["catalog"]["decDeg"]) for row in matches]) * u.deg,
        frame="icrs",
    ).transform_to(frame)
    return np.asarray(stars.az.deg), np.asarray(stars.alt.deg)


def validate_grid_metadata(grid: h5py.File, test_case: dict) -> tuple[int, int]:
    width = int(test_case["width"])
    height = int(test_case["height"])
    if grid["azimuth_deg"].shape != (height + 1, width + 1):
        raise AssertionError(
            f"{test_case['id']}: grid shape {grid['azimuth_deg'].shape} is not "
            f"pcolormesh-compatible {(height + 1, width + 1)}"
        )
    if grid["elevation_deg"].shape != (height + 1, width + 1):
        raise AssertionError(f"{test_case['id']}: elevation grid has the wrong shape")
    checks = {
        "image_width": width,
        "image_height": height,
        "site_lat_deg": float(test_case["latDeg"]),
        "site_lon_deg": float(test_case["lonDeg"]),
        "site_alt_m": float(test_case.get("altM", 0.0)),
        "pixel_corner_x_start": -0.5,
        "pixel_corner_y_start": -0.5,
        "pixel_corner_step": 1.0,
    }
    for name, expected in checks.items():
        actual = scalar_attribute(grid.attrs, name)
        if not math.isclose(actual, expected, rel_tol=0, abs_tol=1e-6):
            raise AssertionError(f"{test_case['id']}: {name}={actual}, expected {expected}")
    grid_timestamp = str(grid.attrs["timestamp_utc"])
    if grid_timestamp != test_case["timestampUtc"]:
        raise AssertionError(
            f"{test_case['id']}: HDF5 time {grid_timestamp!r} != case time {test_case['timestampUtc']!r}"
        )
    return width, height


def create_overlay(
    image: Image.Image,
    test_case: dict,
    predicted_x: np.ndarray,
    predicted_y: np.ndarray,
    residual_px: np.ndarray,
    output_path: Path,
) -> None:
    selected_x = np.array([float(row["image"]["x"]) for row in test_case["matches"]])
    selected_y = np.array([float(row["image"]["y"]) for row in test_case["matches"]])
    display = percentile_stretch(high_pass_display(image), 2.0, 99.7)
    figure, axis = plt.subplots(figsize=(9, 9), constrained_layout=True)
    axis.imshow(display, origin="upper", cmap="gray", vmin=0, vmax=1, interpolation="nearest")
    for x0, y0, x1, y1 in zip(selected_x, selected_y, predicted_x, predicted_y):
        axis.plot((x0, x1), (y0, y1), color="#ffd43b", linewidth=0.8, alpha=0.8)
    axis.scatter(
        selected_x,
        selected_y,
        s=42,
        facecolors="none",
        edgecolors="#38f27d",
        linewidths=1.2,
        label="Selected image star",
    )
    axis.scatter(
        predicted_x,
        predicted_y,
        s=34,
        marker="x",
        color="#36d9ff",
        linewidths=1.2,
        label="Astropy + az/el HDF5 grid",
    )
    for index in np.argsort(residual_px)[-3:]:
        name = str(test_case["matches"][int(index)]["catalog"].get("name", ""))
        axis.annotate(
            f"{name} {residual_px[index]:.2f}px",
            (predicted_x[index], predicted_y[index]),
            xytext=(5, 5),
            textcoords="offset points",
            color="white",
            fontsize=7,
            bbox={"facecolor": "black", "alpha": 0.55, "pad": 1.5},
        )
    axis.set_xlim(-0.5, image.width - 0.5)
    axis.set_ylim(image.height - 0.5, -0.5)
    axis.set_xlabel("Image x / column [pixel center, zero-based]")
    axis.set_ylabel("Image y / row [pixel center, zero-based]")
    axis.set_title(
        f"{test_case['id']}\nAstropy stars through az/el corner grid; display-only high-pass"
    )
    axis.legend(loc="lower right", facecolor="black", labelcolor="white", framealpha=0.7)
    figure.savefig(output_path, dpi=180)
    plt.close(figure)


def create_zoom_montage(
    image: Image.Image,
    test_case: dict,
    predicted_x: np.ndarray,
    predicted_y: np.ndarray,
    residual_px: np.ndarray,
    included: np.ndarray,
    output_path: Path,
) -> None:
    """Show every pairing as an enlarged pixel-resolved local cutout."""
    selected_x = np.array([float(row["image"]["x"]) for row in test_case["matches"]])
    selected_y = np.array([float(row["image"]["y"]) for row in test_case["matches"]])
    names = [str(row["catalog"].get("name", "")) for row in test_case["matches"]]
    high_pass = high_pass_display(image)
    radius = 7
    columns = 8
    rows = math.ceil(len(selected_x) / columns)
    figure, axes = plt.subplots(
        rows,
        columns,
        figsize=(columns * 2.0, rows * 2.0),
        constrained_layout=True,
        squeeze=False,
    )
    for index, axis in enumerate(axes.flat):
        if index >= len(selected_x):
            axis.set_visible(False)
            continue
        center_col = int(round(selected_x[index]))
        center_row = int(round(selected_y[index]))
        x0 = max(0, center_col - radius)
        x1 = min(image.width, center_col + radius + 1)
        y0 = max(0, center_row - radius)
        y1 = min(image.height, center_row + radius + 1)
        patch = percentile_stretch(high_pass[y0:y1, x0:x1], 3.0, 99.0)
        axis.imshow(
            patch,
            origin="upper",
            cmap="gray",
            vmin=0,
            vmax=1,
            interpolation="nearest",
            extent=(x0 - 0.5, x1 - 0.5, y1 - 0.5, y0 - 0.5),
        )
        axis.scatter(
            selected_x[index],
            selected_y[index],
            s=85,
            facecolors="none",
            edgecolors="#38f27d" if included[index] else "#ff9f43",
            linewidths=1.5,
        )
        axis.scatter(
            selected_x[index],
            selected_y[index],
            s=13,
            color="black",
            marker="o",
            zorder=4,
        )
        axis.scatter(
            predicted_x[index],
            predicted_y[index],
            s=55,
            color="#00d9ff",
            marker="x",
            linewidths=1.5,
            zorder=5,
        )
        axis.set_xlim(x0 - 0.5, x1 - 0.5)
        axis.set_ylim(y1 - 0.5, y0 - 0.5)
        axis.set_xticks([])
        axis.set_yticks([])
        status = "fit" if included[index] else "excluded"
        axis.set_title(
            f"{names[index]}  {residual_px[index]:.2f}px ({status})\n"
            f"selected x={selected_x[index]:.2f}, y={selected_y[index]:.2f}",
            fontsize=7,
            color="black" if included[index] else "#b34d00",
        )
    figure.suptitle(
        f"{test_case['id']}: pixel-resolved selected-star cutouts\n"
        "black dot/green ring = selected center; cyan x = Astropy + HDF5 prediction; "
        "display-only high-pass and local stretch",
        fontsize=13,
    )
    figure.savefig(output_path, dpi=180)
    plt.close(figure)


def verify_case(case_id: str, grid_path: Path, base_url: str, out_dir: Path) -> dict:
    payload_url = urllib.parse.urljoin(base_url, f"/api/test-cases/{urllib.parse.quote(case_id)}")
    payload = fetch_json(payload_url)
    test_case = payload["testCase"]
    if test_case.get("id") != case_id:
        raise AssertionError(f"API returned case {test_case.get('id')!r}, expected {case_id!r}")
    image_url = urllib.parse.urljoin(base_url, payload["imageUrl"])
    image = Image.open(io.BytesIO(fetch_bytes(image_url))).convert("RGB")

    with h5py.File(grid_path, "r") as grid:
        width, height = validate_grid_metadata(grid, test_case)
        if image.size != (width, height):
            raise AssertionError(f"{case_id}: image size {image.size} != metadata {(width, height)}")
        inverse = CornerGridInverse(grid["azimuth_deg"][:], grid["elevation_deg"][:])

    astropy_az_deg, astropy_el_deg = astropy_altaz(test_case)
    inverted = [
        inverse.invert(azimuth, elevation)
        for azimuth, elevation in zip(astropy_az_deg, astropy_el_deg)
    ]
    predicted_x = np.array([row.x for row in inverted])
    predicted_y = np.array([row.y for row in inverted])
    inversion_error_deg = np.array([row.angular_error_deg for row in inverted])
    selected_x = np.array([float(row["image"]["x"]) for row in test_case["matches"]])
    selected_y = np.array([float(row["image"]["y"]) for row in test_case["matches"]])
    magnitude = np.array([float(row["catalog"].get("mag", np.nan)) for row in test_case["matches"]])
    dx = predicted_x - selected_x
    dy = predicted_y - selected_y
    residual_px = np.hypot(dx, dy)
    max_mag = float(test_case.get("maxMag", np.inf))
    included = np.isfinite(magnitude) & (magnitude <= max_mag)
    if not included.any():
        included = np.ones_like(residual_px, dtype=bool)

    summary = {
        "case_id": case_id,
        "star_count": int(len(residual_px)),
        "included_star_count": int(included.sum()),
        "max_magnitude": max_mag,
        "rms_px": float(np.sqrt(np.mean(residual_px**2))),
        "included_rms_px": float(np.sqrt(np.mean(residual_px[included] ** 2))),
        "included_mean_dx_px": float(np.mean(dx[included])),
        "included_mean_dy_px": float(np.mean(dy[included])),
        "median_px": float(np.median(residual_px)),
        "max_px": float(np.max(residual_px)),
        "included_median_px": float(np.median(residual_px[included])),
        "included_max_px": float(np.max(residual_px[included])),
        "max_grid_inversion_error_deg": float(np.max(inversion_error_deg)),
        "grid_path": str(grid_path),
    }
    if summary["included_rms_px"] > CASE_RMS_LIMIT_PX[case_id]:
        raise AssertionError(
            f"{case_id}: included-star RMS {summary['included_rms_px']:.3f}px exceeds "
            f"{CASE_RMS_LIMIT_PX[case_id]:.3f}px"
        )
    if summary["max_grid_inversion_error_deg"] > MAX_GRID_INVERSION_ERROR_DEG:
        raise AssertionError(
            f"{case_id}: grid inversion error {summary['max_grid_inversion_error_deg']:.6f}deg exceeds "
            f"{MAX_GRID_INVERSION_ERROR_DEG:.6f}deg"
        )
    for axis_name in ("included_mean_dx_px", "included_mean_dy_px"):
        if abs(summary[axis_name]) > MAX_ABS_MEAN_OFFSET_PX:
            raise AssertionError(
                f"{case_id}: systematic {axis_name}={summary[axis_name]:.3f}px exceeds "
                f"{MAX_ABS_MEAN_OFFSET_PX:.3f}px (possible pixel indexing offset)"
            )

    overlay_path = out_dir / f"{case_id}_astropy_hdf5_overlay.png"
    create_overlay(image, test_case, predicted_x, predicted_y, residual_px, overlay_path)
    summary["overlay_path"] = str(overlay_path)
    zoom_path = out_dir / f"{case_id}_astropy_hdf5_zoomed_stars.png"
    create_zoom_montage(
        image,
        test_case,
        predicted_x,
        predicted_y,
        residual_px,
        included,
        zoom_path,
    )
    summary["zoom_overlay_path"] = str(zoom_path)
    summary["arrays"] = {
        "name": np.array(
            [str(row["catalog"].get("name", "")) for row in test_case["matches"]],
            dtype=object,
        ),
        "ra_hours_j2000": np.array(
            [float(row["catalog"]["raHours"]) for row in test_case["matches"]]
        ),
        "dec_deg_j2000": np.array(
            [float(row["catalog"]["decDeg"]) for row in test_case["matches"]]
        ),
        "magnitude": magnitude,
        "included_by_magnitude": included.astype(np.uint8),
        "astropy_azimuth_deg": astropy_az_deg,
        "astropy_elevation_deg": astropy_el_deg,
        "selected_x_px": selected_x,
        "selected_y_px": selected_y,
        "grid_predicted_x_px": predicted_x,
        "grid_predicted_y_px": predicted_y,
        "residual_dx_px": dx,
        "residual_dy_px": dy,
        "residual_norm_px": residual_px,
        "grid_inversion_error_deg": inversion_error_deg,
    }
    return summary


def write_results_hdf5(path: Path, summaries: list[dict], base_url: str) -> None:
    string_type = h5py.string_dtype(encoding="utf-8")
    with h5py.File(path, "w") as output:
        output.attrs["description"] = (
            "Independent Astropy star overlay verification using WISC az/el pixel-corner grids"
        )
        output.attrs["generated_utc"] = datetime.now(timezone.utc).isoformat()
        output.attrs["base_url"] = base_url
        output.attrs["coordinate_convention"] = (
            "HDF5 grid indexes pixel corners starting at -0.5; predicted and selected x/y are "
            "zero-based pixel centers"
        )
        for summary in summaries:
            group = output.create_group(summary["case_id"])
            for name, value in summary.items():
                if name == "arrays":
                    continue
                group.attrs[name] = value
            for name, values in summary["arrays"].items():
                if name == "name":
                    group.create_dataset(name, data=values, dtype=string_type)
                else:
                    group.create_dataset(name, data=values)


def parse_grid_overrides(values: list[str]) -> dict[str, Path]:
    overrides: dict[str, Path] = {}
    for value in values:
        if "=" not in value:
            raise ValueError(f"--grid must be CASE_ID=/path/to/grid.h5, got {value!r}")
        case_id, path = value.split("=", 1)
        overrides[case_id] = Path(path).expanduser().resolve()
    return overrides


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="https://juha.no", help="WISC server base URL")
    parser.add_argument("--grid-dir", type=Path, default=DEFAULT_GRID_DIR)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument(
        "--grid",
        action="append",
        default=[],
        metavar="CASE_ID=PATH",
        help="override an HDF5 grid path; may be repeated",
    )
    args = parser.parse_args()
    iers.conf.auto_download = False
    iers.conf.auto_max_age = None
    args.out.mkdir(parents=True, exist_ok=True)
    overrides = parse_grid_overrides(args.grid)

    summaries: list[dict] = []
    for case_id in DEFAULT_CASES:
        grid_path = overrides.get(case_id, args.grid_dir.expanduser() / f"{case_id}_az_el.h5")
        if not grid_path.is_file():
            raise FileNotFoundError(
                f"missing {grid_path}; load {case_id} in WISC and click 'Download az/el HDF5'"
            )
        summary = verify_case(case_id, grid_path, args.base_url, args.out)
        summaries.append(summary)
        print(
            f"{case_id}: {summary['included_star_count']}/{summary['star_count']} included stars, "
            f"RMS={summary['included_rms_px']:.3f}px, "
            f"median={summary['included_median_px']:.3f}px, "
            f"mean dx/dy={summary['included_mean_dx_px']:+.3f}/"
            f"{summary['included_mean_dy_px']:+.3f}px, "
            f"max={summary['included_max_px']:.3f}px, "
            f"grid inversion max={summary['max_grid_inversion_error_deg']:.6f}deg"
        )

    result_path = args.out / "bacc_astropy_hdf5_verification.h5"
    write_results_hdf5(result_path, summaries, args.base_url)
    print(f"wrote {result_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # concise command-line failure with nonzero status
        print(f"ERROR: {error}", file=sys.stderr)
        raise SystemExit(1) from error
