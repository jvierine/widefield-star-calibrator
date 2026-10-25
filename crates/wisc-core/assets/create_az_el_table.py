"""Generate the optional full pixel-corner grid using the shared Rust inverse."""
import shutil
import subprocess

wisc = shutil.which("wisc")
if wisc is None:
    raise SystemExit("Install the native Rust wisc executable and put it on PATH.")
subprocess.run([wisc, "map", "calibration.h5", "--output", "calibration_az_el.h5", "--step", "1"], check=True)
print("Wrote compressed azimuth/elevation planes shaped [height+1,width+1].")
