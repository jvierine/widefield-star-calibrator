"""Independently validate rich native reports with h5py and NumPy/SVD."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile

import h5py
import numpy as np

root = Path(__file__).resolve().parents[1]
native = str(Path(sys.argv[1]).resolve())
fixture = root / "test_cases/BACC_NYA_20200218_010731"
source = fixture / "BACC_NYA_20200218_010731.png"
with tempfile.TemporaryDirectory(prefix="wisc-report-") as temporary:
    temporary = Path(temporary)
    output = temporary / "report.zip"
    subprocess.run([native, "report", str(fixture / "case.json"), "--image", str(source), "--output", str(output)], check=True)
    with zipfile.ZipFile(output) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        session = json.loads(archive.read("session.json"))
        original = archive.read(manifest["source_file"])
        assert original == source.read_bytes()
        assert hashlib.sha256(original).hexdigest() == session["image_sha256"]
        assert "original.png" not in archive.namelist()
        html = archive.read("report.html").decode()
        for figure in ["residuals.png", "overlay.png", "miracle_equidistant.png", "miracle_equisolid.png"]:
            assert archive.read(figure).startswith(b"\x89PNG\r\n\x1a\n")
            assert figure in html
        pairs = session["job"]["pairs"]
        with h5py.File(io.BytesIO(archive.read("calibration.h5"))) as hdf:
            selected = hdf["selected_stars"][:]
            assert selected.shape == (50, 14)
            columns = hdf.attrs["selected_star_columns"].split()
            columns = [v.decode() if isinstance(v, bytes) else v for v in columns]
            np.testing.assert_array_equal(selected[:, columns.index("star_row_px_1based")], [p["y_px"] + 1 for p in pairs])
            np.testing.assert_array_equal(selected[:, columns.index("star_col_px_1based")], [p["x_px"] + 1 for p in pairs])
            stored_session = json.loads(bytes(hdf["session_json"][:]))
            assert stored_session == session
            names = json.loads(hdf.attrs["selected_star_names"])
            assert names[0] == session["metadata"]["testCase"]["matches"][0]["catalog"]["name"]
        product = json.loads(archive.read("miracle.json"))
        # Independent least-squares solve, not a call to Rust/legacy MIRACLE.
        for key in ["equidistant", "equisolid"]:
            matrix, observed = [], []
            for pair in pairs:
                az, ze = pair["azimuth_rad"], pair["zenith_rad"]
                radius = ze if key == "equidistant" else np.sin(ze / 2)
                c, s = np.cos(az), np.sin(az)
                matrix.extend([[1, 0, -radius*c, radius*s], [0, 1, -radius*s, -radius*c]])
                observed.extend([pair["y_px"]+1, pair["x_px"]+1])
            parameters, _, rank, _ = np.linalg.lstsq(matrix, observed, rcond=None)
            assert rank == 4
            fit = product[key]
            np.testing.assert_allclose([fit["xcPx"], fit["ycPx"], fit["scalePx"], fit["rotationRad"]],
                                       [parameters[0], parameters[1], np.hypot(*parameters[2:]), np.arctan2(parameters[3], parameters[2])], rtol=1e-11, atol=1e-9)
    # A fitted JSON/HDF round trip must keep provenance, masks and identities.
    result = temporary / "refitted.json"
    subprocess.run([native, "fit", str(output), "--lm", "--max-iterations", "2", "--output", str(result)], check=True)
    fitted = json.loads(result.read_text())
    assert fitted["session"]["metadata"] == session["metadata"]
    assert fitted["session"]["image_sha256"] == session["image_sha256"]
    rich = temporary / "refitted.h5"
    subprocess.run([native, "fit", str(result), "--max-iterations", "1", "--output", str(rich)], check=True)
    with h5py.File(rich) as hdf:
        restored = json.loads(bytes(hdf["session_json"][:]))
        assert restored["image_sha256"] == session["image_sha256"]
        assert restored["metadata"] == session["metadata"]
print("Rich report verification passed: original-byte SHA-256, no duplicate PNG, figures, h5py star table/session, independent NumPy MIRACLE fits, native ZIP/JSON/HDF provenance round trips.")
