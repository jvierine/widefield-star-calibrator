"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Miracle = require("../js/miracle_export.js");

function syntheticSamples({rawX = 410, rawY = 330, k = 280, rotationDeg = 32} = {}) {
    const rotationRad = rotationDeg * Math.PI / 180;
    const samples = [];
    for (const zenithDeg of [10, 30, 55, 80]) {
        for (let azDeg = 0; azDeg < 360; azDeg += 30) {
            const azRad = azDeg * Math.PI / 180;
            const zenithRad = zenithDeg * Math.PI / 180;
            const imageAz = azRad - rotationRad;
            const distance = k * zenithRad;
            samples.push({
                rawX: rawX + distance * Math.sin(imageAz),
                rawY: rawY - distance * Math.cos(imageAz),
                azRad,
                zenithRad,
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
        zenithRawX: 410,
        zenithRawY: 330,
    });
    assert.ok(Math.abs(calibration.xcPx - 330) < 1e-10, "Xc must be the vertical image row");
    assert.ok(Math.abs(calibration.ycPx - 410) < 1e-10, "Yc must be the horizontal image column");
    assert.ok(Math.abs(calibration.kPxPerRad - 280) < 1e-10);
    assert.ok(Math.abs(calibration.rotationDeg - 32) < 1e-10);
});

test("a north vector rotated left in the image has positive MIRACLE rotation", () => {
    const calibration = Miracle.fitCalibration([{
        rawX: 90,
        rawY: 100,
        azRad: 0,
        zenithRad: 0.5,
    }], {
        zenithRawX: 100,
        zenithRawY: 100,
    });
    assert.ok(Math.abs(calibration.rotationDeg - 90) < 1e-10);
});

test("MIRACLE approximation exactly recovers synthetic equidistant samples", () => {
    const samples = syntheticSamples({rotationDeg: -21});
    const calibration = Miracle.fitCalibration(samples, {
        zenithRawX: 410,
        zenithRawY: 330,
    });
    const errors = Miracle.approximationErrors(samples, calibration);
    assert.ok(Math.max(...errors.map(row => row.angularErrorDeg)) < 1e-6);
    assert.ok(Math.max(...errors.map(row => Math.abs(row.zenithErrorDeg))) < 1e-10);
});

test("MIRACLE file is one plain ASCII row with six numeric values", () => {
    const text = Miracle.formatMiracleAscii({
        glatDeg: 69.1,
        glonDeg: 20.3,
        xcPx: 330,
        ycPx: 410,
        kPxPerRad: 280,
        rotationDeg: 32,
    });
    assert.match(text, /^[\x20-\x7e]+\n$/);
    assert.equal(text.trim().split(/\s+/).length, 6);
    assert.doesNotMatch(text, /[{}\[\]",:]/);
    assert.deepEqual(text.trim().split(/\s+/).map(Number), [69.1, 20.3, 330, 410, 280, 32]);
});

test("image prefix removes only the final extension and unsafe path separators", () => {
    assert.equal(Miracle.imagePrefix("GHOST.2026-01-02.fits"), "GHOST.2026-01-02");
    assert.equal(Miracle.imagePrefix("station/night.png"), "station_night");
});

test("results download includes MIRACLE, selected-star, and approximation-error products", () => {
    const root = path.join(__dirname, "..");
    const app = fs.readFileSync(path.join(root, "js", "app.js"), "utf8");
    const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
    assert.match(index, />Download results</);
    assert.match(index, /js\/miracle_export\.js/);
    assert.ok(app.includes("`${prefix}.miracle`"));
    assert.match(app, /selected_stars\.tsv/);
    assert.match(app, /figures\/miracle_approximation_error\.png/);
    assert.match(app, /figures\/miracle_approximation_error\.svg/);
});
