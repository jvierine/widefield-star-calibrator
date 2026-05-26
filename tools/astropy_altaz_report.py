#!/usr/bin/env python3
"""Compare WISC/AIDA RA-Dec to az/el calculations with Astropy.

This is a regression for saved calibration cases.  It exercises the same
low-level spherical astronomy equations used by js/aidatools.js, including
J2000-to-observation-date precession, using Astropy as an independent reference
for catalogue-star azimuth/elevation coordinates.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import astropy.units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = ROOT / "test-report" / "astropy-altaz"
MIN_TOTAL_COMPARISONS = 100
MAX_ANGULAR_ERROR_DEG = 0.02
MAX_AZ_ERROR_DEG = 0.08
MAX_EL_ERROR_DEG = 0.02
ASTROPY_PRESSURE = 0 * u.hPa


def wrap_deg(value: float) -> float:
    """Wrap an angle difference to [-180, 180) degrees."""
    return (value + 180.0) % 360.0 - 180.0


def julian_date(timestamp: str) -> float:
    # Mirrors js/aidatools.js.  Python's datetime parser is deliberately not
    # used here so that the reference stays close to the JavaScript algorithm.
    from datetime import datetime, timezone

    stamp = timestamp.replace("Z", "+00:00")
    date = datetime.fromisoformat(stamp).astimezone(timezone.utc)
    year = date.year
    month = date.month
    day = date.day
    hour = date.hour
    minute = date.minute
    second = date.second + date.microsecond / 1_000_000.0
    if month <= 2:
        year -= 1
        month += 12
    a = math.floor(year / 100)
    b = 2 - a + math.floor(a / 4)
    day_fraction = (hour + minute / 60.0 + second / 3600.0) / 24.0
    return (
        math.floor(365.25 * (year + 4716))
        + math.floor(30.6001 * (month + 1))
        + day
        + day_fraction
        + b
        - 1524.5
    )


def gmst_degrees(timestamp: str) -> float:
    jd = julian_date(timestamp)
    t = (jd - 2451545.0) / 36525.0
    return (
        280.46061837
        + 360.98564736629 * (jd - 2451545.0)
        + 0.000387933 * t * t
        - t * t * t / 38710000.0
    ) % 360.0


def precess_j2000_to_date(ra_hours: float, dec_deg: float, timestamp: str) -> tuple[float, float]:
    """Precess J2000 catalogue RA/Dec to the observation date.

    This mirrors the browser implementation and uses the standard low-order
    FK5 precession formula.  It removes the dominant ~0.25 degree azimuth
    offset caused by treating J2000 catalogue coordinates as if they were
    date-of-observation coordinates.
    """
    t = (julian_date(timestamp) - 2451545.0) / 36525.0
    arcsec_to_rad = math.pi / (180.0 * 3600.0)
    zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * arcsec_to_rad
    z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * arcsec_to_rad
    theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * arcsec_to_rad
    ra = ra_hours / 12.0 * math.pi
    dec = dec_deg * math.pi / 180.0
    a = math.cos(dec) * math.sin(ra + zeta)
    b = math.cos(theta) * math.cos(dec) * math.cos(ra + zeta) - math.sin(theta) * math.sin(dec)
    c = math.sin(theta) * math.cos(dec) * math.cos(ra + zeta) + math.cos(theta) * math.sin(dec)
    return (math.atan2(a, b) + z) % (2.0 * math.pi), math.asin(max(-1.0, min(1.0, c)))


def aida_radec_to_az_el(
    ra_hours: float,
    dec_deg: float,
    timestamp: str,
    lat_deg: float,
    lon_deg: float,
) -> tuple[float, float]:
    deg = math.pi / 180.0
    rsidtime = (gmst_degrees(timestamp) + lon_deg) * deg
    rra, rdecl = precess_j2000_to_date(ra_hours, dec_deg, timestamp)
    rlat = lat_deg * deg
    alt = math.asin(
        math.cos(rsidtime - rra) * math.cos(rdecl) * math.cos(rlat)
        + math.sin(rdecl) * math.sin(rlat)
    )
    cos_alt = max(math.cos(alt), 1e-12)
    sina = math.sin(rsidtime - rra) * math.cos(rdecl) / cos_alt
    cosa = (
        math.cos(rsidtime - rra) * math.cos(rdecl) * math.sin(rlat)
        - math.sin(rdecl) * math.cos(rlat)
    ) / cos_alt
    az = (math.atan2(sina, cosa) + math.pi) % (2.0 * math.pi)
    return az * 180.0 / math.pi, alt * 180.0 / math.pi


def tracked_metadata_paths() -> list[Path]:
    try:
        result = subprocess.run(
            ["git", "ls-files", "test_cases/*/metadata.json"],
            cwd=ROOT,
            check=True,
            text=True,
            capture_output=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return []
    return [ROOT / line for line in result.stdout.splitlines() if line.strip()]


def filesystem_metadata_paths() -> list[Path]:
    return sorted((ROOT / "test_cases").glob("*/metadata.json"))


def load_case(metadata_path: Path) -> dict:
    with metadata_path.open("r", encoding="utf8") as fh:
        metadata = json.load(fh)
    metadata["_metadataPath"] = str(metadata_path.relative_to(ROOT))
    return metadata


def has_comparable_stars(metadata: dict) -> bool:
    if not {"timestampUtc", "latDeg", "lonDeg", "optpar"} <= set(metadata):
        return False
    for match in metadata.get("matches", []):
        star = match.get("catalog", {})
        if {"raHours", "decDeg"} <= set(star):
            return True
    return False


def astropy_vacuum_altaz_frame(timestamp: str, location: EarthLocation) -> AltAz:
    """Create an Astropy AltAz frame with atmospheric refraction disabled.

    Astropy applies atmospheric refraction in AltAz only when the frame pressure
    is non-zero.  The browser calculation does not model refraction, so this
    independent reference must be the unrefracted topocentric AltAz direction.
    """
    frame = AltAz(
        obstime=Time(timestamp, scale="utc"),
        location=location,
        pressure=ASTROPY_PRESSURE,
    )
    if abs(frame.pressure.to_value(u.hPa)) > 0.0:
        raise RuntimeError("Astropy AltAz frame must use pressure=0 hPa to disable atmospheric refraction")
    return frame


def compare_case(metadata: dict) -> dict:
    location = EarthLocation(
        lat=float(metadata["latDeg"]) * u.deg,
        lon=float(metadata["lonDeg"]) * u.deg,
        height=float(metadata.get("altM", 0.0)) * u.m,
    )
    frame = astropy_vacuum_altaz_frame(metadata["timestampUtc"], location)

    rows = []
    for match in metadata.get("matches", []):
        star = match.get("catalog", {})
        if not {"raHours", "decDeg"} <= set(star):
            continue
        coord = SkyCoord(
            ra=float(star["raHours"]) * 15.0 * u.deg,
            dec=float(star["decDeg"]) * u.deg,
            frame="icrs",
        ).transform_to(frame)
        astropy_az = float(coord.az.deg)
        astropy_el = float(coord.alt.deg)
        aida_az, aida_el = aida_radec_to_az_el(
            float(star["raHours"]),
            float(star["decDeg"]),
            metadata["timestampUtc"],
            float(metadata["latDeg"]),
            float(metadata["lonDeg"]),
        )
        d_az = wrap_deg(aida_az - astropy_az)
        d_el = aida_el - astropy_el
        angular = math.hypot(d_az * math.cos(math.radians(astropy_el)), d_el)
        residual = match.get("residual") or {}
        pixel_dx = residual.get("dx", math.nan)
        pixel_dy = residual.get("dy", math.nan)
        pixel_error = residual.get("r", math.nan)
        rows.append(
            {
                "caseId": metadata.get("id") or Path(metadata["_metadataPath"]).parent.name,
                "metadataPath": metadata["_metadataPath"],
                "name": star.get("name") or star.get("key") or f"match {match.get('id', '')}",
                "raHours": float(star["raHours"]),
                "decDeg": float(star["decDeg"]),
                "mag": float(star.get("mag", math.nan)),
                "aidaAzDeg": aida_az,
                "aidaElDeg": aida_el,
                "astropyAzDeg": astropy_az,
                "astropyElDeg": astropy_el,
                "dAzDeg": d_az,
                "dElDeg": d_el,
                "angularErrorDeg": angular,
                "pixelDx": float(pixel_dx) if pixel_dx is not None else math.nan,
                "pixelDy": float(pixel_dy) if pixel_dy is not None else math.nan,
                "pixelError": float(pixel_error) if pixel_error is not None else math.nan,
            }
        )

    return {
        "caseId": metadata.get("id") or Path(metadata["_metadataPath"]).parent.name,
        "metadataPath": metadata["_metadataPath"],
        "image": metadata.get("image", ""),
        "timestampUtc": metadata["timestampUtc"],
        "latDeg": metadata["latDeg"],
        "lonDeg": metadata["lonDeg"],
        "altM": metadata.get("altM", 0.0),
        "count": len(rows),
        "rows": rows,
        "summary": summarize_rows(rows),
        "astropyAltAz": {
            "atmosphericRefractionEnabled": False,
            "pressureHpa": float(frame.pressure.to_value(u.hPa)),
            "description": "Unrefracted topocentric AltAz: Astropy pressure is fixed to 0 hPa.",
        },
    }


def summarize_rows(rows: list[dict]) -> dict:
    def max_abs(key: str) -> float:
        values = [abs(row[key]) for row in rows if math.isfinite(row.get(key, math.nan))]
        return max(values, default=math.nan)

    def finite_values(key: str) -> list[float]:
        return [row[key] for row in rows if math.isfinite(row.get(key, math.nan))]

    angular_errors = sorted(row["angularErrorDeg"] for row in rows)
    rms = math.sqrt(sum(row["angularErrorDeg"] ** 2 for row in rows) / len(rows)) if rows else math.nan
    median = angular_errors[len(angular_errors) // 2] if angular_errors else math.nan
    pixel_errors = sorted(finite_values("pixelError"))
    pixel_rms = math.sqrt(sum(value * value for value in pixel_errors) / len(pixel_errors)) if pixel_errors else math.nan
    pixel_median = pixel_errors[len(pixel_errors) // 2] if pixel_errors else math.nan
    return {
        "rmsAngularErrorDeg": rms,
        "medianAngularErrorDeg": median,
        "maxAngularErrorDeg": max((row["angularErrorDeg"] for row in rows), default=math.nan),
        "maxAbsAzErrorDeg": max_abs("dAzDeg"),
        "maxAbsElErrorDeg": max_abs("dElDeg"),
        "pixelResidualCount": len(pixel_errors),
        "rmsPixelError": pixel_rms,
        "medianPixelError": pixel_median,
        "maxPixelError": max(pixel_errors, default=math.nan),
        "maxAbsPixelDx": max_abs("pixelDx"),
        "maxAbsPixelDy": max_abs("pixelDy"),
    }


def compare_cases(metadata_paths: list[Path], case_filter: str | None = None) -> dict:
    iers.conf.auto_download = False
    iers.conf.iers_degraded_accuracy = "warn"
    iers.conf.auto_max_age = None

    skipped = []
    cases = []
    for metadata_path in metadata_paths:
        metadata = load_case(metadata_path)
        case_id = metadata.get("id") or metadata_path.parent.name
        if case_filter and case_filter not in {case_id, metadata_path.parent.name}:
            continue
        if not has_comparable_stars(metadata):
            skipped.append(
                {
                    "caseId": case_id,
                    "metadataPath": str(metadata_path.relative_to(ROOT)),
                    "reason": "missing optpar/site/time or catalogue star matches",
                }
            )
            continue
        cases.append(compare_case(metadata))

    rows = [row for case in cases for row in case["rows"]]
    return {
        "caseCount": len(cases),
        "skipped": skipped,
        "count": len(rows),
        "cases": cases,
        "rows": rows,
        "summary": summarize_rows(rows),
        "astropyAltAz": {
            "atmosphericRefractionEnabled": False,
            "pressureHpa": 0.0,
            "description": "Unrefracted topocentric AltAz: every Astropy frame is constructed with pressure=0 hPa.",
        },
    }


def write_report(result: dict, out_dir: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = result["rows"]

    fig, ax = plt.subplots(figsize=(7.2, 5.6), dpi=170)
    ax.axhline(0, color="0.78", linewidth=0.8)
    ax.axvline(0, color="0.78", linewidth=0.8)
    sc = ax.scatter(
        [row["dAzDeg"] for row in rows],
        [row["dElDeg"] for row in rows],
        c=[row["astropyElDeg"] for row in rows],
        s=17,
        cmap="viridis",
        edgecolors="black",
        linewidths=0.15,
        alpha=0.82,
    )
    ax.set_xlabel("AIDA - Astropy azimuth error (deg)")
    ax.set_ylabel("AIDA - Astropy elevation error (deg)")
    ax.set_title("AIDA/Astropy AltAz residuals for saved test cases")
    ax.grid(True, alpha=0.25)
    cb = fig.colorbar(sc, ax=ax)
    cb.set_label("Astropy elevation (deg)")
    fig.tight_layout()
    scatter_name = "astropy_altaz_scatter.png"
    fig.savefig(out_dir / scatter_name)
    plt.close(fig)

    pixel_rows = [row for row in rows if math.isfinite(row.get("pixelError", math.nan))]
    pixel_scatter_name = "pixel_residual_scatter.png"
    if pixel_rows:
        fig, ax = plt.subplots(figsize=(6.2, 5.6), dpi=170)
        ax.axhline(0, color="0.78", linewidth=0.8)
        ax.axvline(0, color="0.78", linewidth=0.8)
        sc = ax.scatter(
            [row["pixelDx"] for row in pixel_rows],
            [row["pixelDy"] for row in pixel_rows],
            c=[row["pixelError"] for row in pixel_rows],
            s=17,
            cmap="magma",
            edgecolors="black",
            linewidths=0.15,
            alpha=0.82,
        )
        ax.set_aspect("equal", adjustable="box")
        ax.set_xlabel("Model - image x residual (px)")
        ax.set_ylabel("Model - image y residual (px)")
        ax.set_title("Saved star-pair pixel residuals")
        ax.grid(True, alpha=0.25)
        cb = fig.colorbar(sc, ax=ax)
        cb.set_label("Pixel residual radius (px)")
        fig.tight_layout()
        fig.savefig(out_dir / pixel_scatter_name)
        plt.close(fig)

    (out_dir / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    s = result["summary"]
    case_rows = "\n".join(
        "<tr>"
        f"<td>{case['caseId']}</td>"
        f"<td>{case['count']}</td>"
        f"<td>{case['summary']['rmsAngularErrorDeg']:.4f}</td>"
        f"<td>{case['summary']['maxAngularErrorDeg']:.4f}</td>"
        f"<td>{case['summary']['rmsPixelError']:.3f}</td>"
        f"<td>{case['summary']['maxPixelError']:.3f}</td>"
        f"<td>{case['summary']['maxAbsAzErrorDeg']:.4f}</td>"
        f"<td>{case['summary']['maxAbsElErrorDeg']:.4f}</td>"
        f"<td><code>{case['metadataPath']}</code></td>"
        "</tr>"
        for case in sorted(result["cases"], key=lambda item: item["summary"]["maxAngularErrorDeg"], reverse=True)
    )
    worst_rows = "\n".join(
        "<tr>"
        f"<td>{row['caseId']}</td>"
        f"<td>{row['name']}</td>"
        f"<td>{row['astropyAzDeg']:.3f}</td>"
        f"<td>{row['astropyElDeg']:.3f}</td>"
        f"<td>{row['dAzDeg']:.4f}</td>"
        f"<td>{row['dElDeg']:.4f}</td>"
        f"<td>{row['angularErrorDeg']:.4f}</td>"
        f"<td>{row['pixelError']:.3f}</td>"
        "</tr>"
        for row in sorted(rows, key=lambda item: item["angularErrorDeg"], reverse=True)[:25]
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Astropy AltAz Cross-Check</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.45; color: #172033; }}
code {{ background: #eef2f7; padding: 0.1rem 0.25rem; border-radius: 4px; }}
.metrics {{ display: grid; grid-template-columns: repeat(4, minmax(10rem, 1fr)); gap: 0.75rem; max-width: 72rem; }}
.metric {{ border: 1px solid #d6dde8; border-radius: 8px; padding: 0.8rem; background: #f8fafc; }}
.metric b {{ display: block; font-size: 1.45rem; }}
img {{ max-width: min(100%, 900px); border: 1px solid #d6dde8; border-radius: 8px; }}
table {{ border-collapse: collapse; margin-top: 1rem; font-size: 0.94rem; }}
th, td {{ border-bottom: 1px solid #d6dde8; padding: 0.35rem 0.6rem; text-align: right; vertical-align: top; }}
th:first-child, td:first-child, th:nth-child(2), td:nth-child(2), th:last-child, td:last-child {{ text-align: left; }}
</style>
</head>
<body>
<h1>Astropy AltAz Cross-Check</h1>
<p>This regression compares the <code>js/aidatools.js</code> RA/Dec to azimuth/elevation
calculation with Astropy for every tracked saved test case that has a lens model
and paired catalogue-star detections.  AIDA precesses J2000 catalogue
coordinates to the observation date before applying the spherical AltAz formula.
Astropy is explicitly configured for unrefracted topocentric AltAz coordinates
by setting <code>pressure=0 hPa</code>; there is no atmospheric refraction
correction in this reference calculation.</p>
<div class="metrics">
<div class="metric"><span>Cases</span><b>{result['caseCount']}</b></div>
<div class="metric"><span>Stars</span><b>{result['count']}</b></div>
<div class="metric"><span>RMS angular error</span><b>{s['rmsAngularErrorDeg']:.4f} deg</b></div>
<div class="metric"><span>Max angular error</span><b>{s['maxAngularErrorDeg']:.4f} deg</b></div>
<div class="metric"><span>RMS pixel error</span><b>{s['rmsPixelError']:.3f} px</b></div>
<div class="metric"><span>Max pixel error</span><b>{s['maxPixelError']:.3f} px</b></div>
</div>
<p>Maximum absolute azimuth/elevation errors are {s['maxAbsAzErrorDeg']:.4f} deg
and {s['maxAbsElErrorDeg']:.4f} deg. Maximum absolute pixel dx/dy residuals are
{s['maxAbsPixelDx']:.3f} px and {s['maxAbsPixelDy']:.3f} px.</p>
<h2>Angular Error Scatter</h2>
<img src="{scatter_name}" alt="AIDA minus Astropy azimuth/elevation scatter plot">
<h2>Pixel Error Scatter</h2>
<img src="{pixel_scatter_name}" alt="Model minus image pixel residual scatter plot">
<h2>Per-Case Summary</h2>
<table>
<thead><tr><th>Case</th><th>Stars</th><th>RMS angular</th><th>Max angular</th><th>RMS px</th><th>Max px</th><th>Max |az|</th><th>Max |el|</th><th>Metadata</th></tr></thead>
<tbody>{case_rows}</tbody>
</table>
<h2>Largest Residuals</h2>
<table>
<thead><tr><th>Case</th><th>Star</th><th>Astropy az</th><th>Astropy el</th><th>dAz</th><th>dEl</th><th>Angular</th><th>Pixel</th></tr></thead>
<tbody>{worst_rows}</tbody>
</table>
</body>
</html>
"""
    (out_dir / "index.html").write_text(html, encoding="utf8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", type=Path, action="append", help="metadata.json file to test; may be repeated")
    parser.add_argument("--case", help="limit to one case id or test_cases directory name")
    parser.add_argument("--tracked", action="store_true", help="use metadata files tracked by git")
    parser.add_argument("--all-files", action="store_true", help="scan every test_cases/*/metadata.json file")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--min-total-comparisons", type=int, default=MIN_TOTAL_COMPARISONS)
    parser.add_argument("--max-angular-error-deg", type=float, default=MAX_ANGULAR_ERROR_DEG)
    parser.add_argument("--max-az-error-deg", type=float, default=MAX_AZ_ERROR_DEG)
    parser.add_argument("--max-el-error-deg", type=float, default=MAX_EL_ERROR_DEG)
    args = parser.parse_args()

    if args.metadata:
        metadata_paths = [path if path.is_absolute() else ROOT / path for path in args.metadata]
    elif args.all_files:
        metadata_paths = filesystem_metadata_paths()
    else:
        metadata_paths = tracked_metadata_paths()

    result = compare_cases(metadata_paths, case_filter=args.case)
    if args.write_report:
        write_report(result, args.out)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        s = result["summary"]
        print(
            f"{result['caseCount']} cases, {result['count']} stars, "
            f"RMS {s['rmsAngularErrorDeg']:.4f} deg, "
            f"max angular {s['maxAngularErrorDeg']:.4f} deg, "
            f"max |az| {s['maxAbsAzErrorDeg']:.4f} deg, "
            f"max |el| {s['maxAbsElErrorDeg']:.4f} deg, "
            f"RMS pixel {s['rmsPixelError']:.3f} px, "
            f"max pixel {s['maxPixelError']:.3f} px"
        )

    s = result["summary"]
    failed = (
        result["count"] < args.min_total_comparisons
        or s["maxAngularErrorDeg"] > args.max_angular_error_deg
        or s["maxAbsAzErrorDeg"] > args.max_az_error_deg
        or s["maxAbsElErrorDeg"] > args.max_el_error_deg
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
