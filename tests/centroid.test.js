const assert = require("node:assert/strict");
const test = require("node:test");

const AidaCentroid = require("../js/centroid.js");

function assertNear(actual, expected, tolerance, label) {
    assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: expected ${actual} to be within ${tolerance} of ${expected}`,
    );
}

function gaussianStar(cx, cy, sigma, amplitude = 1000, background = 20) {
    return (x, y) => {
        const dx = (x - cx) / sigma;
        const dy = (y - cy) / sigma;
        return background + amplitude * Math.exp(-0.5 * (dx * dx + dy * dy));
    };
}

test("density centroid recovers subpixel Gaussian star centers", () => {
    const cases = [
        {cx: 12.37, cy: 15.82, clickX: 12.0, clickY: 16.0, sigma: 1.2},
        {cx: 20.13, cy: 22.71, clickX: 21.0, clickY: 22.0, sigma: 1.2},
        {cx: 30.49, cy: 11.24, clickX: 29.0, clickY: 12.0, sigma: 1.8},
        {cx: 42.76, cy: 38.33, clickX: 44.0, clickY: 37.0, sigma: 2.2},
    ];

    for (const c of cases) {
        const result = AidaCentroid.estimateCentroid(
            c.clickX,
            c.clickY,
            gaussianStar(c.cx, c.cy, c.sigma),
        );
        assertNear(result.x, c.cx, 0.01, `x for ${c.cx},${c.cy}`);
        assertNear(result.y, c.cy, 0.01, `y for ${c.cx},${c.cy}`);
        assert.equal(result.method, "upsampled KDE");
    }
});

test("density centroid stores the unfiltered interpolated patch for display", () => {
    const cx = 17.35;
    const cy = 18.65;
    const sample = gaussianStar(cx, cy, 1.5, 700, 33);
    const result = AidaCentroid.estimateCentroid(17.0, 19.0, sample);
    const density = result.density;

    assert.equal(density.width, 17 * 40);
    assert.equal(density.height, 17 * 40);
    assert.equal(density.rawValues.length, density.width * density.height);
    assert.equal(density.values.length, density.width * density.height);

    const fineX = 123;
    const fineY = 234;
    const ix = density.originX + fineX / density.upsample;
    const iy = density.originY + fineY / density.upsample;
    const rawValue = density.rawValues[fineY * density.width + fineX];
    assertNear(rawValue, sample(ix, iy), 1e-4, "raw underlay sample");

    const smoothValue = density.values[fineY * density.width + fineX];
    assert.notEqual(smoothValue, rawValue);
});

test("fast density centroid remains fast enough for interactive picking", () => {
    const sample = gaussianStar(19.42, 21.73, 1.7, 900, 28);
    const start = performance.now();
    const runs = 8;
    for (let i = 0; i < runs; i++) {
        const result = AidaCentroid.estimateCentroid(20.0, 21.0, sample);
        assertNear(result.x, 19.42, 0.015, "interactive speed x");
        assertNear(result.y, 21.73, 0.015, "interactive speed y");
    }
    const elapsedMs = performance.now() - start;
    assert.ok(
        elapsedMs < 850,
        `expected ${runs} density estimates below 850 ms, got ${elapsedMs.toFixed(1)} ms`,
    );
});
