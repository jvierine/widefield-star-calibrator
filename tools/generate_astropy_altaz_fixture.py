#!/usr/bin/env python3
"""Generate a deterministic Astropy truth table for fast RA/Dec <-> Alt/Az tests."""

from __future__ import annotations

import json
import math
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import astropy.units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "astropy_altaz_truth.json"
SEED = 20260526
COUNT = 128


def isoformat_z(date: datetime) -> str:
    return date.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def main() -> None:
    iers.conf.auto_download = False
    iers.conf.auto_max_age = None
    rng = random.Random(SEED)
    base = datetime(2024, 1, 1, tzinfo=timezone.utc)
    rows = []
    for index in range(COUNT):
        timestamp = base + timedelta(days=rng.uniform(0, 900), seconds=rng.uniform(0, 86400))
        lat = rng.uniform(-72.0, 72.0)
        lon = rng.uniform(-179.0, 179.0)
        alt_m = rng.uniform(0.0, 1200.0)
        location = EarthLocation(lat=lat * u.deg, lon=lon * u.deg, height=alt_m * u.m)
        frame = AltAz(
            obstime=Time(timestamp),
            location=location,
            pressure=0 * u.hPa,
        )

        ra_hours = rng.uniform(0.0, 24.0)
        dec_deg = math.degrees(math.asin(rng.uniform(-0.985, 0.985)))
        icrs = SkyCoord(ra=ra_hours * 15.0 * u.deg, dec=dec_deg * u.deg, frame="icrs")
        altaz = icrs.transform_to(frame)

        az_deg = rng.uniform(0.0, 360.0)
        el_deg = rng.uniform(-8.0, 88.0)
        reverse_icrs = SkyCoord(az=az_deg * u.deg, alt=el_deg * u.deg, frame=frame).icrs

        rows.append({
            "id": f"astropy-random-{index:03d}",
            "timestampUtc": isoformat_z(timestamp),
            "latDeg": lat,
            "lonDeg": lon,
            "altM": alt_m,
            "forward": {
                "raHours": ra_hours,
                "decDeg": dec_deg,
                "azDeg": float(altaz.az.deg),
                "elDeg": float(altaz.alt.deg),
            },
            "reverse": {
                "azDeg": az_deg,
                "elDeg": el_deg,
                "raHours": float(reverse_icrs.ra.hour),
                "decDeg": float(reverse_icrs.dec.deg),
            },
        })

    fixture = {
        "generator": "tools/generate_astropy_altaz_fixture.py",
        "astropy": {
            "frame": "AltAz",
            "inputFrame": "ICRS",
            "pressureHpa": 0.0,
            "refraction": "disabled",
        },
        "seed": SEED,
        "count": COUNT,
        "cases": rows,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf8")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
