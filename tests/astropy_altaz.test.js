const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const exifr = require("exifr");

const runAstropyAltaz = process.env.AIDA_ASTROPY_TESTS === "1" || process.env.AIDA_FULL_TESTS === "1";

function loadAidaTools() {
    const source = fs.readFileSync(path.join(__dirname, "..", "js", "aidatools.js"), "utf8");
    const context = {
        window: {},
        ArrayBuffer,
        DataView,
        Math,
        Uint8Array,
        Date,
        Number,
        Array,
        console,
    };
    vm.createContext(context);
    vm.runInContext(source, context, {filename: "aidatools.js"});
    return context.window.AidaTools;
}

function wrapDeg(value) {
    return ((value + 180) % 360 + 360) % 360 - 180;
}

function angularSeparationDeg(aAzDeg, aElDeg, bAzDeg, bElDeg) {
    const dAz = wrapDeg(aAzDeg - bAzDeg);
    const dEl = aElDeg - bElDeg;
    return Math.hypot(dAz * Math.cos(bElDeg * Math.PI / 180), dEl);
}

function astropyAltAzReference(cases) {
    const python = process.env.PYTHON || "python3";
    const script = String.raw`
import json
import sys
import astropy.units as u
from astropy.coordinates import AltAz, EarthLocation, SkyCoord
from astropy.time import Time
from astropy.utils import iers

iers.conf.auto_download = False
iers.conf.auto_max_age = None

cases = json.load(sys.stdin)
out = []
for item in cases:
    location = EarthLocation(
        lat=float(item["latDeg"]) * u.deg,
        lon=float(item["lonDeg"]) * u.deg,
        height=float(item.get("altM", 0.0)) * u.m,
    )
    frame = AltAz(
        obstime=Time(item["timestampUtc"], scale="utc"),
        location=location,
        pressure=0 * u.hPa,
    )
    if abs(frame.pressure.to_value(u.hPa)) > 0.0:
        raise RuntimeError("Astropy pressure is not zero; refraction would be enabled")
    coord = SkyCoord(
        ra=float(item["raHours"]) * 15.0 * u.deg,
        dec=float(item["decDeg"]) * u.deg,
        frame="icrs",
    ).transform_to(frame)
    out.append({
        "id": item["id"],
        "azDeg": float(coord.az.deg),
        "elDeg": float(coord.alt.deg),
        "pressureHpa": float(frame.pressure.to_value(u.hPa)),
    })
print(json.dumps(out))
`;
    const result = childProcess.spawnSync(python, ["-c", script], {
        cwd: path.join(__dirname, ".."),
        encoding: "utf8",
        input: JSON.stringify(cases),
        timeout: 15000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || `Astropy exited ${result.status}`);
    return JSON.parse(result.stdout);
}

test("AIDA RA/Dec to az/el agrees directly with unrefracted Astropy AltAz", {skip: !runAstropyAltaz}, () => {
    const AidaTools = loadAidaTools();
    const cases = [
        {
            id: "kiruna betelgeuse",
            raHours: 5.9195278,
            decDeg: 7.4069444,
            timestampUtc: "2026-02-12T19:04:00.000Z",
            latDeg: 67.8558,
            lonDeg: 20.2253,
            altM: 425,
        },
        {
            id: "ramfjord capella",
            raHours: 5.2781556,
            decDeg: 45.9979917,
            timestampUtc: "2026-01-12T17:35:23.000Z",
            latDeg: 69.5860,
            lonDeg: 19.2247,
            altM: 0,
        },
        {
            id: "iphone sirius",
            raHours: 6.7524770,
            decDeg: -16.7161159,
            timestampUtc: "2024-12-18T21:28:18.000Z",
            latDeg: 69.5860,
            lonDeg: 19.2247,
            altM: 0,
        },
        {
            id: "equator high dec",
            raHours: 13.3987333,
            decDeg: 54.9253611,
            timestampUtc: "2025-06-01T00:00:00.000Z",
            latDeg: 0,
            lonDeg: 0,
            altM: 0,
        },
    ];
    const astropyRows = astropyAltAzReference(cases);
    const byId = new Map(astropyRows.map(row => [row.id, row]));

    for (const item of cases) {
        const astropy = byId.get(item.id);
        assert.equal(astropy.pressureHpa, 0);
        const aida = AidaTools.radecToAzZe(
            item.raHours,
            item.decDeg,
            new Date(item.timestampUtc),
            item.latDeg,
            item.lonDeg,
        );
        const aidaAzDeg = aida.az * AidaTools.RAD;
        const aidaElDeg = 90 - aida.ze * AidaTools.RAD;
        const dAzDeg = Math.abs(wrapDeg(aidaAzDeg - astropy.azDeg));
        const dElDeg = Math.abs(aidaElDeg - astropy.elDeg);
        const angularErrorDeg = angularSeparationDeg(aidaAzDeg, aidaElDeg, astropy.azDeg, astropy.elDeg);
        assert.ok(
            angularErrorDeg <= 0.02,
            `${item.id}: angular error ${angularErrorDeg} deg exceeds tolerance`,
        );
        assert.ok(dAzDeg <= 0.08, `${item.id}: azimuth error ${dAzDeg} deg exceeds tolerance`);
        assert.ok(dElDeg <= 0.02, `${item.id}: elevation error ${dElDeg} deg exceeds tolerance`);
    }
});

test("AIDA az/el coordinates agree with Astropy for saved star matches", { skip: !runAstropyAltaz }, async () => {
    const metadataPath = path.join(__dirname, "..", "test_cases", "IMG_9970", "metadata.json");
    const heicPath = path.join(__dirname, "..", "calibration_images", "IMG_9970.HEIC");
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const exif = await exifr.parse(heicPath, {
        tiff: true,
        exif: true,
        gps: true,
        mergeOutput: true,
    });
    assert.equal(new Date(exif.DateTimeOriginal).toISOString(), metadata.timestampUtc);
    assert.ok(Math.abs(Number(exif.latitude) - metadata.latDeg) < 2e-6);
    assert.ok(Math.abs(Number(exif.longitude) - metadata.lonDeg) < 2e-6);
    assert.ok(Math.abs(Number(exif.GPSAltitude) - metadata.altM) < 0.2);

    const python = process.env.PYTHON || "python3";
    const script = path.join(__dirname, "..", "tools", "astropy_altaz_report.py");
    const result = childProcess.spawnSync(
        python,
        [
            script,
            "--tracked",
            "--write-report",
            "--out",
            path.join(__dirname, "..", "test-report", "astropy-altaz"),
        ],
        {
            cwd: path.join(__dirname, ".."),
            encoding: "utf8",
            timeout: 15000,
        },
    );

    assert.equal(
        result.status,
        0,
        result.stderr || result.stdout || `Astropy cross-check exited ${result.status}`,
    );
    const summary = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "test-report", "astropy-altaz", "summary.json"), "utf8"),
    );
    assert.ok(summary.caseCount >= 10, `expected at least 10 comparable cases, got ${summary.caseCount}`);
    assert.ok(summary.count >= 100, `expected at least 100 star comparisons, got ${summary.count}`);
    assert.ok(summary.exposureDrift.length >= 5, "expected exposure drift rows in Astropy report");
    assert.ok(
        summary.exposureDrift.every(row => Number.isFinite(row.maxAzDriftDeg) && row.maxAzDriftDeg > 0),
        "expected finite positive azimuth drift estimates",
    );
    assert.equal(summary.astropyAltAz.atmosphericRefractionEnabled, false);
    assert.equal(summary.astropyAltAz.pressureHpa, 0);
    for (const caseSummary of summary.cases) {
        assert.equal(caseSummary.astropyAltAz.atmosphericRefractionEnabled, false);
        assert.equal(caseSummary.astropyAltAz.pressureHpa, 0);
    }
    assert.ok(
        summary.summary.pixelResidualCount >= 100,
        `expected at least 100 pixel residuals, got ${summary.summary.pixelResidualCount}`,
    );
    assert.ok(
        Number.isFinite(summary.summary.rmsPixelError),
        `expected finite RMS pixel error, got ${summary.summary.rmsPixelError}`,
    );
    assert.ok(
        summary.summary.maxAngularErrorDeg <= 0.02,
        `max angular error ${summary.summary.maxAngularErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(
        summary.summary.maxAbsAzErrorDeg <= 0.08,
        `max azimuth error ${summary.summary.maxAbsAzErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(
        summary.summary.maxAbsElErrorDeg <= 0.02,
        `max elevation error ${summary.summary.maxAbsElErrorDeg} deg exceeds tolerance`,
    );
});
