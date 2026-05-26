#!/usr/bin/env python3
"""Compare WISC/AIDA RA-Dec to az/el calculations with Astropy for IMG_9970.

The IMG_9970 test case contains a saved lens model and manually/automatically
paired catalogue stars.  The site and time metadata are taken as trusted EXIF
metadata from the original HEIC image.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import astropy.units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_METADATA = ROOT / "test_cases" / "IMG_9970" / "metadata.json"
DEFAULT_OUT_DIR = ROOT / "test-report" / "img9970-astropy-altaz"
MAX_ANGULAR_ERROR_DEG = 0.75
MAX_AZ_ERROR_DEG = 0.70
MAX_EL_ERROR_DEG = 0.20


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


def aida_radec_to_az_el(ra_hours: float, dec_deg: float, timestamp: str, lat_deg: float, lon_deg: float) -> tuple[float, float]:
    deg = math.pi / 180.0
    rsidtime = (gmst_degrees(timestamp) + lon_deg) * deg
    rra = ra_hours / 12.0 * math.pi
    rdecl = dec_deg * deg
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


def load_case(metadata_path: Path) -> dict:
    with metadata_path.open("r", encoding="utf8") as fh:
        return json.load(fh)


def compare(metadata: dict) -> dict:
    iers.conf.auto_download = False
    iers.conf.iers_degraded_accuracy = "warn"

    location = EarthLocation(
        lat=float(metadata["latDeg"]) * u.deg,
        lon=float(metadata["lonDeg"]) * u.deg,
        height=float(metadata.get("altM", 0.0)) * u.m,
    )
    frame = AltAz(
        obstime=Time(metadata["timestampUtc"], scale="utc"),
        location=location,
        pressure=0 * u.hPa,
    )

    rows = []
    for match in metadata.get("matches", []):
        star = match.get("catalog", {})
        if not {"raHours", "decDeg", "name"} <= set(star):
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
        rows.append(
            {
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
            }
        )

    def max_abs(key: str) -> float:
        return max((abs(row[key]) for row in rows), default=math.nan)

    angular_errors = sorted(row["angularErrorDeg"] for row in rows)
    rms = math.sqrt(sum(row["angularErrorDeg"] ** 2 for row in rows) / len(rows)) if rows else math.nan
    median = angular_errors[len(angular_errors) // 2] if angular_errors else math.nan
    return {
        "caseId": metadata.get("id", "IMG_9970"),
        "image": metadata.get("image", "IMG_9970.HEIC"),
        "timestampUtc": metadata["timestampUtc"],
        "latDeg": metadata["latDeg"],
        "lonDeg": metadata["lonDeg"],
        "altM": metadata.get("altM", 0.0),
        "count": len(rows),
        "rows": rows,
        "summary": {
            "rmsAngularErrorDeg": rms,
            "medianAngularErrorDeg": median,
            "maxAngularErrorDeg": max((row["angularErrorDeg"] for row in rows), default=math.nan),
            "maxAbsAzErrorDeg": max_abs("dAzDeg"),
            "maxAbsElErrorDeg": max_abs("dElDeg"),
        },
    }


def write_report(result: dict, out_dir: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    rows = result["rows"]

    fig, ax = plt.subplots(figsize=(6.4, 5.2), dpi=160)
    ax.axhline(0, color="0.78", linewidth=0.8)
    ax.axvline(0, color="0.78", linewidth=0.8)
    sc = ax.scatter(
        [row["dAzDeg"] for row in rows],
        [row["dElDeg"] for row in rows],
        c=[row["astropyElDeg"] for row in rows],
        s=24,
        cmap="viridis",
        edgecolors="black",
        linewidths=0.25,
    )
    ax.set_xlabel("AIDA - Astropy azimuth error (deg)")
    ax.set_ylabel("AIDA - Astropy elevation error (deg)")
    ax.set_title("IMG_9970 AIDA/Astropy AltAz residuals")
    ax.grid(True, alpha=0.25)
    cb = fig.colorbar(sc, ax=ax)
    cb.set_label("Astropy elevation (deg)")
    fig.tight_layout()
    scatter_name = "img9970_astropy_altaz_scatter.png"
    fig.savefig(out_dir / scatter_name)
    plt.close(fig)

    (out_dir / "summary.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    s = result["summary"]
    rows_html = "\n".join(
        "<tr>"
        f"<td>{row['name']}</td>"
        f"<td>{row['astropyAzDeg']:.3f}</td>"
        f"<td>{row['astropyElDeg']:.3f}</td>"
        f"<td>{row['dAzDeg']:.4f}</td>"
        f"<td>{row['dElDeg']:.4f}</td>"
        f"<td>{row['angularErrorDeg']:.4f}</td>"
        "</tr>"
        for row in sorted(rows, key=lambda item: item["angularErrorDeg"], reverse=True)[:20]
    )
    html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>IMG_9970 Astropy AltAz Cross-Check</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 2rem; line-height: 1.45; color: #172033; }}
code {{ background: #eef2f7; padding: 0.1rem 0.25rem; border-radius: 4px; }}
.metrics {{ display: grid; grid-template-columns: repeat(4, minmax(10rem, 1fr)); gap: 0.75rem; max-width: 72rem; }}
.metric {{ border: 1px solid #d6dde8; border-radius: 8px; padding: 0.8rem; background: #f8fafc; }}
.metric b {{ display: block; font-size: 1.45rem; }}
img {{ max-width: min(100%, 900px); border: 1px solid #d6dde8; border-radius: 8px; }}
table {{ border-collapse: collapse; margin-top: 1rem; }}
th, td {{ border-bottom: 1px solid #d6dde8; padding: 0.35rem 0.6rem; text-align: right; }}
th:first-child, td:first-child {{ text-align: left; }}
</style>
</head>
<body>
<h1>IMG_9970 Astropy AltAz Cross-Check</h1>
<p>This fast regression compares the <code>js/aidatools.js</code> RA/Dec to azimuth/elevation
calculation with Astropy for saved IMG_9970 catalogue star detections.  The site
and timestamp are treated as trusted EXIF-derived metadata from the original HEIC image.</p>
<p><b>Site/time:</b> {result['timestampUtc']}, lat {result['latDeg']:.6f} deg,
lon {result['lonDeg']:.6f} deg, alt {result['altM']:.1f} m.</p>
<div class="metrics">
<div class="metric"><span>Stars</span><b>{result['count']}</b></div>
<div class="metric"><span>RMS angular error</span><b>{s['rmsAngularErrorDeg']:.4f} deg</b></div>
<div class="metric"><span>Max angular error</span><b>{s['maxAngularErrorDeg']:.4f} deg</b></div>
<div class="metric"><span>Max |az| / |el|</span><b>{s['maxAbsAzErrorDeg']:.4f} / {s['maxAbsElErrorDeg']:.4f} deg</b></div>
</div>
<h2>Error Scatter</h2>
<img src="{scatter_name}" alt="AIDA minus Astropy azimuth/elevation scatter plot">
<h2>Largest Residuals</h2>
<table>
<thead><tr><th>Star</th><th>Astropy az</th><th>Astropy el</th><th>dAz</th><th>dEl</th><th>Angular</th></tr></thead>
<tbody>{rows_html}</tbody>
</table>
</body>
</html>
"""
    (out_dir / "index.html").write_text(html, encoding="utf8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metadata", type=Path, default=DEFAULT_METADATA)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--max-angular-error-deg", type=float, default=MAX_ANGULAR_ERROR_DEG)
    parser.add_argument("--max-az-error-deg", type=float, default=MAX_AZ_ERROR_DEG)
    parser.add_argument("--max-el-error-deg", type=float, default=MAX_EL_ERROR_DEG)
    args = parser.parse_args()

    result = compare(load_case(args.metadata))
    if args.write_report:
        write_report(result, args.out)
    if args.json:
        print(json.dumps(result, indent=2))
    else:
        s = result["summary"]
        print(
            f"{result['caseId']}: {result['count']} stars, "
            f"RMS {s['rmsAngularErrorDeg']:.4f} deg, "
            f"max angular {s['maxAngularErrorDeg']:.4f} deg, "
            f"max |az| {s['maxAbsAzErrorDeg']:.4f} deg, "
            f"max |el| {s['maxAbsElErrorDeg']:.4f} deg"
        )

    s = result["summary"]
    failed = (
        result["count"] < 20
        or s["maxAngularErrorDeg"] > args.max_angular_error_deg
        or s["maxAbsAzErrorDeg"] > args.max_az_error_deg
        or s["maxAbsElErrorDeg"] > args.max_el_error_deg
    )
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
