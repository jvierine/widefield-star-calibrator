"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DisplayStretch = require("../js/display_stretch.js");

const appSource = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

function functionSource(name, nextName) {
    const start = appSource.indexOf(`function ${name}(`);
    const end = appSource.indexOf(`function ${nextName}(`, start + 1);
    assert.ok(start >= 0, `missing ${name}`);
    assert.ok(end > start, `missing function after ${name}`);
    return appSource.slice(start, end);
}

test("display clipping is limited to 0 through 50 percent", () => {
    assert.equal(DisplayStretch.clippedPercent(-3), 0);
    assert.equal(DisplayStretch.clippedPercent(5), 5);
    assert.equal(DisplayStretch.clippedPercent(80), 50);
    assert.equal(DisplayStretch.clippedPercent("not-a-number"), 5);
});

test("zero display clipping retains the full intensity range", () => {
    const values = Float32Array.from({length: 101}, (_, index) => index);
    const histogram = DisplayStretch.intensityHistogram({
        data: values,
        dataRange: {low: 0, high: 100},
    });
    const bounds = DisplayStretch.percentileBounds(histogram, 0);
    assert.equal(bounds.low, 0);
    assert.equal(bounds.high, 100);
    assert.equal(bounds.lowPercentile, 0);
    assert.equal(bounds.highPercentile, 100);
});

test("five percent display clipping removes 2.5 percent from each tail", () => {
    const values = Float32Array.from({length: 10001}, (_, index) => index);
    const histogram = DisplayStretch.intensityHistogram({
        data: values,
        dataRange: {low: 0, high: 10000},
    });
    const bounds = DisplayStretch.percentileBounds(histogram, 5);
    assert.equal(bounds.lowPercentile, 2.5);
    assert.equal(bounds.highPercentile, 97.5);
    assert.ok(Math.abs(bounds.low - 250) < 1);
    assert.ok(Math.abs(bounds.high - 9750) < 1);
});

test("fifty percent display clipping yields the interquartile range", () => {
    const values = Float32Array.from({length: 10001}, (_, index) => index);
    const histogram = DisplayStretch.intensityHistogram({
        data: values,
        dataRange: {low: 0, high: 10000},
    });
    const bounds = DisplayStretch.percentileBounds(histogram, 50);
    assert.ok(Math.abs(bounds.low - 2500) < 1);
    assert.ok(Math.abs(bounds.high - 7500) < 1);
});

test("high-pass display clipping is calculated from post-HPF float residuals", () => {
    const source = functionSource("displayImagePixels", "maskImageRegion");
    assert.match(source, /highPassFloatImageData\(unclippedDisplayImageData\(\), widthPx\)/);
    assert.match(source, /currentHighPassIntensityHistogram\(state\.highPassFloatPixels\)/);
    assert.match(source, /percentileBounds[\s\S]*currentHighPassIntensityHistogram/);
});

test("KDE centroiding uses original analysis pixels rather than display pixels", () => {
    const analysisSource = functionSource("analysisImagePixels", "setDefaultDisplayClipping");
    assert.match(analysisSource, /state\.imageFloatPixels \|\| state\.imagePixels/);
    assert.doesNotMatch(analysisSource, /displayImagePixels/);

    const graySource = functionSource("imageGrayAtIndex", "median");
    assert.match(graySource, /analysisImagePixels\(\)/);
    assert.doesNotMatch(graySource, /displayImagePixels/);

    const kdeSource = functionSource("kdeCentroid", "nearestProjectedStar");
    assert.match(kdeSource, /analysisImagePixels\(\)/);
    assert.match(kdeSource, /estimateCentroid\(clickX, clickY, imageGrayInterpolated/);
    assert.doesNotMatch(kdeSource, /displayImagePixels/);
});
