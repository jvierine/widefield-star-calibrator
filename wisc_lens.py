"""Reusable WISC lens-model mapper.

This module supports the WISC/AIDA browser optical models and the Brown-Conrady
model. It is intentionally a single file: install it with ``setup.py`` or copy
``wisc_lens.py`` next to a Python script.

The public API expects the browser/export ``optpar`` convention, where the
first element is the optical model number:

    [optmod, f1, f2, alpha, beta, gamma, du, dv, ...]

Use ``az_el_to_pixel`` for the forward projection and ``pixel_to_az_el`` for a
numerical inverse.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Optional, Sequence, Tuple

import numpy as np


BROWN_CONRADY_OPTMOD = 20
SUPPORTED_OPTMODS = (1, 2, 3, 4, 5, 6, 12, BROWN_CONRADY_OPTMOD)


def _as_float_array(values: Sequence[float]) -> np.ndarray:
    arr = np.asarray(values, dtype=float).ravel()
    if arr.size < 9:
        raise ValueError("optpar must contain [optmod, f1, f2, alpha, beta, gamma, du, dv, ...]")
    return arr


def split_optpar(optpar: Sequence[float], optmod: Optional[int] = None) -> Tuple[int, np.ndarray]:
    """Return ``(optmod, parameters_without_model_number)``.

    The normal WISC convention is to include ``optmod`` as the first value. For
    compatibility with embedded code, an optpar vector without the model number
    can be used if ``optmod`` is supplied explicitly.
    """
    arr = _as_float_array(optpar)
    if optmod is None:
        model = int(round(float(arr[0])))
        params = arr[1:].astype(float, copy=True)
    else:
        model = int(round(float(optmod)))
        params = arr.astype(float, copy=True)
    if model not in SUPPORTED_OPTMODS:
        raise ValueError(f"unsupported optmod {model}")
    required = 12 if model == BROWN_CONRADY_OPTMOD else 8
    if params.size < required:
        if model == BROWN_CONRADY_OPTMOD and params.size >= 8:
            params = np.pad(params, (0, required - params.size), mode="constant")
        else:
            raise ValueError(f"optmod {model} requires {required} parameters after optmod")
    return model, params[:required]


def camera_rotation(alpha_deg: float, beta_deg: float, gamma_deg: float) -> np.ndarray:
    """Return the WISC/AIDA 3x3 camera rotation matrix."""
    a = math.radians(alpha_deg)
    b = math.radians(beta_deg)
    g = math.radians(gamma_deg)
    rot1 = np.array(
        [
            [math.cos(g), -math.sin(g), 0.0],
            [math.sin(g), math.cos(g), 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=float,
    )
    rot2 = np.array(
        [
            [math.cos(a), 0.0, math.sin(a)],
            [0.0, 1.0, 0.0],
            [-math.sin(a), 0.0, math.cos(a)],
        ],
        dtype=float,
    )
    rot3 = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, math.cos(b), math.sin(b)],
            [0.0, -math.sin(b), math.cos(b)],
        ],
        dtype=float,
    )
    return rot2 @ rot3 @ rot1


def sky_vector_from_az_el(az_deg: float, el_deg: float) -> np.ndarray:
    """Return the local east/north/up unit vector for azimuth/elevation."""
    az = math.radians(az_deg)
    ze = math.radians(90.0 - el_deg)
    sinze = math.sin(ze)
    return np.array([sinze * math.sin(az), sinze * math.cos(az), math.cos(ze)], dtype=float)


def camera_frame_vector(az_deg: float, el_deg: float, params: Sequence[float]) -> np.ndarray:
    """Rotate an azimuth/elevation direction into the camera frame."""
    p = np.asarray(params, dtype=float)
    return sky_vector_from_az_el(az_deg, el_deg) @ camera_rotation(p[2], p[3], p[4])


def az_el_to_pixel(
    az_deg: float,
    el_deg: float,
    optpar: Sequence[float],
    width: float,
    height: float,
    optmod: Optional[int] = None,
) -> Tuple[float, float]:
    """Project azimuth/elevation in degrees to 0-based image pixel coordinates."""
    model, p = split_optpar(optpar, optmod)
    s1, s2, s3 = camera_frame_vector(az_deg, el_deg, p)
    radial = math.hypot(s1, s2)
    f1, f2 = p[0], p[1]
    du, dv = p[5], p[6]
    radial_alpha = p[7]

    if radial <= 1e-12:
        u_norm = 0.5 + du
        v_norm = 0.5 + dv
    elif model == 1:
        safe_s3 = s3 if abs(s3) > 1e-12 else math.copysign(1e-12, s3 if s3 else 1.0)
        u_norm = f1 * s1 / safe_s3 + 0.5 + du
        v_norm = f2 * s2 / safe_s3 + 0.5 + dv
    elif model == 2:
        theta = math.atan2(radial, s3)
        r = math.sin(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif model == 3:
        theta = math.atan2(radial, s3)
        safe_s3 = max(s3, 1e-12)
        u_norm = f1 * (1.0 - radial_alpha) * s1 / safe_s3 + f1 * radial_alpha * s1 / radial * theta + 0.5 + du
        v_norm = f2 * (1.0 - radial_alpha) * s2 / safe_s3 + f2 * radial_alpha * s2 / radial * theta + 0.5 + dv
    elif model == 4:
        theta = math.atan2(radial, s3)
        r = abs(theta) ** radial_alpha
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif model == 5:
        theta = math.atan2(radial, s3)
        r = math.tan(radial_alpha * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif model == 6:
        theta = math.atan2(radial, s3)
        r = math.sin(0.5 * theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif model == 12:
        theta = math.atan2(radial, s3)
        if radial_alpha > 0:
            r = math.tan(radial_alpha * theta) / radial_alpha
        elif radial_alpha < 0:
            r = math.sin(radial_alpha * theta) / radial_alpha
        else:
            r = abs(theta)
        u_norm = f1 * s1 / radial * r + 0.5 + du
        v_norm = f2 * s2 / radial * r + 0.5 + dv
    elif model == BROWN_CONRADY_OPTMOD:
        safe_s3 = s3 if abs(s3) > 1e-12 else math.copysign(1e-12, s3 if s3 else 1.0)
        xn = s1 / safe_s3
        yn = s2 / safe_s3
        r2 = xn * xn + yn * yn
        r4 = r2 * r2
        r6 = r4 * r2
        k1, k2, k3, p1, p2 = p[7], p[8], p[9], p[10], p[11]
        radial_distortion = 1.0 + k1 * r2 + k2 * r4 + k3 * r6
        xd = xn * radial_distortion + 2.0 * p1 * xn * yn + p2 * (r2 + 2.0 * xn * xn)
        yd = yn * radial_distortion + p1 * (r2 + 2.0 * yn * yn) + 2.0 * p2 * xn * yn
        u_norm = f1 * xd + 0.5 + du
        v_norm = f2 * yd + 0.5 + dv
    else:  # pragma: no cover - split_optpar validates this.
        raise ValueError(f"unsupported optmod {model}")

    return u_norm * float(width) - 1.0, v_norm * float(height) - 1.0


def _pixel_error_sq(
    az_deg: float,
    el_deg: float,
    x: float,
    y: float,
    optpar: Sequence[float],
    width: float,
    height: float,
    optmod: Optional[int],
) -> float:
    px, py = az_el_to_pixel(az_deg % 360.0, el_deg, optpar, width, height, optmod)
    dx = px - x
    dy = py - y
    if not math.isfinite(dx) or not math.isfinite(dy):
        return float("inf")
    return dx * dx + dy * dy


def pixel_to_az_el(
    x: float,
    y: float,
    optpar: Sequence[float],
    width: float,
    height: float,
    optmod: Optional[int] = None,
    min_el_deg: float = 0.0,
    max_el_deg: float = 90.0,
    return_error: bool = False,
) -> Tuple[float, float] | Tuple[float, float, float]:
    """Numerically invert image pixel coordinates to ``(az_deg, el_deg)``.

    The inverse is intentionally dependency-light: it uses a coarse search plus
    a coordinate pattern search instead of SciPy. It is meant for calibrated
    pixels inside the useful field of view. If ``return_error`` is true, the
    returned tuple includes the residual reprojection error in pixels.
    """
    x = float(x)
    y = float(y)
    width = float(width)
    height = float(height)
    min_el = float(min_el_deg)
    max_el = float(max_el_deg)
    starts = []
    for el in (max_el, 75.0, 60.0, 45.0, 30.0, 15.0, min_el):
        if min_el <= el <= max_el:
            for az in (0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0):
                starts.append((az, el))

    best_az, best_el, best_err = 0.0, max_el, float("inf")
    for az, el in starts:
        err = _pixel_error_sq(az, el, x, y, optpar, width, height, optmod)
        if err < best_err:
            best_az, best_el, best_err = az, el, err

    for step in (30.0, 12.0, 5.0, 2.0, 0.75, 0.25, 0.08, 0.025, 0.008):
        improved = True
        while improved:
            improved = False
            candidates = []
            for daz in (-step, 0.0, step):
                for delel in (-step, 0.0, step):
                    if daz == 0.0 and delel == 0.0:
                        continue
                    cand_az = (best_az + daz) % 360.0
                    cand_el = min(max(best_el + delel, min_el), max_el)
                    candidates.append((cand_az, cand_el))
            for cand_az, cand_el in candidates:
                err = _pixel_error_sq(cand_az, cand_el, x, y, optpar, width, height, optmod)
                if err + 1e-18 < best_err:
                    best_az, best_el, best_err = cand_az, cand_el, err
                    improved = True

    az = best_az % 360.0
    el = min(max(best_el, min_el), max_el)
    err_px = math.sqrt(best_err)
    if return_error:
        return az, el, err_px
    return az, el


def az_el_to_image(*args, **kwargs):
    """Alias for compatibility with GUI-generated mapper snippets."""
    return az_el_to_pixel(*args, **kwargs)


def image_to_az_el(*args, **kwargs):
    """Alias for compatibility with GUI-generated mapper snippets."""
    return pixel_to_az_el(*args, **kwargs)


@dataclass(frozen=True)
class WiscCamera:
    """Small convenience wrapper around an optpar vector and image dimensions."""

    optpar: Sequence[float]
    width: float
    height: float

    def az_el_to_pixel(self, az_deg: float, el_deg: float) -> Tuple[float, float]:
        return az_el_to_pixel(az_deg, el_deg, self.optpar, self.width, self.height)

    def pixel_to_az_el(
        self,
        x: float,
        y: float,
        min_el_deg: float = 0.0,
        max_el_deg: float = 90.0,
        return_error: bool = False,
    ):
        return pixel_to_az_el(
            x,
            y,
            self.optpar,
            self.width,
            self.height,
            min_el_deg=min_el_deg,
            max_el_deg=max_el_deg,
            return_error=return_error,
        )
