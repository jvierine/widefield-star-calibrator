#!/usr/bin/env python3
"""Evaluate MIRACLE approximation error against a fitted WISC lens model.

The program reads a ``*_calibration.h5`` file from a WISC results ZIP. Image
coordinates are 1-based rows and columns with (1, 1) at the upper-left.

Examples
--------
Evaluate one image location::

    python evaluate_miracle_error.py --calibration image_calibration.h5 \
        --row 1434 --col 1324

Summarize a sampled image-aligned grid and optionally save it as HDF5::

    python evaluate_miracle_error.py --calibration image_calibration.h5 \
        --grid-size 512 --output-hdf5 miracle_error.h5

The module API exposes ``load_calibration()``, ``angular_error_deg()``, and
``sample_error_grid()`` for use from other Python programs.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import math
from pathlib import Path
from typing import Optional, Sequence, Tuple

import h5py
import numpy as np


SUPPORTED_OPTMODS = (1, 2, 3, 4, 5, 12, 20)


@dataclass(frozen=True)
class Calibration:
    """WISC and MIRACLE models loaded from a compact calibration HDF5."""

    path: Path
    width: int
    height: int
    optmod: int
    optpar: np.ndarray
    miracle: np.ndarray
    flip_overlay_x: bool = False
    flip_overlay_y: bool = False
    flip_image_x: bool = False
    flip_image_y: bool = False


def _scalar_attr(attrs, name: str, default=None):
    if name not in attrs:
        return default
    value = np.asarray(attrs[name]).reshape(-1)
    return value[0] if value.size else default


def load_calibration(path: Path | str) -> Calibration:
    """Load the native WISC and approximate MIRACLE models from HDF5."""
    path = Path(path)
    with h5py.File(path, "r") as h:
        required = ("wisc_optpar", "miracle_parameters")
        missing = [name for name in required if name not in h]
        if missing:
            raise ValueError(f"{path} is missing datasets: {', '.join(missing)}")
        optpar = np.asarray(h["wisc_optpar"], dtype=float)
        miracle = np.asarray(h["miracle_parameters"], dtype=float)
        width = int(_scalar_attr(h.attrs, "image_width", 0))
        height = int(_scalar_attr(h.attrs, "image_height", 0))
        optmod = int(_scalar_attr(h.attrs, "optmod", 0))
        flips = {
            name: bool(int(_scalar_attr(h.attrs, name, 0)))
            for name in (
                "flip_overlay_x",
                "flip_overlay_y",
                "flip_image_x",
                "flip_image_y",
            )
        }
    if width <= 0 or height <= 0:
        raise ValueError("calibration HDF5 has invalid image dimensions")
    if optmod not in SUPPORTED_OPTMODS:
        raise ValueError(f"unsupported WISC optmod {optmod}")
    if optpar.size < 8:
        raise ValueError("wisc_optpar must contain at least 8 values")
    if miracle.shape != (6,):
        raise ValueError("miracle_parameters must contain Glat Glon Xc Yc k rotAngle")
    if not np.all(np.isfinite(miracle)) or miracle[4] <= 0:
        raise ValueError("invalid MIRACLE parameter vector")
    return Calibration(
        path=path,
        width=width,
        height=height,
        optmod=optmod,
        optpar=optpar,
        miracle=miracle,
        **flips,
    )


def _camera_rotation(alpha_deg: float, beta_deg: float, gamma_deg: float) -> np.ndarray:
    alpha, beta, gamma = np.deg2rad([alpha_deg, beta_deg, gamma_deg])
    rot1 = np.array(
        [
            [np.cos(gamma), -np.sin(gamma), 0.0],
            [np.sin(gamma), np.cos(gamma), 0.0],
            [0.0, 0.0, 1.0],
        ]
    )
    rot2 = np.array(
        [
            [np.cos(alpha), 0.0, np.sin(alpha)],
            [0.0, 1.0, 0.0],
            [-np.sin(alpha), 0.0, np.cos(alpha)],
        ]
    )
    rot3 = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, np.cos(beta), np.sin(beta)],
            [0.0, -np.sin(beta), np.cos(beta)],
        ]
    )
    return rot2 @ rot3 @ rot1


def _theta_from_radius(q: np.ndarray, alpha: float, optmod: int) -> np.ndarray:
    q = np.asarray(q, dtype=float)
    if optmod == 2:
        if abs(alpha) < 1e-12:
            return q.copy()
        return np.arcsin(np.clip(q, -1.0, 1.0)) / alpha
    if optmod == 3:
        lo = np.zeros_like(q)
        hi = np.full_like(q, np.pi / 2.0 - 1e-6)
        for _ in range(70):
            mid = 0.5 * (lo + hi)
            projected = (1.0 - alpha) * np.tan(mid) + alpha * mid
            high = ~np.isfinite(projected) | (projected > q)
            hi = np.where(high, mid, hi)
            lo = np.where(high, lo, mid)
        return 0.5 * (lo + hi)
    if optmod == 4:
        if abs(alpha) < 1e-12:
            return np.full_like(q, np.nan)
        return np.power(q, 1.0 / alpha)
    if optmod == 5:
        if abs(alpha) < 1e-12:
            return q.copy()
        return np.arctan(q) / alpha
    if optmod == 12:
        if alpha > 0:
            return np.arctan(alpha * q) / alpha
        if alpha < 0:
            return np.arcsin(np.clip(alpha * q, -1.0, 1.0)) / alpha
        return q.copy()
    return np.full_like(q, np.nan)


def _undistort_brown_conrady(
    xd: np.ndarray,
    yd: np.ndarray,
    params: Sequence[float],
) -> Tuple[np.ndarray, np.ndarray]:
    x = np.array(xd, dtype=float, copy=True)
    y = np.array(yd, dtype=float, copy=True)
    padded = np.pad(np.asarray(params, dtype=float), (0, max(0, 12 - len(params))))
    k1, k2, k3, p1, p2 = padded[7:12]
    for _ in range(12):
        r2 = x * x + y * y
        scale = 1.0 + k1 * r2 + k2 * r2**2 + k3 * r2**3
        projected_x = x * scale + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
        projected_y = y * scale + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
        x += xd - projected_x
        y += yd - projected_y
    return x, y


def _model_pixels(
    row_px_1based: np.ndarray,
    col_px_1based: np.ndarray,
    calibration: Calibration,
) -> Tuple[np.ndarray, np.ndarray]:
    raw_x = np.asarray(col_px_1based, dtype=float) - 1.0
    raw_y = np.asarray(row_px_1based, dtype=float) - 1.0
    displayed_x = calibration.width - 1.0 - raw_x if calibration.flip_image_x else raw_x
    displayed_y = calibration.height - 1.0 - raw_y if calibration.flip_image_y else raw_y
    model_x = calibration.width - 1.0 - displayed_x if calibration.flip_overlay_x else displayed_x
    model_y = calibration.height - 1.0 - displayed_y if calibration.flip_overlay_y else displayed_y
    return model_x, model_y


def wisc_unit_vectors(
    row_px_1based: np.ndarray | float,
    col_px_1based: np.ndarray | float,
    calibration: Calibration,
) -> np.ndarray:
    """Return native WISC east/north/up vectors at raw image coordinates."""
    p = calibration.optpar
    f1, f2 = p[0], p[1]
    if abs(f1) < 1e-12 or abs(f2) < 1e-12:
        raise ValueError("WISC focal parameters must be non-zero")
    x, y = _model_pixels(row_px_1based, col_px_1based, calibration)
    u = (x + 1.0) / calibration.width - 0.5 - p[5]
    v = (y + 1.0) / calibration.height - 0.5 - p[6]

    if calibration.optmod == 1:
        s1 = u / f1
        s2 = v / f2
        s3 = np.ones_like(s1)
    elif calibration.optmod == 20:
        s1, s2 = _undistort_brown_conrady(u / f1, v / f2, p)
        s3 = np.ones_like(s1)
    else:
        qx = u / f1
        qy = v / f2
        q = np.hypot(qx, qy)
        theta = _theta_from_radius(q, p[7], calibration.optmod)
        radial = np.sin(theta)
        scale = np.divide(radial, q, out=np.ones_like(q), where=q > 1e-12)
        s1 = qx * scale
        s2 = qy * scale
        s3 = np.cos(theta)
        s1 = np.where(q > 1e-12, s1, 0.0)
        s2 = np.where(q > 1e-12, s2, 0.0)
        s3 = np.where(q > 1e-12, s3, 1.0)

    camera_norm = np.sqrt(s1 * s1 + s2 * s2 + s3 * s3)
    s1, s2, s3 = s1 / camera_norm, s2 / camera_norm, s3 / camera_norm
    rotation = _camera_rotation(p[2], p[3], p[4])
    east = s1 * rotation[0, 0] + s2 * rotation[0, 1] + s3 * rotation[0, 2]
    north = s1 * rotation[1, 0] + s2 * rotation[1, 1] + s3 * rotation[1, 2]
    up = s1 * rotation[2, 0] + s2 * rotation[2, 1] + s3 * rotation[2, 2]
    vectors = np.stack((east, north, up), axis=-1)
    norm = np.linalg.norm(vectors, axis=-1, keepdims=True)
    return vectors / norm


def miracle_unit_vectors(
    row_px_1based: np.ndarray | float,
    col_px_1based: np.ndarray | float,
    calibration: Calibration,
) -> np.ndarray:
    """Return MIRACLE east/north/up vectors at raw image coordinates."""
    _, _, zenith_row, zenith_col, k_px_per_deg, rotation_rad = calibration.miracle
    vertical = np.asarray(row_px_1based, dtype=float) - zenith_row
    horizontal = np.asarray(col_px_1based, dtype=float) - zenith_col
    distance = np.hypot(vertical, horizontal)
    cos_rotation = math.cos(rotation_rad)
    sin_rotation = math.sin(rotation_rad)
    cos_az = np.divide(
        -vertical * cos_rotation - horizontal * sin_rotation,
        distance,
        out=np.ones_like(distance),
        where=distance > 1e-12,
    )
    sin_az = np.divide(
        -horizontal * cos_rotation + vertical * sin_rotation,
        distance,
        out=np.zeros_like(distance),
        where=distance > 1e-12,
    )
    zenith_rad = np.deg2rad(distance / k_px_per_deg)
    sin_zenith = np.sin(zenith_rad)
    return np.stack(
        (
            sin_zenith * sin_az,
            sin_zenith * cos_az,
            np.cos(zenith_rad),
        ),
        axis=-1,
    )


def angular_error_deg(
    row_px_1based: np.ndarray | float,
    col_px_1based: np.ndarray | float,
    calibration: Calibration,
) -> np.ndarray | float:
    """Return absolute WISC-vs-MIRACLE sky-angle error in degrees."""
    native = wisc_unit_vectors(row_px_1based, col_px_1based, calibration)
    miracle = miracle_unit_vectors(row_px_1based, col_px_1based, calibration)
    dot = np.sum(native * miracle, axis=-1)
    error = np.rad2deg(np.arccos(np.clip(dot, -1.0, 1.0)))
    return float(error) if np.ndim(error) == 0 else error


def _az_el(vectors: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    vectors = np.asarray(vectors, dtype=float)
    azimuth = np.mod(np.rad2deg(np.arctan2(vectors[..., 0], vectors[..., 1])), 360.0)
    elevation = np.rad2deg(np.arcsin(np.clip(vectors[..., 2], -1.0, 1.0)))
    return azimuth, elevation


def sample_error_grid(
    calibration: Calibration,
    max_dimension: int = 512,
) -> Tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Sample an image-aligned error grid capped at ``max_dimension``."""
    if max_dimension <= 0:
        raise ValueError("max_dimension must be positive")
    scale = min(1.0, max_dimension / max(calibration.width, calibration.height))
    grid_width = max(1, round(calibration.width * scale))
    grid_height = max(1, round(calibration.height * scale))
    rows = (np.arange(grid_height) + 0.5) * calibration.height / grid_height + 0.5
    cols = (np.arange(grid_width) + 0.5) * calibration.width / grid_width + 0.5
    col_grid, row_grid = np.meshgrid(cols, rows)
    errors = angular_error_deg(row_grid, col_grid, calibration)
    return rows, cols, errors


