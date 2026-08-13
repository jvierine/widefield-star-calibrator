const test = require("node:test");
const assert = require("node:assert/strict");
const Zoom = require("../js/view_zoom.js");

test("image view zoom fits and centers the whole image at 1x", () => {
    const viewport = Zoom.imageViewport(1200, 800, 1000, 1000, 1);
    assert.equal(viewport.scale, 0.8);
    assert.equal(viewport.x, 200);
    assert.equal(viewport.y, 0);
    assert.equal(viewport.w, 800);
    assert.equal(viewport.h, 800);
});

test("image view zoom clamps panning so a zoomed image covers the viewer", () => {
    const viewport = Zoom.imageViewport(1000, 600, 1000, 600, 4, -1000, 9000);
    assert.equal(viewport.x, 0);
    assert.equal(viewport.y, -1800);
    assert.equal(viewport.x + viewport.w, 4000);
    assert.equal(viewport.y + viewport.h, 600);
});

test("pointer anchored zoom keeps the same image pixel under the pointer", () => {
    const current = Zoom.imageViewport(1000, 600, 1000, 600, 2, 500, 300);
    const pointer = {x: 180, y: 140};
    const image = {
        x: (pointer.x - current.x) / current.scale,
        y: (pointer.y - current.y) / current.scale,
    };
    const nextScale = current.scale * 2;
    const center = Zoom.centerForAnchor(
        pointer.x, pointer.y, image.x, image.y, nextScale, 1000, 600
    );
    const next = Zoom.imageViewport(1000, 600, 1000, 600, 4, center.centerX, center.centerY);
    assert.ok(Math.abs(next.x + image.x * next.scale - pointer.x) < 1e-9);
    assert.ok(Math.abs(next.y + image.y * next.scale - pointer.y) < 1e-9);
});

test("integer image coordinates map to pixel centers rather than pixel boundaries", () => {
    assert.equal(Zoom.canvasCoordinateForPixelCenter(0, 100, 12), 106);
    assert.equal(Zoom.canvasCoordinateForPixelCenter(7, 100, 12), 190);
    assert.equal(Zoom.pixelCenterForCanvasCoordinate(106, 100, 12), 0);
    assert.equal(Zoom.pixelCenterForCanvasCoordinate(190, 100, 12), 7);
});

test("picked-position dots turn on only above 10x zoom", () => {
    assert.equal(Zoom.automaticKdeDotsVisible(10), false);
    assert.equal(Zoom.automaticKdeDotsVisible(10.0001), true);
    assert.equal(Zoom.automaticKdeDotsVisible(16), true);
});
