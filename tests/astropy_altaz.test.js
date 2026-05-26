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

function skySeparationDeg(aRaHours, aDecDeg, bRaHours, bDecDeg) {
    const dRaDeg = wrapDeg((aRaHours - bRaHours) * 15);
    const dDec = aDecDeg - bDecDeg;
    return Math.hypot(dRaDeg * Math.cos(bDecDeg * Math.PI / 180), dDec);
}

test("AIDA RA/Dec and az/el conversions agree with stored unrefracted Astropy AltAz truth table", () => {
    const AidaTools = loadAidaTools();
    const fixture = JSON.parse(
        fs.readFileSync(path.join(__dirname, "fixtures", "astropy_altaz_truth.json"), "utf8"),
    );
    assert.equal(fixture.astropy.pressureHpa, 0);
    assert.ok(fixture.cases.length >= 100, `expected a large Astropy fixture, got ${fixture.cases.length}`);

    let maxForwardAngularErrorDeg = 0;
    let maxForwardAzErrorDeg = 0;
    let maxForwardElErrorDeg = 0;
    let maxReverseAngularErrorDeg = 0;
    let maxReverseRaErrorDeg = 0;
    let maxReverseDecErrorDeg = 0;
    for (const item of fixture.cases) {
        const date = new Date(item.timestampUtc);
        const forward = AidaTools.radecToAzZe(
            item.forward.raHours,
            item.forward.decDeg,
            date,
            item.latDeg,
            item.lonDeg,
        );
        const forwardAzDeg = forward.az * AidaTools.RAD;
        const forwardElDeg = 90 - forward.ze * AidaTools.RAD;
        const forwardAzErrorDeg = Math.abs(wrapDeg(forwardAzDeg - item.forward.azDeg));
        const forwardElErrorDeg = Math.abs(forwardElDeg - item.forward.elDeg);
        const forwardAngularErrorDeg = angularSeparationDeg(
            forwardAzDeg,
            forwardElDeg,
            item.forward.azDeg,
            item.forward.elDeg,
        );
        maxForwardAngularErrorDeg = Math.max(maxForwardAngularErrorDeg, forwardAngularErrorDeg);
        maxForwardAzErrorDeg = Math.max(maxForwardAzErrorDeg, forwardAzErrorDeg);
        maxForwardElErrorDeg = Math.max(maxForwardElErrorDeg, forwardElErrorDeg);

        const reverse = AidaTools.azElToRaDec(
            item.reverse.azDeg,
            item.reverse.elDeg,
            date,
            item.latDeg,
            item.lonDeg,
        );
        const reverseRaErrorDeg = Math.abs(wrapDeg((reverse.raHours - item.reverse.raHours) * 15));
        const reverseDecErrorDeg = Math.abs(reverse.decDeg - item.reverse.decDeg);
        const reverseAngularErrorDeg = skySeparationDeg(
            reverse.raHours,
            reverse.decDeg,
            item.reverse.raHours,
            item.reverse.decDeg,
        );
        maxReverseAngularErrorDeg = Math.max(maxReverseAngularErrorDeg, reverseAngularErrorDeg);
        maxReverseRaErrorDeg = Math.max(maxReverseRaErrorDeg, reverseRaErrorDeg);
        maxReverseDecErrorDeg = Math.max(maxReverseDecErrorDeg, reverseDecErrorDeg);
    }

    assert.ok(
        maxForwardAngularErrorDeg <= 0.02,
        `max forward angular error ${maxForwardAngularErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(maxForwardAzErrorDeg <= 0.08, `max forward az error ${maxForwardAzErrorDeg} deg exceeds tolerance`);
    assert.ok(maxForwardElErrorDeg <= 0.02, `max forward el error ${maxForwardElErrorDeg} deg exceeds tolerance`);
    assert.ok(
        maxReverseAngularErrorDeg <= 0.02,
        `max reverse angular error ${maxReverseAngularErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(maxReverseRaErrorDeg <= 0.08, `max reverse RA error ${maxReverseRaErrorDeg} deg exceeds tolerance`);
    assert.ok(maxReverseDecErrorDeg <= 0.02, `max reverse Dec error ${maxReverseDecErrorDeg} deg exceeds tolerance`);
});

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

test("aidatools.js RA/Dec to az/el agrees with unrefracted Astropy for saved star matches", {
    skip: !runAstropyAltaz,
}, () => {
    const AidaTools = loadAidaTools();
    const listed = childProcess.spawnSync(
        "git",
        ["ls-files", "test_cases/*/metadata.json"],
        {cwd: path.join(__dirname, ".."), encoding: "utf8"},
    );
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);

    const cases = [];
    for (const relPath of listed.stdout.split(/\r?\n/).filter(Boolean)) {
        const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, "..", relPath), "utf8"));
        if (!metadata.timestampUtc || !Number.isFinite(Number(metadata.latDeg)) ||
                !Number.isFinite(Number(metadata.lonDeg))) {
            continue;
        }
        for (const [matchIndex, match] of (metadata.matches || []).entries()) {
            const star = match.catalog || {};
            if (!Number.isFinite(Number(star.raHours)) || !Number.isFinite(Number(star.decDeg))) {
                continue;
            }
            cases.push({
                id: `${metadata.id || path.basename(path.dirname(relPath))}:${matchIndex}`,
                raHours: Number(star.raHours),
                decDeg: Number(star.decDeg),
                timestampUtc: metadata.timestampUtc,
                latDeg: Number(metadata.latDeg),
                lonDeg: Number(metadata.lonDeg),
                altM: Number(metadata.altM) || 0,
            });
        }
    }
    assert.ok(cases.length >= 100, `expected at least 100 saved star matches, got ${cases.length}`);

    const astropyRows = astropyAltAzReference(cases);
    const astropyById = new Map(astropyRows.map(row => [row.id, row]));
    let sumAngularSquared = 0;
    let maxAngularErrorDeg = 0;
    let maxAbsAzErrorDeg = 0;
    let maxAbsElErrorDeg = 0;

    for (const item of cases) {
        const astropy = astropyById.get(item.id);
        assert.ok(astropy, `missing Astropy row for ${item.id}`);
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
        sumAngularSquared += angularErrorDeg * angularErrorDeg;
        maxAngularErrorDeg = Math.max(maxAngularErrorDeg, angularErrorDeg);
        maxAbsAzErrorDeg = Math.max(maxAbsAzErrorDeg, dAzDeg);
        maxAbsElErrorDeg = Math.max(maxAbsElErrorDeg, dElDeg);
    }

    const rmsAngularErrorDeg = Math.sqrt(sumAngularSquared / cases.length);
    assert.ok(
        rmsAngularErrorDeg <= 0.01,
        `RMS angular error ${rmsAngularErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(
        maxAngularErrorDeg <= 0.02,
        `max angular error ${maxAngularErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(
        maxAbsAzErrorDeg <= 0.08,
        `max azimuth error ${maxAbsAzErrorDeg} deg exceeds tolerance`,
    );
    assert.ok(
        maxAbsElErrorDeg <= 0.02,
        `max elevation error ${maxAbsElErrorDeg} deg exceeds tolerance`,
    );
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
    const exifTimeMs = new Date(exif.DateTimeOriginal).getTime();
    const metadataTimeMs = new Date(metadata.timestampUtc).getTime();
    assert.ok(
        Math.abs(exifTimeMs - metadataTimeMs) <= 3600_000,
        `EXIF timestamp ${new Date(exifTimeMs).toISOString()} differs from metadata ${metadata.timestampUtc}`,
    );
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