def write_error_hdf5(
    path: Path | str,
    calibration: Calibration,
    rows: np.ndarray,
    cols: np.ndarray,
    errors: np.ndarray,
) -> None:
    """Write a sampled angular-error grid as an HDF5 data product."""
    path = Path(path)
    with h5py.File(path, "w") as h:
        h.create_dataset("row_px_1based", data=rows)
        h.create_dataset("col_px_1based", data=cols)
        h.create_dataset(
            "angular_error_deg",
            data=errors.astype(np.float32),
            compression="gzip",
            compression_opts=4,
        )
        h.attrs["source_calibration"] = calibration.path.name
        h.attrs["description"] = (
            "Absolute angular separation in degrees between the native fitted "
            "WISC lens model and the approximate MIRACLE d=kz model."
        )
        h.attrs["coordinate_convention"] = (
            "Datasets use 1-based raw image row/column coordinates."
        )


def _find_calibration() -> Path:
    candidates = sorted(Path.cwd().glob("*_calibration.h5"))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise SystemExit("no *_calibration.h5 found; pass --calibration")
    raise SystemExit("multiple *_calibration.h5 files found; pass --calibration")


def _summary(errors: np.ndarray) -> str:
    valid = np.asarray(errors, dtype=float)
    valid = valid[np.isfinite(valid)]
    if not valid.size:
        return "no finite error samples"
    return "\n".join(
        [
            f"samples: {valid.size}",
            f"RMS angular error: {np.sqrt(np.mean(valid**2)):.6f} deg",
            f"median angular error: {np.median(valid):.6f} deg",
            f"95th percentile: {np.percentile(valid, 95):.6f} deg",
            f"98th percentile: {np.percentile(valid, 98):.6f} deg",
            f"maximum angular error: {np.max(valid):.6f} deg",
        ]
    )


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--calibration",
        type=Path,
        help="compact WISC *_calibration.h5 (auto-detected when unique)",
    )
    parser.add_argument("--row", type=float, help="1-based raw image row")
    parser.add_argument("--col", type=float, help="1-based raw image column")
    parser.add_argument(
        "--grid-size",
        type=int,
        default=512,
        help="maximum sampled grid dimension for summary mode (default: 512)",
    )
    parser.add_argument(
        "--output-hdf5",
        type=Path,
        help="optional sampled angular-error HDF5 output",
    )
    args = parser.parse_args(argv)
    if (args.row is None) != (args.col is None):
        parser.error("--row and --col must be supplied together")

    calibration = load_calibration(args.calibration or _find_calibration())
    if args.row is not None:
        native = wisc_unit_vectors(args.row, args.col, calibration)
        approximate = miracle_unit_vectors(args.row, args.col, calibration)
        native_az, native_el = _az_el(native)
        miracle_az, miracle_el = _az_el(approximate)
        print(f"row, column: {args.row:.6f}, {args.col:.6f} (1-based)")
        print(f"WISC azimuth, elevation: {float(native_az):.9f}, {float(native_el):.9f} deg")
        print(
            "MIRACLE azimuth, elevation: "
            f"{float(miracle_az):.9f}, {float(miracle_el):.9f} deg"
        )
        print(
            "absolute angular error: "
            f"{angular_error_deg(args.row, args.col, calibration):.9f} deg"
        )
        return 0

    rows, cols, errors = sample_error_grid(calibration, args.grid_size)
    print(f"sampled grid: {len(rows)} rows x {len(cols)} columns")
    print(_summary(errors))
    if args.output_hdf5:
        write_error_hdf5(args.output_hdf5, calibration, rows, cols, errors)
        print(f"wrote {args.output_hdf5}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
