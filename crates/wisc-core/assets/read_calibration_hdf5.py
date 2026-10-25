"""Read WISC's authoritative native model and measured stars (no refitting)."""
import json
import h5py
import numpy as np
from wisc_mapper import az_el_to_image

with h5py.File("calibration.h5", "r") as f:
    calibration = json.loads(bytes(f["calibration_json"][:]))
    model = calibration.get("calibration", calibration.get("initial"))
    optpar = f["best_fit_wisc_optpar_with_optmod"][:]
    stars = f["selected_stars"][:]
    columns = f.attrs["selected_star_columns"].split()
    names = json.loads(f.attrs["selected_star_names"])
    print("Native optpar:", optpar)
    print("Measured stars:", len(stars), "image:", model["width"], model["height"])
    for row, name in zip(stars, names):
        # HDF5 rows/columns are ONE-based. Mapper returns ZERO-based x/y.
        az, altitude = row[3], row[2]
        predicted = az_el_to_image(az, altitude)
        measured = np.array([row[5] - 1, row[4] - 1])
        print(name, "residual [dx,dy] pixels:", predicted - measured)
