"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const AzElGrid = require("../js/az_el_grid.js");

test("az/el export grid has one more row and column than the image", () => {
    const spec = AzElGrid.cornerGridSpec(4032, 3024);
    assert.deepEqual(spec, {
        imageWidth: 4032,
        imageHeight: 3024,
        gridWidth: 4033,
        gridHeight: 3025,
        count: 4033 * 3025,
    });
});

test("az/el export coordinates span the outer pixel boundaries", () => {
    const width = 4032;
    const height = 3024;
    assert.equal(AzElGrid.rawPixelCorner(0), -0.5);
    assert.equal(AzElGrid.rawPixelCorner(width), width - 0.5);
    assert.equal(AzElGrid.rawPixelCorner(height), height - 0.5);
});
