#!/usr/bin/env python3
"""Offline report-only SEP comparison.

The browser GUI must not depend on Python or SEP. This helper is intentionally
used only by tools/star_detector_oracle_report.js for test report generation.
"""

import argparse
import json
import sys
import time

import numpy as np
from PIL import Image
import sep


def image_to_gray(filename):
    image = Image.open(filename).convert("RGB")
    rgb = np.asarray(image, dtype=np.float32)
    return 0.2126 * rgb[:, :, 0] + 0.7152 * rgb[:, :, 1] + 0.0722 * rgb[:, :, 2]


def finite_float(value, default=0.0):
    value = float(value)
    return value if np.isfinite(value) else default


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("image")
    parser.add_argument("--threshold", type=float, default=1.5)
    parser.add_argument("--max-detections", type=int, default=500)
    parser.add_argument("--min-area", type=int, default=1)
    parser.add_argument("--bw", type=int, default=64)
    parser.add_argument("--bh", type=int, default=64)
    parser.add_argument("--fw", type=int, default=3)
    parser.add_argument("--fh", type=int, default=3)
    parser.add_argument("--filter-type", choices=["conv", "matched"], default="matched")
    parser.add_argument("--deblend-cont", type=float, default=0.005)
    parser.add_argument("--sweep-json", default="")
    args = parser.parse_args()

    t0 = time.perf_counter()
    data = image_to_gray(args.image)
    data = np.ascontiguousarray(data.byteswap().newbyteorder() if data.dtype.byteorder == ">" else data)
    bkg = sep.Background(data, bw=args.bw, bh=args.bh, fw=args.fw, fh=args.fh)
    data_sub = data - bkg.back()
    rms = bkg.rms()

    if args.sweep_json:
        sweep_options = json.loads(args.sweep_json)
    else:
        sweep_options = [{
            "threshold": args.threshold,
            "maxDetections": args.max_detections,
            "minArea": args.min_area,
            "filterType": args.filter_type,
            "deblendCont": args.deblend_cont,
        }]

    results = []
    for option_index, option in enumerate(sweep_options):
        threshold = float(option.get("threshold", args.threshold))
        max_detections = int(option.get("maxDetections", args.max_detections))
        min_area = int(option.get("minArea", args.min_area))
        filter_type = option.get("filterType", args.filter_type)
        deblend_cont = float(option.get("deblendCont", args.deblend_cont))
        try:
            objects = sep.extract(
                data_sub,
                threshold,
                err=rms,
                minarea=min_area,
                filter_type=filter_type,
                deblend_cont=deblend_cont,
            )
        except Exception as exc:
            results.append({
                "status": (
                    f"Python SEP {sep.__version__}: failed; threshold {threshold}, "
                    f"filter {filter_type}, minarea {min_area}; {exc}"
                ),
                "detections": [],
                "objectCount": 0,
                "failed": True,
                "options": {
                    "threshold": threshold,
                    "maxDetections": max_detections,
                    "minArea": min_area,
                    "filterType": filter_type,
                    "deblendCont": deblend_cont,
                    "bw": args.bw,
                    "bh": args.bh,
                    "fw": args.fw,
                    "fh": args.fh,
                },
            })
            continue
        detections = []
        for index, obj in enumerate(objects):
            flux = finite_float(obj["flux"])
            peak = finite_float(obj["peak"])
            a = max(0.0, finite_float(obj["a"]))
            b = max(0.0, finite_float(obj["b"]))
            radius = float(np.sqrt(max(1e-6, a * b)))
            elongation = float(max(a, b) / max(1e-6, min(a, b))) if a > 0 and b > 0 else 1.0
            detections.append({
                "id": f"sep-{option_index}-{index}",
                "x": finite_float(obj["x"]),
                "y": finite_float(obj["y"]),
                "flux": flux,
                "peak": peak,
                "score": peak,
                "radius": radius,
                "elongation": elongation,
                "npix": int(obj["npix"]) if "npix" in objects.dtype.names else 0,
                "localSnr": peak,
                "globalSnr": peak,
            })
        detections.sort(key=lambda item: (item["peak"], item["flux"]), reverse=True)
        detections = detections[:max(0, max_detections)]
        results.append({
            "status": (
                f"Python SEP {sep.__version__}: {len(detections)} detections kept from "
                f"{len(objects)} objects; threshold {threshold}, filter {filter_type}, "
                f"minarea {min_area}; background global RMS {bkg.globalrms:.3f}"
            ),
            "detections": detections,
            "objectCount": int(len(objects)),
            "options": {
                "threshold": threshold,
                "maxDetections": max_detections,
                "minArea": min_area,
                "filterType": filter_type,
                "deblendCont": deblend_cont,
                "bw": args.bw,
                "bh": args.bh,
                "fw": args.fw,
                "fh": args.fh,
            },
        })

    elapsed_ms = int(round((time.perf_counter() - t0) * 1000.0))
    json.dump({
        "status": results[0]["status"] if results else "Python SEP produced no results",
        "elapsedMs": elapsed_ms,
        "detections": results[0]["detections"] if results else [],
        "sepVersion": sep.__version__,
        "backgroundGlobalRms": float(bkg.globalrms),
        "objectCount": results[0]["objectCount"] if results else 0,
        "options": vars(args),
        "results": results,
    }, sys.stdout)


if __name__ == "__main__":
    main()
