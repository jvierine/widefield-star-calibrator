#!/usr/bin/env python3
"""Generate browser calibration fixtures from allsky7 HDF5/Matlab files."""

from __future__ import annotations

import json
import math
import re
import shutil
from pathlib import Path

import h5py
import numpy as np
from PIL import Image
import scipy.io as sio


ROOT = Path(__file__).resolve().parents[1]
ALLSKY = ROOT / "allsky7"
OUT = ROOT / "js" / "calibration_cases.js"
IMAGE_OUT = ROOT / "calibration_images"
SKIP_IMAGES = {
    # This frame is inconsistent with the rest of the calibration set. The
    # remaining allsky7 cases align well enough to use for lens-model tuning.
    "2025_02_19_03_44_00_000_010760_first1s.png",
}


def clean(value):
    if isinstance(value, bytes):
        return value.decode()
    if isinstance(value, np.generic):
        return value.item()
    return value


def timestamp_from_name(name: str) -> str | None:
    match = re.search(r"(20\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{3})", name)
    if not match:
        return None
    year, month, day, hour, minute, second, millisecond = match.groups()
    return f"{year}-{month}-{day}T{hour}:{minute}:{second}.{millisecond}"


def mat_calibration_points(mat_path: Path, stride: int = 80) -> list[list[float]]:
    data = sio.loadmat(mat_path)
    if "az" in data and "ze" in data:
        az = data["az"]
        ze = data["ze"]
    elif "flipped_az" in data and "flipped_ze" in data:
        az = data["flipped_az"]
        ze = data["flipped_ze"]
    else:
        return []

    rows, cols = az.shape
    points = []
    for row in range(stride // 2, rows, stride):
        for col in range(stride // 2, cols, stride):
            az_deg = (float(az[row, col]) * 180.0 / math.pi) % 360.0
            el_deg = 90.0 - float(ze[row, col]) * 180.0 / math.pi
            if math.isfinite(az_deg) and math.isfinite(el_deg) and el_deg > -5:
                # Browser convention: x is image column, y is image row.
                points.append([col, row, round(az_deg, 6), round(el_deg, 6)])
    return points


def main() -> None:
    mat_files = {path.name: path for path in ALLSKY.glob("*.mat")}
    cases = []
    seen = set()
    IMAGE_OUT.mkdir(parents=True, exist_ok=True)

    for h5_path in sorted(ALLSKY.glob("*_first1s.h5")):
        with h5py.File(h5_path, "r") as handle:
            attrs = {key: clean(value) for key, value in handle.attrs.items()}
            png = attrs.get("png_path") or h5_path.with_suffix(".png").name
            if png in SKIP_IMAGES:
                continue
            mat = attrs.get("calibration_mat_path")
            if mat not in mat_files:
                continue
            png_path = ALLSKY / png
            if not png_path.exists():
                continue
            key = (png, mat)
            if key in seen:
                continue
            seen.add(key)

            with Image.open(png_path) as image:
                width, height = image.size
            shutil.copy2(png_path, IMAGE_OUT / png)

            cases.append({
                "id": h5_path.stem,
                "label": f"{png} / {mat}",
                "image": f"calibration_images/{png}",
                "h5": f"allsky7/{h5_path.name}",
                "mat": f"allsky7/{mat}",
                "matName": mat,
                "timestampUtc": timestamp_from_name(png),
                "width": width,
                "height": height,
                "latDeg": float(handle["camera_lat_deg"][()]),
                "lonDeg": float(handle["camera_lon_deg"][()]),
                "optpar": [float(value) for value in handle["optpar"][()]],
                "calibrationPoints": mat_calibration_points(mat_files[mat]),
            })

    OUT.write_text(
        "window.AIDA_CALIBRATION_CASES = " +
        json.dumps(cases, separators=(",", ":")) +
        ";\n"
    )
    print(f"wrote {OUT} with {len(cases)} cases")


if __name__ == "__main__":
    main()
