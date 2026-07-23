"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Miracle = require("../js/miracle_export.js");

function syntheticSamples({
    zenithRow = 331,
    zenithCol = 411,
    kPxPerDeg = 4.8,
    rotationRad = 0.42,
} = {}) {
    const samples = [];
    for (const zenithDeg of [10, 30, 55, 80]) {
        for (let azimuthDeg = 0; azimuthDeg < 360; azimuthDeg += 30) {
            const theta = azimuthDeg * Math.PI / 180;
            const distance = kPxPerDeg * zenithDeg;
            samples.push({
                rowPx: zenithRow - distance * Math.cos(theta + rotationRad),
                colPx: zenithCol - distance * Math.sin(theta + rotationRad),
                azimuthDeg,
                zenithDeg,
            });
        }
    }
    return samples;
}

test("MIRACLE fit preserves twisted X/Y axes, scale, and CCW-positive rotation", () => {
    const samples = syntheticSamples();
    const calibration = Miracle.fitCalibration(samples, {
        glatDeg: 69.1,
        glonDeg: 20.3,
    });
    assert.ok(Math.abs(calibration.xcPx - 331) < 1e-10, "Xc must be the 1-based image row");
    assert.ok(Math.abs(calibration.ycPx - 411) < 1e-10, "Yc must be the 1-based image column");
    assert.ok(Math.abs(calibration.kPxPerDeg - 4.8) < 1e-10);
    assert.ok(Math.abs(calibration.rotationRad - 0.42) < 1e-10);
});

test("a north vector rotated left in the image has positive MIRACLE rotAngle", () => {
    const calibration = Miracle.fitCalibration(syntheticSamples({rotationRad: Math.PI / 2}), {});
    assert.ok(Math.abs(calibration.rotationRad - Math.PI / 2) < 1e-10);
});

test("MIRACLE approximation exactly recovers synthetic equidistant samples", () => {
    const samples = syntheticSamples({rotationRad: -0.37});
    const calibration = Miracle.fitCalibration(samples, {});
    const errors = Miracle.approximationErrors(samples, calibration);
    assert.ok(Math.max(...errors.map(row => row.angularErrorDeg)) < 1e-6);
    assert.ok(Math.max(...errors.map(row => Math.abs(row.zenithErrorDeg))) < 1e-10);
});

test("MIRACLE pixel unit vectors follow the same sky convention as the approximation", () => {
    const samples = syntheticSamples({rotationRad: 0.31});
    const calibration = Miracle.fitCalibration(samples, {});
    for (const sample of samples.slice(0, 12)) {
        const sky = Miracle.approximateSkyAtPixel(sample.rowPx, sample.colPx, calibration);
        const vector = Miracle.approximateUnitVectorAtPixel(
            sample.rowPx,
            sample.colPx,
            calibration,
        );
        assert.ok(Math.abs(Miracle.wrapRadians(
            Math.atan2(vector.east, vector.north) - sky.azRad
        )) < 1e-10);
        assert.ok(Math.abs(Math.acos(vector.up) * 180 / Math.PI - sky.zenithDeg) < 1e-10);
        assert.ok(Math.abs(Math.hypot(vector.east, vector.north, vector.up) - 1) < 1e-10);
    }
});

test("MIRACLE file has a units/name comment and one ASCII row with six numeric values", () => {
    const text = Miracle.formatMiracleAscii({
        glatDeg: 69.1,
        glonDeg: 20.3,
        xcPx: 331,
        ycPx: 411,
        kPxPerDeg: 4.8,
        rotationRad: 0.42,
    });
    assert.match(text, /^(?:[\x20-\x7e]+\n){2}$/);
    const lines = text.trim().split("\n");
    assert.match(lines[0], /^% Glat\[deg\] Glon\[deg\]/);
    assert.match(lines[0], /Xc=zenithRow\[pixel,1-based\]/);
    assert.match(lines[0], /Yc=zenithCol\[pixel,1-based\]/);
    assert.match(lines[0], /k\[pixel\/degree\] rotAngle\[radian\]$/);
    assert.equal(lines[1].split(/\s+/).length, 6);
    assert.doesNotMatch(lines[1], /[{}\[\]",:]/);
    assert.deepEqual(lines[1].split(/\s+/).map(Number), [69.1, 20.3, 331, 411, 4.8, 0.42]);
});

test("image prefix removes only the final extension and unsafe path separators", () => {
    assert.equal(Miracle.imagePrefix("GHOST.2026-01-02.fits"), "GHOST.2026-01-02");
    assert.equal(Miracle.imagePrefix("station/night.png"), "station_night");
});

test("results download includes MIRACLE, compact HDF5, selected-star, and error products", () => {
    const root = path.join(__dirname, "..");
    const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
    const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(index, />Download results</);
    assert.match(index, /js\/miracle_export\.js/);
    assert.ok(app.includes("`${prefix}.miracle`"));
    assert.match(app, /selected_stars\.tsv/);
    assert.match(app, /_calibration\.h5/);
    assert.match(app, /miracle_parameters/);
    assert.match(app, /wisc_optpar_with_optmod/);
    assert.match(app, /selected_stars/);
    assert.match(app, /residuals_px/);
    assert.match(app, /selectedStarMiracleSamples/);
    assert.match(app, /miracleApproximationErrorPngBlob/);
    assert.match(app, /figures\/miracle_absolute_angular_error\.png/);
    assert.match(app, /512 \/ Math\.max\(sourceWidth, sourceHeight\)/);
    assert.match(app, /fraction of \[0, 0\.25, 0\.5, 0\.75, 1\]/);
    assert.doesNotMatch(app, /98th percentile sample color limit/);
    assert.doesNotMatch(app, /figures\/miracle_approximation_error\.svg/);
    const miracleSection = app.lastIndexOf("\\\\section{MIRACLE Approximation}");
    const endDocument = app.lastIndexOf("\\\\end{document}");
    assert.ok(miracleSection > app.lastIndexOf("\\\\section{How To Use The Lens Model}"));
    assert.ok(miracleSection < endDocument);
    assert.ok(app.indexOf("Warning---legacy camera support only", miracleSection) > miracleSection);
    assert.ok(app.indexOf("overlay\\\\_lens\\\\_model.py", miracleSection) > miracleSection);
    assert.ok(app.indexOf("\\\\_calibration.h5", miracleSection) > miracleSection);
    assert.ok(app.indexOf("\\\\begin{align}", miracleSection) > miracleSection);
    assert.ok(app.indexOf("Figure~\\\\ref{fig:miracle-error}", miracleSection) > miracleSection);
    assert.ok(app.indexOf("\\\\label{fig:miracle-error}", miracleSection) > miracleSection);
    assert.match(app, /index \+= 3/);
    assert.match(app, /formattedOptpar\.slice\(index, index \+ 3\)/);
    assert.match(app, /\\\\small[\s\S]*?\\\\begin{verbatim}[\s\S]*?\$\{optparText\}/);
});
