const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const exifr = require("exifr");

test("AIDA az/el coordinates agree with Astropy for saved star matches", async () => {
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
    assert.ok(
        summary.summary.maxAngularErrorDeg <= 0.85,
        `max angular error ${summary.summary.maxAngularErrorDeg} deg exceeds tolerance`,
    );
});
