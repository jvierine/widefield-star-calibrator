"""Execute Rust-generated Python/C mappers against the shared Rust projection."""
import ctypes
import importlib.util
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile

wisc = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="wisc-code-exports-") as directory:
    directory = Path(directory)
    for model in [1, 2, 3, 4, 5, 6, 12, 20]:
        parameters = [0.9, -1.2, 1.0, -2.0, 3.0, 0.012345678901234567, -0.02, -0.25 if model == 12 else 0.7]
        if model == 20:
            parameters[7] = 0.02
            parameters += [-0.005, 0.0004, 0.0001, -0.0002]
        calibration = {"model": model, "optpar": parameters, "width": 1920, "height": 1080}
        source = directory / "calibration.json"
        source.write_text(json.dumps(calibration))
        paths = {}
        for language, extension in [("python", "py"), ("c", "c"), ("julia", "jl"), ("matlab", "m")]:
            path = directory / f"mapper_{model}.{extension}"
            subprocess.run([wisc, "export", str(source), "--language", language, "--output", str(path)], check=True)
            assert "{{" not in path.read_text()
            paths[language] = path
        spec = importlib.util.spec_from_file_location(f"mapper_{model}", paths["python"])
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        shared = directory / f"mapper_{model}.so"
        subprocess.run(["cc", "-std=c99", "-O2", "-shared", "-fPIC", str(paths["c"]), "-lm", "-o", str(shared)], check=True)
        function = ctypes.CDLL(str(shared)).aida_az_el_to_image
        function.argtypes = [ctypes.c_double, ctypes.c_double, ctypes.POINTER(ctypes.c_double), ctypes.POINTER(ctypes.c_double)]
        samples = [{"azimuth_rad": math.radians(az), "zenith_rad": math.radians(ze)} for az in range(0, 360, 45) for ze in [15, 35, 60, 179]]
        sample_path = directory / "samples.json"
        sample_path.write_text(json.dumps(samples))
        expected = json.loads(subprocess.check_output([wisc, "project", str(source), str(sample_path)]))
        for sample, target in zip(samples, expected):
            azimuth = math.degrees(sample["azimuth_rad"])
            altitude = 90 - math.degrees(sample["zenith_rad"])
            python = module.az_el_to_image(azimuth, altitude)
            x, y = ctypes.c_double(), ctypes.c_double()
            function(azimuth, altitude, ctypes.byref(x), ctypes.byref(y))
            c = [x.value, y.value]
            if target is None:
                assert all(math.isnan(value) for value in python), (model, python)
                assert all(math.isnan(value) for value in c), (model, c)
            else:
                for actual in [python, c]:
                    for value, reference in zip(actual, target):
                        assert math.isclose(value, reference, rel_tol=2e-12, abs_tol=1e-7), (model, value, reference)
        print(f"Rust-generated model {model}: Python/C projections verified; Julia/MATLAB full-precision exports generated.")
