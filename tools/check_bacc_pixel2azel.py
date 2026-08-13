#!/usr/bin/env python3
"""Plot selected BACC pixel centers and check them with pixel_to_az_el."""

import json
import os
import sys

import astropy.units as u
import numpy as np
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from scipy.ndimage import gaussian_filter

import matplotlib.pyplot as plt

sys.path.insert(0, ".")
from wisc_lens import az_el_to_pixel, pixel2azel


CASES = ("BACC_LYR_20200101_002407", "BACC_NYA_20200218_010731")
MAX_RMS_PX = (0.75, 1.10)
figure, axes = plt.subplots(1, 2, figsize=(14, 7), constrained_layout=True)

for case_id, max_rms, axis in zip(CASES, MAX_RMS_PX, axes):
    folder = "test_cases/" + case_id
    with open(folder + "/case.json") as file:
        payload = json.load(file)
    case = payload["testCase"]
    image = plt.imread(folder + "/" + case_id + ".png").astype(float)

    x = np.array([star["image"]["x"] for star in case["matches"]])
    y = np.array([star["image"]["y"] for star in case["matches"]])
    optmod = int(case["optpar"][0])
    optpar = case["optpar"][1:]

    location = EarthLocation(case["lonDeg"] * u.deg, case["latDeg"] * u.deg, case["altM"] * u.m)
    frame = AltAz(obstime=Time(case["timestampUtc"]), location=location, pressure=0 * u.hPa)
    stars = SkyCoord(
        ra=[star["catalog"]["raHours"] * 15 for star in case["matches"]] * u.deg,
        dec=[star["catalog"]["decDeg"] for star in case["matches"]] * u.deg,
    ).transform_to(frame)

    wisc_az_el = np.array([
        pixel2azel(px, py, optpar, case["width"], case["height"], optmod=optmod)
        for px, py in zip(x, y)
    ])
    predicted_model = np.array([
        az_el_to_pixel(az, el, optpar, case["width"], case["height"], optmod=optmod)
        for az, el in zip(stars.az.deg, stars.alt.deg)
    ])
    predicted = predicted_model.copy()
    pixel_error = np.hypot(predicted[:, 0] - x, predicted[:, 1] - y)
    sky_error = SkyCoord(
        az=wisc_az_el[:, 0] * u.deg,
        alt=wisc_az_el[:, 1] * u.deg,
        frame=frame,
    ).separation(stars).deg
    included = np.array([star["catalog"]["mag"] <= case["maxMag"] for star in case["matches"]])
    rms = np.sqrt(np.mean(pixel_error[included] ** 2))
    print(
        f"{case_id}: optmod={optmod}, RMS={rms:.3f} px, "
        f"angular RMS={np.sqrt(np.mean(sky_error[included]**2)):.4f} deg"
    )
    assert rms < max_rms

    gray = image.mean(axis=2)
    display = gray - gaussian_filter(gray, 4)
    low, high = np.percentile(display, (2, 99.7))
    axis.imshow(
        np.clip((display - low) / (high - low), 0, 1),
        cmap="gray",
        interpolation="nearest",
        extent=(-0.5, case["width"] - 0.5, case["height"] - 0.5, -0.5),
    )
    axis.scatter(x, y, s=14, color="black", label="selected pixel center")
    axis.scatter(x, y, s=45, facecolors="none", edgecolors="#39ff88")
    axis.scatter(predicted[:, 0], predicted[:, 1], s=35, marker="x", color="#00d9ff",
                 label="Astropy projected by wisc_lens")
    axis.set_title(f"{case_id}\noptmod {optmod}; integer coordinates are pixel centers")
    axis.set_xlabel("x / column [zero-based pixel center]")
    axis.set_ylabel("y / row [zero-based pixel center]")
    axis.legend(loc="lower right", fontsize=8)

os.makedirs("test-report", exist_ok=True)
output = "test-report/bacc-wisc-pixel2azel.png"
figure.savefig(output, dpi=220)
print(f"wrote {output}")
